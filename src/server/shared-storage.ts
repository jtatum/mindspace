import { existsSync, lstatSync, readdirSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_SHARED_BYTES = 1024 ** 3;
const MAX_SHARED_ENTRIES = 10000;
const FREE_SPACE_FLOOR = 2 * 1024 ** 3;

export function checkExperimentStorage(directory: string, serializedBytes: number, freeBytes?: number) {
  // Reserve for database rows/indexes/WAL, initial messages and JSONL/CSV copies.
  // Check before the transaction writes anything; repeated admissions share the
  // same volume-wide floor as subsequent workspace and paper-cache writes.
  const allocationReserve = serializedBytes * 8 + 1024 ** 2;
  if (freeBytes === undefined) {
    const filesystem = statfsSync(directory);
    freeBytes = filesystem.bavail * filesystem.bsize;
  }
  if (freeBytes - allocationReserve < FREE_SPACE_FLOOR) throw new Error('Not enough disk space to create an experiment while preserving the 2 GiB free-space floor');
}

export function checkSharedWriteStorage(root: string, target: string, bytes: number, options: { maxBytes?: number; maxEntries?: number; freeBytes?: number } = {}) {
  const maxBytes = options.maxBytes ?? Number(process.env.MINDSPACE_SHARED_MAX_BYTES ?? DEFAULT_SHARED_BYTES);
  const maxEntries = options.maxEntries ?? MAX_SHARED_ENTRIES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('MINDSPACE_SHARED_MAX_BYTES must be a positive integer');
  let used = 0; let entries = 0;
  const pending = [resolve(root)];
  while (pending.length) {
    const directory = pending.pop()!;
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // Server-owned paper caches have a separate aggregate storage budget.
      if (directory === resolve(root) && entry.name.toLowerCase() === 'papers') continue;
      entries++;
      if (entries > maxEntries) throw new Error('Shared workspace entry limit reached');
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (!info.isDirectory()) used += info.size;
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path);
    }
  }
  // Account for directories created by this write, not just the file itself.
  let newEntries = 0; let ancestor = target;
  while (ancestor !== resolve(root) && !existsSync(ancestor)) {
    newEntries++; ancestor = dirname(ancestor);
  }
  if (entries + newEntries > maxEntries) throw new Error('Shared workspace entry limit reached');
  const previous = existsSync(target) ? lstatSync(target).size : 0;
  if (used - previous + bytes > maxBytes) throw new Error('Shared workspace storage limit reached; remove unused files or increase MINDSPACE_SHARED_MAX_BYTES');
  let free = options.freeBytes;
  if (free === undefined) {
    let existing = resolve(root);
    while (!existsSync(existing)) existing = dirname(existing);
    const filesystem = statfsSync(existing);
    free = filesystem.bavail * filesystem.bsize;
  }
  // Atomic replacement temporarily keeps both the old file and new contents.
  const allocationReserve = bytes + (newEntries + 1) * 65536;
  if (free - allocationReserve < FREE_SPACE_FLOOR) throw new Error('Shared write would breach the 2 GiB free-space floor');
}
