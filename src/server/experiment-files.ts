import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export function experimentDirectory(dataDir: string, sessionId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid experiment identifier');
  return resolve(dataDir, 'experiments', sessionId, 'shared');
}
const revision = (text: string) => createHash('sha256').update(text).digest('hex');
export function safePath(root: string, name: string) {
  if (!name || name.length > 300 || name.split(/[\\/]/).some(part => part.startsWith('.') || !part)) throw new Error('Use a relative path without hidden files or traversal');
  const target = resolve(root, name);
  if (!target.startsWith(resolve(root) + sep)) throw new Error('Path is outside the shared directory');
  // Reject links within the trusted experiment root (system ancestors such as
  // macOS /var may themselves be aliases).
  let current = target;
  while (current.startsWith(resolve(root) + sep) || current === resolve(root)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not allowed in shared file paths');
    current = dirname(current);
  }
  return target;
}
export function listSharedFiles(root: string, options: { path?: string; offset?: number } = {}) {
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid file-list offset');
  const files: Array<{ path: string; bytes: number }> = [];
  const walk = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name))) {
      if (files.length >= offset + 201) break;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), `${path}/`);
      else if (entry.isFile()) files.push({ path, bytes: statSync(join(directory, entry.name)).size });
    }
  };
  safePath(root, 'README.md');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = options.path ? safePath(root, options.path) : root;
  const prefix = options.path ? `${options.path}/` : '';
  const directories = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => prefix + entry.name).sort();
  walk(directory, prefix);
  const page = files.slice(offset, offset + 200);
  return { files: page, directories, limit: 200, hasMore: files.length > offset + 200, nextOffset: offset + page.length };
}
export function readSharedFile(root: string, name: string, offset = 0) {
  const path = safePath(root, name);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid text offset');
  if (statSync(path).size > 5_000_000) throw new Error('File exceeds the 5 MB read limit');
  const text = readFileSync(path, 'utf8');
  return { path: name, text: text.slice(offset, offset + 20000), nextOffset: Math.min(offset + 20000, text.length), hasMore: offset + 20000 < text.length, revision: revision(text) };
}
export function writeSharedFile(root: string, name: string, text: string, expectedRevision: string | null) {
  const path = safePath(root, name);
  if (['papers.jsonl', 'papers.csv'].includes(name) || name.startsWith('papers/')) throw new Error('Imported papers are read-only; write reviews and notes separately');
  if (Buffer.byteLength(text) > 200000) throw new Error('Write at most 200 KB per file');
  const current = existsSync(path) ? readSharedFile(root, name).revision : null;
  if (current !== expectedRevision) throw new Error('File changed or already exists. Read it and merge your changes before retrying.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // All application writes are synchronous and atomic, so compare/write cannot
  // interleave across agent callbacks in this single-owner local application.
  const temporary = safePath(root, `${name}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return { path: name, revision: revision(text), bytes: Buffer.byteLength(text) };
}
