// Service worker: funciona sin conexión y recibe archivos desde "Compartir" en Android.
const VERSION = 'lector-md-v1.0.0';
const SHELL = [
  './', 'index.html', 'app.css', 'manifest.webmanifest',
  'js/main.js', 'js/db.js', 'js/render.js', 'js/tts.js', 'js/github.js', 'js/drive.js', 'js/files.js',
  'vendor/marked.js', 'vendor/purify.js', 'vendor/highlight.js', 'vendor/hl-light.css', 'vendor/hl-dark.css',
  'fonts/literata.woff2', 'fonts/literata-italic.woff2',
  'icons/icon-192.png', 'icons/icon-512.png',
];
const LAZY = ['vendor/mermaid.js'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // Mermaid se intenta guardar sin bloquear la instalación
    cache.addAll(LAZY).catch(() => {});
  })());
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Navegación: red primero para recibir actualizaciones, caché si no hay conexión
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => (await caches.match('index.html')) || Response.error()));
    return;
  }
  // Recursos propios: caché primero y se refresca en segundo plano
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(event.request, { ignoreSearch: true });
    const network = fetch(event.request).then(res => {
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await network) || Response.error();
  })());
});

/* ---- Recepción de archivos compartidos ---- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lector-md', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' }).createIndex('openedAt', 'openedAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function put(db, doc) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('docs', 'readwrite');
    t.objectStore('docs').put(doc);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

function titleFrom(content, fallback) {
  const m = content.match(/^#\s+(.+)$/m);
  return (m ? m[1].replace(/[*_`]/g, '').trim() : fallback).slice(0, 120);
}

async function receiveShare(request) {
  const base = new URL('./', self.registration.scope).href;
  try {
    const form = await request.formData();
    const db = await openDB();
    const now = Date.now();
    let firstId = null;
    const incoming = form.getAll('files').filter(f => f && typeof f !== 'string');
    for (const file of incoming) {
      const content = await file.text();
      const id = crypto.randomUUID();
      const name = file.name || 'compartido.md';
      await put(db, { id, key: null, source: 'shared', title: titleFrom(content, name.replace(/\.(md|markdown|txt)$/i, '')), content, meta: { name }, createdAt: now, updatedAt: now, openedAt: now, pos: 0, dirty: false });
      firstId = firstId || id;
    }
    // Texto compartido (sin archivo): se guarda como documento
    const text = form.get('text');
    if (!firstId && typeof text === 'string' && text.trim()) {
      const id = crypto.randomUUID();
      const title = (form.get('title') || '').toString().trim() || 'Texto compartido';
      await put(db, { id, key: null, source: 'shared', title: titleFrom(text, title), content: text, meta: { name: title + '.md' }, createdAt: now, updatedAt: now, openedAt: now, pos: 0, dirty: false });
      firstId = id;
    }
    if (!firstId) return Response.redirect(base + '?share-error=' + encodeURIComponent('no llegó ningún archivo'), 303);
    return Response.redirect(base + '?shared=' + encodeURIComponent(firstId), 303);
  } catch (err) {
    return Response.redirect(base + '?share-error=' + encodeURIComponent(err.message || 'error'), 303);
  }
}
