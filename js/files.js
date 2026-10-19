// Archivos del celular: File System Access cuando existe (permite guardar sobre el original),
// y <input type="file"> como respaldo.
export const fsaOpen = 'showOpenFilePicker' in window;
export const fsaDir = 'showDirectoryPicker' in window;
export const fsaSave = 'showSaveFilePicker' in window;

const MD_TYPES = [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown'], 'text/plain': ['.md', '.txt'] } }];
export const isMarkdownName = name => /\.(md|markdown|mdown|mkd|txt)$/i.test(name);

export async function pickFilesFSA() {
  const handles = await window.showOpenFilePicker({ multiple: true, types: MD_TYPES, excludeAcceptAllOption: false });
  const out = [];
  for (const h of handles) {
    const f = await h.getFile();
    out.push({ name: f.name, relPath: null, content: await f.text(), handle: h, lastModified: f.lastModified });
  }
  return out;
}

export async function pickDirFSA() {
  const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
  const out = [];
  async function walk(handle, prefix, depth) {
    if (depth > 6) return;
    for await (const entry of handle.values()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.kind === 'directory') await walk(entry, prefix + entry.name + '/', depth + 1);
      else if (isMarkdownName(entry.name)) {
        const f = await entry.getFile();
        out.push({ name: f.name, relPath: dir.name + '/' + prefix + f.name, content: await f.text(), handle: entry, lastModified: f.lastModified });
      }
    }
  }
  await walk(dir, '', 0);
  return out;
}

export async function readInputFiles(fileList) {
  const out = [];
  for (const f of fileList) {
    if (!isMarkdownName(f.name) && !/markdown|text\/plain/.test(f.type)) continue;
    out.push({ name: f.name, relPath: f.webkitRelativePath || null, content: await f.text(), handle: null, lastModified: f.lastModified });
  }
  return out;
}

export async function ensureWritable(handle) {
  if (!handle?.queryPermission) return false;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

export async function writeHandle(handle, content) {
  const w = await handle.createWritable();
  await w.write(content);
  await w.close();
}

export async function readHandle(handle) {
  if (handle.queryPermission && (await handle.queryPermission({ mode: 'read' })) !== 'granted') {
    if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') throw new Error('Sin permiso para leer el archivo.');
  }
  const f = await handle.getFile();
  return f.text();
}

// Guarda una copia: selector de guardado si existe, si no, descarga.
export async function exportCopy(name, content) {
  const filename = /\.(md|markdown)$/i.test(name) ? name : name + '.md';
  if (fsaSave) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: filename, types: MD_TYPES });
      await writeHandle(h, content);
      return 'saved';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
    }
  }
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return 'downloaded';
}
