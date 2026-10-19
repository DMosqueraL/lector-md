// Integración con Google Drive mediante Google Identity Services (token en memoria).
const SCOPE = 'https://www.googleapis.com/auth/drive';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

let gisPromise;
let tokenClient;
let token = null; // { access_token, expiresAt }

function loadGis() {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve(window.google);
      s.onerror = () => { gisPromise = null; reject(new Error('No se pudo cargar el inicio de sesión de Google. Revisa tu conexión.')); };
      document.head.append(s);
    });
  }
  return gisPromise;
}

try {
  const saved = JSON.parse(sessionStorage.getItem('drive-token') || 'null');
  if (saved && saved.expiresAt > Date.now() + 60000) token = saved;
} catch { /* almacenamiento no disponible */ }

export function isSignedIn() { return !!token && token.expiresAt > Date.now() + 60000; }

export async function signIn(clientId, { prompt = '' } = {}) {
  if (!clientId) throw new Error('Configura el Client ID de Google en Ajustes para usar Drive.');
  if (isSignedIn()) return token.access_token;
  const google = await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: resp => {
        if (resp.error) return reject(new Error(resp.error_description || 'Google no autorizó el acceso a Drive.'));
        token = { access_token: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
        try { sessionStorage.setItem('drive-token', JSON.stringify(token)); } catch { /* sin almacenamiento */ }
        resolve(token.access_token);
      },
      error_callback: err => reject(new Error(err?.type === 'popup_closed' ? 'Cerraste la ventana de Google antes de autorizar.' : 'No se pudo abrir la ventana de Google. Permite las ventanas emergentes.')),
    });
    tokenClient.requestAccessToken({ prompt });
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token.access_token, () => {});
  token = null;
  try { sessionStorage.removeItem('drive-token'); } catch { /* sin almacenamiento */ }
}

async function call(url, clientId, init = {}) {
  const access = await signIn(clientId);
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${access}`, ...(init.headers || {}) } });
  if (res.status === 401) { signOut(); throw new Error('La sesión de Drive expiró. Vuelve a intentarlo para iniciar sesión.'); }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error?.message || ''; } catch { /* sin cuerpo */ }
    throw new Error(`Drive respondió ${res.status}${msg ? ': ' + msg : ''}`);
  }
  return res;
}

export async function listMarkdown(clientId, nameFilter = '') {
  const parts = ["trashed = false", "(name contains '.md' or name contains '.markdown' or mimeType = 'text/markdown' or mimeType = 'text/x-markdown')"];
  if (nameFilter.trim()) parts.push(`name contains '${nameFilter.trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
  const params = new URLSearchParams({
    q: parts.join(' and '),
    fields: 'files(id,name,modifiedTime,size,mimeType)',
    orderBy: 'modifiedTime desc',
    pageSize: '200',
    spaces: 'drive',
  });
  const res = await call(`${API}/files?${params}`, clientId);
  const { files } = await res.json();
  return files.filter(f => /\.(md|markdown)$/i.test(f.name) || /markdown/.test(f.mimeType));
}

export async function fetchFile(clientId, fileId) {
  const res = await call(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, clientId);
  return res.text();
}

export async function getMeta(clientId, fileId) {
  const res = await call(`${API}/files/${encodeURIComponent(fileId)}?fields=id,name,modifiedTime`, clientId);
  return res.json();
}

export async function updateFile(clientId, fileId, content) {
  const res = await call(`${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,modifiedTime`, clientId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'text/markdown; charset=UTF-8' },
    body: content,
  });
  return res.json();
}

export async function createFile(clientId, name, content) {
  const boundary = 'lector-md-' + Math.random().toString(36).slice(2);
  const meta = { name: /\.(md|markdown)$/i.test(name) ? name : name + '.md', mimeType: 'text/markdown' };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await call(`${UPLOAD}/files?uploadType=multipart&fields=id,name,modifiedTime`, clientId, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json();
}
