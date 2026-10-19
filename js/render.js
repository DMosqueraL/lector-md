// Markdown → HTML seguro, con resaltado de código, tareas, tablas desplazables y Mermaid.
let configured = false;
function setup() {
  if (configured) return;
  window.marked.setOptions({ gfm: true, breaks: false });
  configured = true;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function slugify(text) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'seccion';
}

/**
 * @param {string} source markdown
 * @param {{baseUrl?: string}} opts baseUrl para resolver imágenes relativas (GitHub raw)
 * @returns {DocumentFragment}
 */
export function renderMarkdown(source, opts = {}) {
  setup();
  let md = source.replace(/^﻿/, '');
  let front = null;
  const fm = md.match(FRONT_MATTER);
  if (fm) { front = fm[1]; md = md.slice(fm[0].length); }

  const raw = window.marked.parse(md);
  const clean = window.DOMPurify.sanitize(raw, { ADD_ATTR: ['checked'], FORBID_TAGS: ['style', 'form'] });
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  const root = tpl.content;

  if (front) {
    const pre = document.createElement('pre');
    pre.className = 'front-matter';
    pre.textContent = front;
    root.prepend(pre);
  }

  // Código y Mermaid
  root.querySelectorAll('pre > code').forEach(code => {
    const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1];
    if (lang === 'mermaid') {
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = code.textContent;
      code.parentElement.replaceWith(div);
      return;
    }
    if (window.hljs && code.textContent.length < 60000) {
      if (lang && !window.hljs.getLanguage(lang)) code.classList.add('nohighlight');
      else window.hljs.highlightElement(code);
    }
  });

  // Tablas desplazables en horizontal
  root.querySelectorAll('table').forEach(t => {
    const w = document.createElement('div');
    w.className = 'table-wrap';
    t.replaceWith(w);
    w.append(t);
  });

  // Encabezados con id único
  const used = new Map();
  root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
    const base = slugify(h.textContent);
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    h.id = n ? `${base}-${n}` : base;
  });

  // Tareas tocables
  let taskIndex = 0;
  root.querySelectorAll('li').forEach(li => {
    const first = li.firstElementChild?.tagName === 'P' ? li.firstElementChild.firstElementChild : li.firstElementChild;
    if (first && first.tagName === 'INPUT' && first.type === 'checkbox') {
      first.removeAttribute('disabled');
      first.dataset.task = String(taskIndex++);
      first.setAttribute('aria-label', 'Marcar tarea');
      li.classList.add('task');
      if (first.checked) li.classList.add('done');
    }
  });

  // Enlaces externos y recursos relativos
  root.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (/^https?:\/\//i.test(href)) { a.target = '_blank'; a.rel = 'noopener'; }
  });
  if (opts.baseUrl) {
    root.querySelectorAll('img[src]').forEach(img => {
      const src = img.getAttribute('src');
      if (!/^(https?:|data:|blob:)/i.test(src)) {
        try { img.src = new URL(src, opts.baseUrl).href; } catch { /* se ignora */ }
      }
    });
  }
  root.querySelectorAll('img').forEach(img => { img.loading = 'lazy'; img.decoding = 'async'; });
  return root;
}

// Mermaid se carga solo cuando un documento lo necesita (pesa ~5 MB).
let mermaidLoading;
function loadMermaid() {
  if (!mermaidLoading) {
    mermaidLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/mermaid.js';
      s.onload = () => resolve(window.mermaid);
      s.onerror = () => { mermaidLoading = null; reject(new Error('No se pudo cargar Mermaid')); };
      document.head.append(s);
    });
  }
  return mermaidLoading;
}

export async function renderDiagrams(container, dark) {
  const nodes = [...container.querySelectorAll('.mermaid:not([data-processed])')];
  if (!nodes.length) return;
  try {
    const mermaid = await loadMermaid();
    mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral', securityLevel: 'strict', fontFamily: 'system-ui, sans-serif' });
    for (const node of nodes) {
      const src = node.textContent;
      try {
        await mermaid.run({ nodes: [node] });
      } catch (err) {
        node.removeAttribute('data-processed');
        node.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'mermaid-error';
        p.textContent = 'Este diagrama tiene un error de sintaxis: ' + (err?.message || err).toString().split('\n')[0];
        const pre = document.createElement('pre');
        pre.textContent = src;
        node.append(p, pre);
      }
    }
  } catch (err) {
    nodes.forEach(n => { n.classList.add('mermaid-error'); });
  }
}

// Alterna la casilla n-ésima de tarea en el texto fuente.
export function toggleTaskInSource(source, index, checked) {
  const lines = source.split('\n');
  let n = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/);
    if (m && ++n === index) {
      lines[i] = m[1] + (checked ? 'x' : ' ') + m[3];
      return lines.join('\n');
    }
  }
  return source;
}

// Bloques que el lector en voz alta recorre, en orden.
export function collectBlocks(article, readCode) {
  const blocks = [];
  const add = el => { if (el.textContent.trim()) blocks.push(el); };
  const walk = parent => {
    for (const el of parent.children) {
      const tag = el.tagName;
      if (tag === 'UL' || tag === 'OL') { for (const li of el.children) add(li); }
      else if (tag === 'BLOCKQUOTE') walk(el);
      else if (tag === 'PRE') { if (readCode && !el.classList.contains('front-matter')) add(el); }
      else if (tag === 'HR' || el.classList.contains('mermaid')) continue;
      else add(el);
    }
  };
  walk(article);
  blocks.forEach((el, i) => { el.classList.add('tts-block'); el.dataset.ttsIndex = String(i); });
  return blocks;
}

export function blockText(el) {
  if (el.classList.contains('table-wrap')) {
    return [...el.querySelectorAll('tr')].map(tr => [...tr.cells].map(c => c.textContent.trim()).join(', ')).join('. ');
  }
  let t = (el.innerText || el.textContent).replace(/\s+\n/g, '\n').trim();
  if (/^H[1-6]$/.test(el.tagName)) t += '.';
  return t;
}
