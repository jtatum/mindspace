import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSharedWriteStorage } from '../src/server/shared-storage.js';
import { writeSharedFile } from '../src/server/experiment-files.js';

test('shared storage counts cumulative bytes and entries, reserves disk space, and permits replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'mindspace-shared-quota-'));
  const freeBytes = 3 * 1024 ** 3;
  try {
    writeFileSync(join(root, 'one.md'), '12345');
    writeFileSync(join(root, 'two.md'), '67890');
    mkdirSync(join(root, 'papers')); writeFileSync(join(root, 'papers/0001.pdf'), 'Separate paper budget');
    assert.throws(() => checkSharedWriteStorage(root, join(root, 'three.md'), 1, { maxBytes: 10, freeBytes }), /storage limit/);
    assert.doesNotThrow(() => checkSharedWriteStorage(root, join(root, 'one.md'), 5, { maxBytes: 10, freeBytes }));
    assert.throws(() => checkSharedWriteStorage(root, join(root, 'new/nested/file.md'), 1, { maxEntries: 4, freeBytes }), /entry limit/);
    assert.throws(() => checkSharedWriteStorage(root, join(root, 'one.md'), 1, { freeBytes: 2 * 1024 ** 3 }), /free-space floor/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shared writes enforce the configured aggregate budget before creating files or directories', t => {
  const root = mkdtempSync(join(tmpdir(), 'mindspace-shared-write-quota-'));
  const previous = process.env.MINDSPACE_SHARED_MAX_BYTES;
  t.after(() => { if (previous === undefined) delete process.env.MINDSPACE_SHARED_MAX_BYTES; else process.env.MINDSPACE_SHARED_MAX_BYTES = previous; });
  process.env.MINDSPACE_SHARED_MAX_BYTES = '10';
  try {
    writeSharedFile(root, 'one.md', '12345', null);
    writeSharedFile(root, 'two.md', '67890', null);
    assert.throws(() => writeSharedFile(root, 'new/three.md', '1', null), /storage limit/);
    assert.equal(existsSync(join(root, 'new')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
