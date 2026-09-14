import { copyFile, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_SHARED_TEXT_BYTES } from './file-limits.js';
import { MAX_HOSTED_PDF_BYTES } from './pdf-extraction.js';

const DEFAULT_CACHE_BYTES = 20 * 1024 ** 3;
export const PAPER_FREE_SPACE_FLOOR = 2 * 1024 ** 3;

// Include text, metadata and abandoned temporary files in the corpus budget.
export async function paperStorageAllowance(directory: string, options: { quotaBytes?: number; freeBytes?: number } = {}): Promise<number> {
  const quota = options.quotaBytes ?? Number(process.env.MINDSPACE_PAPER_CACHE_MAX_BYTES ?? DEFAULT_CACHE_BYTES);
  if (!Number.isSafeInteger(quota) || quota <= 0) throw new Error('MINDSPACE_PAPER_CACHE_MAX_BYTES must be a positive integer');
  let used = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile()) used += (await stat(join(directory, entry.name))).size;
  }
  let free = options.freeBytes;
  if (free === undefined) {
    const filesystem = await statfs(directory);
    free = filesystem.bavail * filesystem.bsize;
  }
  // Leave room for this paper's extracted text and metadata as well as its PDF.
  const allowance = Math.floor(Math.min(quota - used, free - PAPER_FREE_SPACE_FLOOR) - MAX_SHARED_TEXT_BYTES - 65536);
  if (allowance <= 0) throw new Error('Paper cache storage limit reached; free disk space or increase MINDSPACE_PAPER_CACHE_MAX_BYTES');
  return allowance;
}

export async function copyPreparedPaper(source: string, destination: string, copy = copyFile): Promise<void> {
  const size = (await stat(source)).size;
  if (size > MAX_HOSTED_PDF_BYTES) throw new Error('Prepared paper exceeds the 150 MB size limit');
  if (size > await paperStorageAllowance(dirname(destination))) throw new Error('Prepared paper exceeds the remaining cache storage budget');
  const temporary = join(dirname(destination), `.copy-${randomUUID()}.part`);
  try {
    await copy(source, temporary);
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
