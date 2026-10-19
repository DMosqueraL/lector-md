// Integración con la API REST de GitHub.
const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function headers(token, accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function call(url, token, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...headers(token, init.accept), ...(init.headers || {}) } });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* sin cuerpo */ }
    if (res.status === 404) throw new GitHubError(404, token ? 'No se encontró el repositorio, la rama o el archivo. Revisa el nombre y que el token tenga acceso.' : 'No se encontró. Si el repositorio es privado, agrega un token en Ajustes.');
    if (res.status === 401) throw new GitHubError(401, 'El token de GitHub no es válido o expiró. Actualízalo en Ajustes.');
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000);
      throw new GitHubError(403, `Se agotó el límite de consultas a GitHub. Se renueva a las ${reset.toLocaleTimeString()}. Con un token el límite es mucho mayor.`);
    }
    if (res.status === 409) throw new GitHubError(409, 'El archivo cambió en GitHub desde que lo importaste. Vuelve a cargarlo desde el origen y repite tu edición.');
    throw new GitHubError(res.status, `GitHub respondió ${res.status}${msg ? ': ' + msg : ''}`);
  }
  return res;
}

export function parseRepo(input) {
  const s = input.trim().replace(/\.git$/, '');
  const m = s.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)(?:\/(?:tree|blob)\/([^/\s]+))?/i) || s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3] || '' };
}

export async function listMyRepos(token) {
  if (!token) return [];
  const res = await call(`${API}/user/repos?per_page=100&sort=updated`, token);
  return (await res.json()).map(r => r.full_name);
}

export async function listMarkdown({ owner, repo, branch }, token) {
  if (!branch) {
    const info = await (await call(`${API}/repos/${owner}/${repo}`, token)).json();
    branch = info.default_branch;
  }
  const tree = await (await call(`${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token)).json();
  const files = tree.tree
    .filter(t => t.type === 'blob' && /\.(md|markdown|mdx)$/i.test(t.path))
    .map(t => ({ path: t.path, sha: t.sha, size: t.size }))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  return { branch, files, truncated: !!tree.truncated };
}

export async function fetchFile({ owner, repo, branch, path }, token) {
  const url = `${API}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
  const res = await call(url, token, { accept: 'application/vnd.github.raw+json' });
  return res.text();
}

export async function fetchSha({ owner, repo, branch, path }, token) {
  const url = `${API}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
  const res = await call(url, token);
  return (await res.json()).sha;
}

function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function commitFile({ owner, repo, branch, path, sha }, content, message, token) {
  if (!token) throw new GitHubError(401, 'Para guardar en GitHub necesitas un token con permiso de escritura (Ajustes → GitHub).');
  const url = `${API}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const res = await call(url, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: toBase64Utf8(content), sha, branch }),
  });
  const json = await res.json();
  return { sha: json.content.sha, commitUrl: json.commit.html_url };
}

export function rawBaseUrl({ owner, repo, branch, path }) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${dir}`;
}

export function blobUrl({ owner, repo, branch, path }) {
  return `https://github.com/${owner}/${repo}/blob/${branch}/${path}`;
}
