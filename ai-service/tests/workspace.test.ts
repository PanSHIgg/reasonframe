import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeFile } from '../core/files.js';
import { setup } from './helpers.js';

test('workspace containment rejects traversal and symlinks escaping a job', async () => {
  const s = await setup();
  try {
    await assert.rejects(safeFile(s.temp, '../outside.env'), /escapes/);
    await fs.symlink('/etc', path.join(s.temp, 'outside'));
    await assert.rejects(safeFile(s.temp, 'outside/passwd'), /Symlink/);
  } finally { await s.cleanup(); }
});
