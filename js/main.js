import * as db from './db.js';
import { renderMarkdown, renderDiagrams, toggleTaskInSource, collectBlocks } from './render.js';
import { Reader, ttsSupported, getVoices, sortVoices } from './tts.js';
import * as gh from './github.js';
import * as drive from './drive.js';
import * as files from './files.js';

const APP_VERSION = '1.0.0';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ---------- Ajustes ---------- */
const DEFAULTS = { theme: 'system', fontSize: 18, voiceURI: '', rate: 1, readCode: false, keepAwake: true, ghToken: '', driveClientId: '', tab: 'recent' };
const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('lector-md-settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
})();
function saveSettings() {
  try { localStorage.setItem('lector-md-settings', JSON.stringify(settings)); } catch { /* sin almacenamiento */ }
}

function isDark() {
  return settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}
function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'system') root.removeAttribute('data-theme'); else root.dataset.theme = settings.theme;
  const dark = isDark();
  $('#hlLight').disabled = dark;
  $('#hlDark').disabled = !dark;
  root.style.setProperty('--reader-size', settings.fontSize + 'px');
  $$('#themeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === settings.theme)));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); if (current && view === 'reader') rerender(); });

/* ---------- Utilidades de interfaz ---------- */
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function confirmBox(text, okLabel = 'Aceptar', danger = false) {
  const dlg = $('#dlgConfirm');
  $('#confirmText').textContent = text;
  const yes = $('#confirmYes');
  yes.textContent = okLabel;
  yes.classList.toggle('danger', danger);
  return new Promise(resolve => {
    const done = v => { dlg.close(); yes.onclick = null; $('#confirmNo').onclick = null; resolve(v); };
    yes.onclick = () => done(true);
    $('#confirmNo').onclick = () => done(false);
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
  });
}

function openSheet(dlg) {
  if (!dlg.open) dlg.showModal();
}
// Cerrar hojas tocando el fondo
$$('dialog.sheet').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function timeAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
  if (s < 60) return 'hace un momento';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 86400 * 30) return rtf.format(-Math.round(s / 86400), 'day');
  return new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}

const SOURCE = {
  local: { icon: 'i-phone', label: 'Celular' },
  github: { icon: 'i-github', label: 'GitHub' },
  drive: { icon: 'i-drive', label: 'Drive' },
  new: { icon: 'i-new', label: 'Escrito aquí' },
  shared: { icon: 'i-phone', label: 'Compartido' },
};

function folderOf(doc) {
  if (doc.source === 'github') {
    const dir = doc.meta.path.includes('/') ? doc.meta.path.slice(0, doc.meta.path.lastIndexOf('/')) : '';
    return { key: 'gh:' + doc.meta.repo, label: doc.meta.repo, icon: 'i-github', sub: dir };
  }
  if (doc.source === 'drive') return { key: 'drive', label: 'Google Drive', icon: 'i-drive', sub: '' };
  if (doc.source === 'local' && doc.meta?.relPath?.includes('/')) {
    const dir = doc.meta.relPath.slice(0, doc.meta.relPath.lastIndexOf('/'));
    return { key: 'dir:' + dir, label: dir, icon: 'i-folder', sub: '' };
  }
  if (doc.source === 'new') return { key: 'new', label: 'Escritos aquí', icon: 'i-new', sub: '' };
  if (doc.source === 'shared') return { key: 'shared', label: 'Compartidos con la app', icon: 'i-phone', sub: '' };
  return { key: 'local', label: 'Archivos del celular', icon: 'i-phone', sub: '' };
}

function titleFrom(content, fallback) {
  const m = content.match(/^#\s+(.+)$/m);
  return (m ? m[1].replace(/[*_`]/g, '').trim() : fallback).slice(0, 120);
}

/* ---------- Estado y rutas ---------- */
let view = 'library';
let current = null; // documento abierto
let blocks = [];
let listening = false;
let editorOriginal = '';

const reader = new Reader({ onChange: updatePlayer });
reader.onError = code => toast(code === 'not-allowed'
  ? 'Toca reproducir para empezar a leer.'
  : 'El motor de voz del celular falló. Revisa en Ajustes de Android → Salida de texto a voz que haya una voz instalada.', 6000);

function go(hash) {
  if (location.hash !== hash) location.hash = hash; else route();
}

async function route() {
  const h = location.hash || '#/';
  let m;
  if (view === 'editor' && $('#editor').value !== editorOriginal && !h.startsWith('#/edit/')) {
    const leave = await confirmBox('Tienes cambios sin guardar en el editor. ¿Salir y descartarlos?', 'Descartar', true);
    if (!leave) { history.pushState(null, '', '#/edit/' + current.id); return; }
    clearDraft(current.id);
  }
  if ((m = h.match(/^#\/doc\/(.+)$/))) return showReader(decodeURIComponent(m[1]));
  if ((m = h.match(/^#\/edit\/(.+)$/))) return showEditor(decodeURIComponent(m[1]));
  if (h === '#/ajustes') return showSettings();
  return showLibrary();
}
window.addEventListener('hashchange', route);

function setView(name, title) {
  view = name;
  $('#viewLibrary').hidden = name !== 'library';
  $('#viewReader').hidden = name !== 'reader';
  $('#viewEditor').hidden = name !== 'editor';
  $('#viewSettings').hidden = name !== 'settings';
  $('#barTitle').textContent = title;
  document.title = name === 'library' ? 'Lector MD' : `${title} · Lector MD`;
  $('#btnBack').hidden = name === 'library';
  $('#btnSettings').hidden = name !== 'library';
  $('#btnToc').hidden = name !== 'reader';
  $('#btnListen').hidden = name !== 'reader' || !ttsSupported;
  $('#btnEdit').hidden = name !== 'reader';
  $('#btnDocMenu').hidden = name !== 'reader';
  if (name !== 'reader') { stopListening(); }
  window.scrollTo(0, 0);
}

/* ---------- Biblioteca ---------- */
let allDocs = [];

async function showLibrary() {
  setView('library', 'Biblioteca');
  current = null;
  allDocs = await db.getAll();
  renderLibrary();
}

function renderLibrary() {
  const q = norm($('#search').value.trim());
  const list = $('#libList');
  $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === settings.tab)));
  $('#libEmpty').hidden = allDocs.length > 0;
  $('#fab').hidden = allDocs.length === 0;
  $('.tabs').hidden = allDocs.length === 0;
  $('.search').hidden = allDocs.length === 0;

  let docs = allDocs;
  const snippets = new Map();
  if (q) {
    docs = docs.filter(d => {
      if (norm(d.title).includes(q)) return true;
      const nc = norm(d.content);
      const i = nc.indexOf(q);
      if (i < 0) return false;
      const start = Math.max(0, i - 40);
      const plain = t => t.replace(/[#*_`>|]+/g, '').replace(/\s+/g, ' ');
      const pre = plain(d.content.slice(start, i)).trimStart();
      const hit = d.content.slice(i, i + q.length);
      const post = plain(d.content.slice(i + q.length, i + q.length + 60));
      snippets.set(d.id, (start > 0 ? '…' : '') + escapeHtml(pre) + '<mark>' + escapeHtml(hit) + '</mark>' + escapeHtml(post) + '…');
      return true;
    });
  }

  const item = d => {
    const src = SOURCE[d.source] || SOURCE.local;
    const f = folderOf(d);
    const where = settings.tab === 'folders' ? (f.sub || src.label) : (d.source === 'github' ? d.meta.repo : src.label);
    const when = timeAgo(Math.max(d.openedAt || 0, d.updatedAt || 0));
    return `<button class="doc-item" data-id="${escapeHtml(d.id)}">
      <span class="src"><svg><use href="#${src.icon}"/></svg></span>
      <span class="body">
        <span class="name">${escapeHtml(d.title)}${d.dirty ? '<span class="dirty-dot" title="Cambios sin subir"></span>' : ''}</span>
        <span class="sub">${escapeHtml(where)}${when ? ' · ' + when : ''}</span>
        ${snippets.has(d.id) ? `<span class="snippet">${snippets.get(d.id)}</span>` : ''}
      </span>
    </button>`;
  };

  if (q && !docs.length) {
    list.innerHTML = `<div class="empty"><p>Ningún documento contiene “${escapeHtml($('#search').value.trim())}”.</p></div>`;
    return;
  }

  if (settings.tab === 'recent' || q) {
    const sorted = [...docs].sort((a, b) => Math.max(b.openedAt || 0, b.updatedAt || 0) - Math.max(a.openedAt || 0, a.updatedAt || 0));
    list.innerHTML = sorted.map(item).join('');
  } else {
    const groups = new Map();
    for (const d of docs) {
      const f = folderOf(d);
      if (!groups.has(f.key)) groups.set(f.key, { ...f, docs: [] });
      groups.get(f.key).docs.push(d);
    }
    const ordered = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
    list.innerHTML = ordered.map(g => {
      g.docs.sort((a, b) => (folderOf(a).sub + a.title).localeCompare(folderOf(b).sub + b.title));
      return `<h2 class="group-title"><svg><use href="#${g.icon}"/></svg>${escapeHtml(g.label)} <span class="count">${g.docs.length}</span></h2>${g.docs.map(item).join('')}`;
    }).join('');
  }
}

$('#libList').addEventListener('click', e => {
  const b = e.target.closest('.doc-item');
  if (b) go('#/doc/' + encodeURIComponent(b.dataset.id));
});
let searchTimer;
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderLibrary, 120); });
$$('.tab').forEach(t => t.addEventListener('click', () => { settings.tab = t.dataset.tab; saveSettings(); renderLibrary(); }));

/* ---------- Lector ---------- */
async function showReader(id) {
  const doc = await db.getDoc(id);
  if (!doc) { toast('Ese documento ya no está en la biblioteca.'); return go('#/'); }
  current = doc;
  setView('reader', doc.title);
  doc.openedAt = Date.now();
  db.putDoc(doc);
  await rerender();
  const ratio = doc.pos?.scroll || 0;
  requestAnimationFrame(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    if (ratio > 0 && max > 0) window.scrollTo(0, ratio * max);
  });
}

function baseUrlFor(doc) {
  return doc.source === 'github' ? gh.rawBaseUrl(ghRef(doc)) : undefined;
}

function ghRef(doc) {
  const [owner, repo] = doc.meta.repo.split('/');
  return { owner, repo, branch: doc.meta.branch, path: doc.meta.path, sha: doc.meta.sha };
}

async function rerender() {
  const doc = current;
  const art = $('#doc');
  art.replaceChildren(renderMarkdown(doc.content, { baseUrl: baseUrlFor(doc) }));
  docLang = detectLang(doc.content);
  applyVoice();
  renderMeta();
  await renderDiagrams(art, isDark());
  blocks = collectBlocks(art, settings.readCode);
  reader.load(blocks, doc.pos?.block || 0);
  if (!listening) blocks.forEach(b => b.classList.remove('speaking'));
}

function renderMeta() {
  const doc = current;
  const src = SOURCE[doc.source] || SOURCE.local;
  let where = src.label;
  if (doc.source === 'github') where = `${doc.meta.repo} · ${doc.meta.path}`;
  else if (doc.meta?.relPath) where = doc.meta.relPath;
  const words = doc.content.split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 200));
  const meta = $('#docMeta');
  meta.innerHTML = `${escapeHtml(where)} · ${minutes} min de lectura`;
  if (doc.dirty) {
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.style.cssText = 'height:34px;margin:8px 0 0;display:flex';
    btn.textContent = doc.source === 'github' ? 'Subir cambios a GitHub' : doc.source === 'drive' ? 'Subir cambios a Drive' : 'Guardar en el archivo original';
    btn.addEventListener('click', async () => { btn.disabled = true; await syncToOrigin(current); renderMeta(); });
    meta.append(document.createElement('br'), btn);
  }
}

// Tareas, enlaces y "leer desde aquí"
$('#doc').addEventListener('click', async e => {
  const box = e.target.closest('input[data-task]');
  if (box) {
    const li = box.closest('li');
    li.classList.toggle('done', box.checked);
    current.content = toggleTaskInSource(current.content, Number(box.dataset.task), box.checked);
    await persistLocal(current, true);
    renderMeta();
    if (current.source === 'local' && current.meta?.handle) await syncToOrigin(current, { quiet: true });
    return;
  }
  const a = e.target.closest('a[href]');
  if (a) {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      e.preventDefault();
      const target = document.getElementById(decodeURIComponent(href.slice(1)));
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (!/^[a-z]+:/i.test(href) && /\.(md|markdown)(#.*)?$/i.test(href)) {
      e.preventDefault();
      openRelative(href);
    }
    return;
  }
  if (listening) {
    const blk = e.target.closest('.tts-block');
    if (blk) reader.play(Number(blk.dataset.ttsIndex));
  }
});

async function openRelative(href) {
  const clean = href.replace(/#.*$/, '');
  const docs = await db.getAll();
  if (current.source === 'github') {
    const base = 'https://x/' + current.meta.path;
    const path = decodeURIComponent(new URL(clean, base).pathname.slice(1));
    const found = docs.find(d => d.source === 'github' && d.meta.repo === current.meta.repo && d.meta.path === path);
    if (found) return go('#/doc/' + encodeURIComponent(found.id));
    try {
      toast('Abriendo ' + path + '…');
      const ref = { ...ghRef(current), path };
      const content = await gh.fetchFile(ref, settings.ghToken);
      const doc = await db.upsertBySource({ source: 'github', title: titleFrom(content, path.split('/').pop()), content, meta: { repo: current.meta.repo, branch: current.meta.branch, path, sha: await gh.fetchSha(ref, settings.ghToken) } });
      return go('#/doc/' + encodeURIComponent(doc.id));
    } catch (err) { return toast(err.message, 5000); }
  }
  const name = decodeURIComponent(clean.split('/').pop());
  const found = docs.find(d => (d.meta?.relPath || d.meta?.name || '').endsWith(name) || d.title === name);
  if (found) go('#/doc/' + encodeURIComponent(found.id));
  else toast(`“${name}” no está en tu biblioteca. Ábrelo primero.`);
}

let scrollTimer;
window.addEventListener('scroll', () => {
  $('#bar').classList.toggle('scrolled', window.scrollY > 4);
  if (view !== 'reader' || !current) return;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    current.pos = { ...(current.pos || {}), scroll: max > 0 ? window.scrollY / max : 0 };
    db.putDoc(current);
  }, 400);
}, { passive: true });

// Índice
$('#btnToc').addEventListener('click', () => {
  const hs = $$('#doc h1, #doc h2, #doc h3, #doc h4');
  $('#tocList').innerHTML = hs.length
    ? hs.map(h => `<a href="#${escapeHtml(h.id)}" class="l${h.tagName[1]}">${escapeHtml(h.textContent)}</a>`).join('')
    : '<p class="muted">Este documento no tiene títulos.</p>';
  openSheet($('#sheetToc'));
});
$('#tocList').addEventListener('click', e => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  $('#sheetToc').close();
  document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ---------- Voz ---------- */
function startListening() {
  if (!ttsSupported) return toast('Este navegador no tiene lectura en voz alta.');
  listening = true;
  document.body.classList.add('reading-mode');
  $('#player').hidden = false;
  $('#btnListen').classList.add('on');
  // Empieza en el primer bloque visible
  const top = blocks.findIndex(b => b.getBoundingClientRect().bottom > 80);
  const saved = current.pos?.block || 0;
  const start = blocks[saved] && Math.abs(blocks[saved].getBoundingClientRect().top) < innerHeight * 1.5 ? saved : Math.max(0, top);
  reader.play(start);
}

function stopListening() {
  if (!listening) return;
  listening = false;
  reader.stop();
  document.body.classList.remove('reading-mode');
  $('#player').hidden = true;
  $('#btnListen').classList.remove('on');
}

function updatePlayer(r) {
  if (!blocks.length) return;
  $('#pPlay').innerHTML = `<svg><use href="#${r.playing ? 'i-pause' : 'i-play'}"/></svg>`;
  $('#pPlay').setAttribute('aria-label', r.playing ? 'Pausar' : 'Reproducir');
  $('#playerPos').textContent = `Párrafo ${r.index + 1} de ${blocks.length}`;
  $('#playerBar').style.width = ((r.index + 1) / blocks.length * 100).toFixed(1) + '%';
  $('#rateChip').textContent = `${+r.rate.toFixed(2)}×`;
  if (current) { current.pos = { ...(current.pos || {}), block: r.index }; db.putDoc(current); }
}

$('#btnListen').addEventListener('click', () => listening ? stopListening() : startListening());
$('#pPlay').addEventListener('click', () => reader.toggle());
$('#pNext').addEventListener('click', () => reader.next());
$('#pPrev').addEventListener('click', () => reader.prev());
$('#pClose').addEventListener('click', stopListening);
const RATES = [0.8, 1, 1.2, 1.5, 1.75, 2];
$('#rateChip').addEventListener('click', () => {
  const i = RATES.findIndex(r => r >= reader.rate - 0.01);
  const next = RATES[(i + 1) % RATES.length];
  reader.setRate(next);
  settings.rate = next; saveSettings();
  $('#rate').value = next; $('#rateOut').textContent = next + '×';
  updatePlayer(reader);
});

// Voz automática: español o inglés según el idioma del documento abierto
let allVoices = [];
let docLang = 'es';
function detectLang(text) {
  const words = text.toLowerCase().match(/[a-záéíóúñ]+/g) || [];
  const es = new Set(['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'para', 'con', 'por', 'se', 'es', 'del', 'como', 'más']);
  const en = new Set(['the', 'and', 'of', 'to', 'is', 'in', 'that', 'for', 'with', 'it', 'on', 'are', 'this', 'be', 'as', 'you']);
  let a = 0, b = 0;
  for (const w of words.slice(0, 3000)) { if (es.has(w)) a++; else if (en.has(w)) b++; }
  return b > a * 1.3 ? 'en' : 'es';
}
function applyVoice() {
  const picked = allVoices.find(v => v.voiceURI === settings.voiceURI);
  reader.lang = docLang === 'en' ? 'en-US' : 'es-419';
  reader.setVoice(picked || allVoices.find(v => v.lang.startsWith(docLang)) || null);
}

async function setupVoices() {
  const sel = $('#voiceSel');
  if (!ttsSupported) { sel.innerHTML = '<option>No disponible en este navegador</option>'; sel.disabled = true; return; }
  const voices = sortVoices(await getVoices());
  allVoices = voices;
  sel.innerHTML = '<option value="">Automática (según el idioma del documento)</option>' + voices.map(v => `<option value="${escapeHtml(v.voiceURI)}">${escapeHtml(v.name)} — ${escapeHtml(v.lang)}</option>`).join('');
  sel.value = settings.voiceURI;
  applyVoice();
  sel.onchange = () => { settings.voiceURI = sel.value; saveSettings(); applyVoice(); };
}

/* ---------- Guardado ---------- */
async function persistLocal(doc, markDirty) {
  doc.updatedAt = Date.now();
  if (markDirty && ['github', 'drive'].includes(doc.source)) doc.dirty = true;
  if (markDirty && doc.source === 'local' && doc.meta?.handle) doc.dirty = true;
  await db.putDoc(doc);
}

async function syncToOrigin(doc, { quiet = false } = {}) {
  try {
    if (doc.source === 'github') {
      const ref = ghRef(doc);
      const { sha } = await gh.commitFile(ref, doc.content, `docs: actualiza ${doc.meta.path} desde Lector MD`, settings.ghToken);
      doc.meta.sha = sha;
      doc.dirty = false;
      await db.putDoc(doc);
      if (!quiet) toast('Commit creado en GitHub.');
    } else if (doc.source === 'drive') {
      await drive.updateFile(settings.driveClientId, doc.meta.fileId, doc.content);
      doc.dirty = false;
      await db.putDoc(doc);
      if (!quiet) toast('Guardado en Google Drive.');
    } else if (doc.source === 'local' && doc.meta?.handle) {
      if (!(await files.ensureWritable(doc.meta.handle))) throw new Error('Sin permiso para escribir en el archivo original. Quedó guardado en la biblioteca.');
      await files.writeHandle(doc.meta.handle, doc.content);
      doc.dirty = false;
      await db.putDoc(doc);
      if (!quiet) toast('Guardado en el archivo original.');
    } else if (!quiet) {
      toast('Guardado en la biblioteca. Para tenerlo como archivo usa “Guardar una copia .md”.', 4500);
    }
    return true;
  } catch (err) {
    toast(err.message, 6000);
    return false;
  }
}

/* ---------- Editor ---------- */
const draftKey = id => 'lector-md-draft:' + id;
function clearDraft(id) { try { localStorage.removeItem(draftKey(id)); } catch { /* sin almacenamiento */ } }

async function showEditor(id) {
  const doc = await db.getDoc(id);
  if (!doc) return go('#/');
  current = doc;
  setView('editor', doc.title);
  const ed = $('#editor');
  editorOriginal = doc.content;
  ed.value = doc.content;
  let draft = null;
  try { draft = localStorage.getItem(draftKey(id)); } catch { /* sin almacenamiento */ }
  if (draft && draft !== doc.content && await confirmBox('Hay un borrador sin guardar de la última vez. ¿Recuperarlo?', 'Recuperar')) ed.value = draft;
  else clearDraft(id);
  setPreview(false);
  updateEdStatus();
  const saveLabel = doc.source === 'github' ? 'Guardar y subir' : 'Guardar';
  $('#btnSave').lastChild.textContent = saveLabel;
}

function updateEdStatus() {
  const changed = $('#editor').value !== editorOriginal;
  $('#edStatus').textContent = changed ? 'Cambios sin guardar' : '';
}

let draftTimer;
$('#editor').addEventListener('input', () => {
  updateEdStatus();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { try { localStorage.setItem(draftKey(current.id), $('#editor').value); } catch { /* lleno */ } }, 600);
});

function setPreview(on) {
  $('#btnPreview').setAttribute('aria-pressed', String(on));
  $('#editor').hidden = on;
  $('#preview').hidden = !on;
  if (on) {
    $('#preview').replaceChildren(renderMarkdown($('#editor').value, { baseUrl: baseUrlFor(current) }));
    renderDiagrams($('#preview'), isDark());
  }
}
$('#btnPreview').addEventListener('click', () => setPreview($('#btnPreview').getAttribute('aria-pressed') !== 'true'));

$$('.ed-toolbar [data-md]').forEach(b => b.addEventListener('click', () => {
  const ed = $('#editor');
  if (ed.hidden) setPreview(false);
  const { selectionStart: s, selectionEnd: e, value } = ed;
  const sel = value.slice(s, e);
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  let insert, cursorFrom, cursorTo;
  const wrap = (l, r, ph) => { const t = sel || ph; insert = l + t + r; cursorFrom = s + l.length; cursorTo = cursorFrom + t.length; };
  switch (b.dataset.md) {
    case 'bold': wrap('**', '**', 'texto'); break;
    case 'italic': wrap('_', '_', 'texto'); break;
    case 'code': sel.includes('\n') ? wrap('```\n', '\n```', '') : wrap('`', '`', 'código'); break;
    case 'link': wrap('[', '](https://)', 'texto'); break;
    case 'h': case 'ul': case 'task': {
      const prefix = { h: '## ', ul: '- ', task: '- [ ] ' }[b.dataset.md];
      ed.setRangeText(prefix, lineStart, lineStart, 'end');
      ed.setSelectionRange(e + prefix.length, e + prefix.length);
      ed.focus(); ed.dispatchEvent(new Event('input'));
      return;
    }
  }
  ed.setRangeText(insert, s, e, 'end');
  ed.setSelectionRange(cursorFrom, cursorTo);
  ed.focus();
  ed.dispatchEvent(new Event('input'));
}));

$('#btnSave').addEventListener('click', async () => {
  const btn = $('#btnSave');
  btn.disabled = true;
  const content = $('#editor').value;
  const changed = content !== editorOriginal;
  current.content = content;
  if (['new', 'shared'].includes(current.source) || (current.source === 'local' && !current.meta?.relPath)) {
    current.title = titleFrom(content, current.title);
  }
  if (changed) {
    await persistLocal(current, true);
    await syncToOrigin(current);
  }
  clearDraft(current.id);
  editorOriginal = content;
  btn.disabled = false;
  go('#/doc/' + encodeURIComponent(current.id));
});

$('#btnCancelEdit').addEventListener('click', async () => {
  if ($('#editor').value !== editorOriginal && !(await confirmBox('¿Descartar los cambios?', 'Descartar', true))) return;
  $('#editor').value = editorOriginal;
  clearDraft(current.id);
  go('#/doc/' + encodeURIComponent(current.id));
});

/* ---------- Barra superior ---------- */
$('#btnBack').addEventListener('click', () => {
  if (view === 'editor') return $('#btnCancelEdit').click();
  go('#/');
});
$('#btnEdit').addEventListener('click', () => go('#/edit/' + encodeURIComponent(current.id)));
$('#btnSettings').addEventListener('click', () => go('#/ajustes'));
$('#btnDocMenu').addEventListener('click', () => {
  $('#sheetDocTitle').textContent = current.title;
  const canReload = current.source === 'github' || current.source === 'drive' || (current.source === 'local' && current.meta?.handle);
  $('[data-docact="reload"]').hidden = !canReload;
  $('#reloadHint').textContent = { github: 'Trae la última versión de GitHub', drive: 'Trae la última versión de Drive', local: 'Lee de nuevo el archivo del celular' }[current.source] || '';
  $('[data-docact="drivecopy"]').hidden = current.source === 'drive' || !settings.driveClientId;
  openSheet($('#sheetDoc'));
});

$('#sheetDoc').addEventListener('click', async e => {
  const b = e.target.closest('[data-docact]');
  if (!b) return;
  $('#sheetDoc').close();
  const doc = current;
  const act = b.dataset.docact;
  if (act === 'export') {
    const name = doc.meta?.name || doc.meta?.path?.split('/').pop() || doc.title;
    const r = await files.exportCopy(name, doc.content);
    if (r === 'saved') toast('Copia guardada.');
    else if (r === 'downloaded') toast('Copia descargada en Descargas.');
  } else if (act === 'delete') {
    if (await confirmBox(`¿Quitar “${doc.title}” de la biblioteca?${doc.dirty ? ' Tiene cambios sin subir que se perderán.' : ''}`, 'Quitar', true)) {
      await db.deleteDoc(doc.id);
      clearDraft(doc.id);
      toast('Documento quitado.');
      go('#/');
    }
  } else if (act === 'reload') {
    if (doc.dirty && !(await confirmBox('Tienes cambios sin subir. Si vuelves a cargar se reemplazan por la versión del origen.', 'Reemplazar', true))) return;
    try {
      if (doc.source === 'github') {
        const ref = ghRef(doc);
        doc.content = await gh.fetchFile(ref, settings.ghToken);
        doc.meta.sha = await gh.fetchSha(ref, settings.ghToken);
      } else if (doc.source === 'drive') {
        doc.content = await drive.fetchFile(settings.driveClientId, doc.meta.fileId);
      } else {
        doc.content = await files.readHandle(doc.meta.handle);
      }
      doc.dirty = false;
      doc.updatedAt = Date.now();
      await db.putDoc(doc);
      await rerender();
      toast('Actualizado.');
    } catch (err) { toast(err.message, 5000); }
  } else if (act === 'drivecopy') {
    try {
      const name = doc.meta?.name || doc.meta?.path?.split('/').pop() || doc.title;
      const f = await drive.createFile(settings.driveClientId, name, doc.content);
      toast(`Copia creada en Drive: ${f.name}`);
    } catch (err) { toast(err.message, 5000); }
  }
});

/* ---------- Abrir ---------- */
$$('[data-action="open-sheet"]').forEach(b => b.addEventListener('click', () => openSheet($('#sheetOpen'))));

$('#sheetOpen').addEventListener('click', async e => {
  const b = e.target.closest('[data-open]');
  if (!b) return;
  $('#sheetOpen').close();
  const kind = b.dataset.open;
  try {
    if (kind === 'file') {
      if (files.fsaOpen) await importLocal(await files.pickFilesFSA());
      else $('#filePick').click();
    } else if (kind === 'dir') {
      if (files.fsaDir) await importLocal(await files.pickDirFSA());
      else $('#dirPick').click();
    } else if (kind === 'github') openGithub();
    else if (kind === 'drive') openDrive();
    else if (kind === 'new') {
      const doc = await db.upsertBySource({ source: 'new', title: 'Documento nuevo', content: '# Documento nuevo\n\n', meta: {} });
      go('#/edit/' + encodeURIComponent(doc.id));
    }
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, 5000);
  }
});

$('#filePick').addEventListener('change', async e => { await importLocal(await files.readInputFiles(e.target.files)); e.target.value = ''; });
$('#dirPick').addEventListener('change', async e => { await importLocal(await files.readInputFiles(e.target.files)); e.target.value = ''; });

async function importLocal(list) {
  if (!list.length) return toast('No se encontraron archivos .md.');
  let last;
  for (const f of list) {
    last = await db.upsertBySource({
      source: 'local', title: titleFrom(f.content, f.name.replace(/\.(md|markdown|mdown|txt)$/i, '')), content: f.content,
      meta: { name: f.name, relPath: f.relPath, handle: f.handle || null },
    });
  }
  requestPersistence();
  if (list.length === 1) go('#/doc/' + encodeURIComponent(last.id));
  else { toast(`${list.length} documentos importados.`); settings.tab = 'folders'; saveSettings(); showLibrary(); }
}

function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}

/* ---------- GitHub ---------- */
let ghList = null;
async function openGithub() {
  openSheet($('#dlgGithub'));
  if (settings.ghToken && !$('#ghRepos').children.length) {
    gh.listMyRepos(settings.ghToken).then(names => {
      $('#ghRepos').innerHTML = names.map(n => `<option value="${escapeHtml(n)}">`).join('');
    }).catch(() => {});
  }
}

$('#ghForm').addEventListener('submit', async e => {
  e.preventDefault();
  const parsed = gh.parseRepo($('#ghRepo').value);
  if (!parsed) return ($('#ghStatus').textContent = 'Escribe el repositorio como usuario/repositorio o pega su URL.');
  if ($('#ghBranch').value.trim()) parsed.branch = $('#ghBranch').value.trim();
  $('#ghStatus').textContent = 'Buscando archivos .md…';
  $('#ghFiles').innerHTML = '';
  $('#ghFooter').hidden = true;
  try {
    const { branch, files: list, truncated } = await gh.listMarkdown(parsed, settings.ghToken);
    ghList = { ...parsed, branch, files: list };
    if (!list.length) { $('#ghStatus').textContent = `No hay archivos .md en la rama ${branch}.`; return; }
    $('#ghStatus').textContent = `${list.length} archivo${list.length > 1 ? 's' : ''} en ${parsed.owner}/${parsed.repo} (${branch})${truncated ? '. El repositorio es muy grande: la lista puede estar incompleta.' : ''}`;
    $('#ghFiles').innerHTML = list.map((f, i) => {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : 'raíz';
      return `<label><input type="checkbox" value="${i}" ${/^readme\.md$/i.test(f.path) ? 'checked' : ''}><span><span class="p-name">${escapeHtml(f.path.split('/').pop())}</span><span class="p-sub">${escapeHtml(dir)}</span></span></label>`;
    }).join('');
    $('#ghAll').checked = false;
    $('#ghFooter').hidden = false;
  } catch (err) {
    $('#ghStatus').textContent = err.message;
  }
});
$('#ghAll').addEventListener('change', e => $$('#ghFiles input').forEach(c => { c.checked = e.target.checked; }));
$('#ghImport').addEventListener('click', async () => {
  const picked = $$('#ghFiles input:checked').map(c => ghList.files[Number(c.value)]);
  if (!picked.length) return ($('#ghStatus').textContent = 'Marca al menos un archivo.');
  const btn = $('#ghImport');
  btn.disabled = true;
  let ok = 0, last;
  const repo = `${ghList.owner}/${ghList.repo}`;
  for (const f of picked) {
    $('#ghStatus').textContent = `Importando ${ok + 1} de ${picked.length}…`;
    try {
      const content = await gh.fetchFile({ ...ghList, path: f.path }, settings.ghToken);
      const fallback = /^readme\.md$/i.test(f.path.split('/').pop()) ? `README de ${ghList.repo}${f.path.includes('/') ? ' / ' + f.path.slice(0, f.path.lastIndexOf('/')) : ''}` : f.path.split('/').pop().replace(/\.(md|markdown|mdx)$/i, '');
      last = await db.upsertBySource({ source: 'github', title: titleFrom(content, fallback), content, meta: { repo, branch: ghList.branch, path: f.path, sha: f.sha } });
      ok++;
    } catch (err) {
      $('#ghStatus').textContent = err.message;
      if (err.status === 403 || err.status === 401) break;
    }
  }
  btn.disabled = false;
  if (!ok) return;
  requestPersistence();
  $('#dlgGithub').close();
  if (ok === 1) go('#/doc/' + encodeURIComponent(last.id));
  else { toast(`${ok} documentos importados de ${repo}.`); settings.tab = 'folders'; saveSettings(); showLibrary(); }
});

/* ---------- Drive ---------- */
let drList = [];
function openDrive() {
  if (!settings.driveClientId) {
    toast('Primero agrega el Client ID de Google en Ajustes.', 4500);
    return go('#/ajustes');
  }
  openSheet($('#dlgDrive'));
}
$('#drForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#drStatus').textContent = 'Buscando en Drive…';
  $('#drFiles').innerHTML = '';
  $('#drFooter').hidden = true;
  try {
    drList = await drive.listMarkdown(settings.driveClientId, $('#drQuery').value);
    if (!drList.length) { $('#drStatus').textContent = 'No se encontraron archivos .md.'; return; }
    $('#drStatus').textContent = `${drList.length} archivo${drList.length > 1 ? 's' : ''}`;
    $('#drFiles').innerHTML = drList.map((f, i) => `<label><input type="checkbox" value="${i}"><span><span class="p-name">${escapeHtml(f.name)}</span><span class="p-sub">Modificado ${escapeHtml(timeAgo(Date.parse(f.modifiedTime)))}</span></span></label>`).join('');
    $('#drAll').checked = false;
    $('#drFooter').hidden = false;
  } catch (err) {
    $('#drStatus').textContent = err.message;
  }
});
$('#drAll').addEventListener('change', e => $$('#drFiles input').forEach(c => { c.checked = e.target.checked; }));
$('#drImport').addEventListener('click', async () => {
  const picked = $$('#drFiles input:checked').map(c => drList[Number(c.value)]);
  if (!picked.length) return ($('#drStatus').textContent = 'Marca al menos un archivo.');
  const btn = $('#drImport');
  btn.disabled = true;
  let ok = 0, last;
  for (const f of picked) {
    $('#drStatus').textContent = `Importando ${ok + 1} de ${picked.length}…`;
    try {
      const content = await drive.fetchFile(settings.driveClientId, f.id);
      last = await db.upsertBySource({ source: 'drive', title: titleFrom(content, f.name.replace(/\.(md|markdown)$/i, '')), content, meta: { fileId: f.id, name: f.name } });
      ok++;
    } catch (err) { $('#drStatus').textContent = err.message; break; }
  }
  btn.disabled = false;
  if (!ok) return;
  requestPersistence();
  $('#dlgDrive').close();
  if (ok === 1) go('#/doc/' + encodeURIComponent(last.id));
  else { toast(`${ok} documentos importados de Drive.`); showLibrary(); }
});

/* ---------- Ajustes ---------- */
async function showSettings() {
  setView('settings', 'Ajustes');
  $('#fontSize').value = settings.fontSize; $('#fontSizeOut').textContent = settings.fontSize + ' px';
  $('#rate').value = settings.rate; $('#rateOut').textContent = settings.rate + '×';
  $('#readCode').checked = settings.readCode;
  $('#keepAwake').checked = settings.keepAwake;
  $('#ghToken').value = settings.ghToken;
  $('#driveClientId').value = settings.driveClientId;
  $('#btnDriveSignout').hidden = !drive.isSignedIn();
  $('#appVersion').textContent = APP_VERSION;
  const docs = await db.getAll();
  let info = `${docs.length} documento${docs.length === 1 ? '' : 's'} guardado${docs.length === 1 ? '' : 's'} en este celular`;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage) info += ` · ${(est.usage / 1048576).toFixed(1)} MB usados`;
  } catch { /* sin estimación */ }
  $('#storageInfo').textContent = info + '.';
}
$$('#themeSeg button').forEach(b => b.addEventListener('click', () => { settings.theme = b.dataset.theme; saveSettings(); applyTheme(); }));
$('#fontSize').addEventListener('input', e => { settings.fontSize = Number(e.target.value); $('#fontSizeOut').textContent = settings.fontSize + ' px'; saveSettings(); applyTheme(); });
$('#rate').addEventListener('input', e => { settings.rate = Number(e.target.value); $('#rateOut').textContent = settings.rate + '×'; saveSettings(); reader.setRate(settings.rate); });
$('#readCode').addEventListener('change', e => { settings.readCode = e.target.checked; saveSettings(); });
$('#keepAwake').addEventListener('change', e => { settings.keepAwake = e.target.checked; reader.keepAwake = e.target.checked; saveSettings(); });
$('#ghToken').addEventListener('change', e => { settings.ghToken = e.target.value.trim(); saveSettings(); $('#ghRepos').innerHTML = ''; });
$('#driveClientId').addEventListener('change', e => { settings.driveClientId = e.target.value.trim(); saveSettings(); });
$('#btnDriveSignout').addEventListener('click', () => { drive.signOut(); $('#btnDriveSignout').hidden = true; toast('Sesión de Drive cerrada.'); });
$('#btnClearLib').addEventListener('click', async () => {
  if (!(await confirmBox('¿Vaciar toda la biblioteca? Se borran las copias guardadas en la app; los archivos originales no se tocan.', 'Vaciar', true))) return;
  await db.clearDocs();
  toast('Biblioteca vacía.');
  showSettings();
});

/* ---------- Archivos recibidos de otras apps ---------- */
async function handleIncoming() {
  const params = new URLSearchParams(location.search);
  const shared = params.get('shared');
  const err = params.get('share-error');
  if (shared || err) history.replaceState(null, '', location.pathname + (shared ? '#/doc/' + encodeURIComponent(shared) : '#/'));
  if (err) toast('No se pudo recibir el archivo compartido: ' + err, 5000);
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async params => {
      if (!params.files?.length) return;
      const list = [];
      for (const h of params.files) {
        const f = await h.getFile();
        list.push({ name: f.name, relPath: null, content: await f.text(), handle: h });
      }
      importLocal(list);
    });
  }
}

/* ---------- Service worker ---------- */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Hay una versión nueva. Cierra y vuelve a abrir la app para usarla.', 6000);
      });
    });
  }).catch(() => {});
}

/* ---------- Inicio ---------- */
async function init() {
  applyTheme();
  reader.rate = settings.rate;
  reader.keepAwake = settings.keepAwake;
  // Las librerías se cargan con defer; esperar a que existan.
  if (!window.marked || !window.DOMPurify) await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
  await handleIncoming();
  setupVoices();
  route();
  registerSW();
}
init();
