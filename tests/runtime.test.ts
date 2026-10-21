import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exampleEngine, plannedProvider } from '../scripts/fixture.js';
import { JobManager } from '../core/jobs.js';
import { prepareWorkspace } from '../core/compiler.js';
import { PiEngine } from '../core/pi.js';
import { safeFile } from '../core/files.js';
import { exampleInput, setup, waitStatus } from './helpers.js';

test('real Pi SDK performs file tools and an isolated read-only review before awaiting whole audio', async () => {
  const s = await setup(), manager = new JobManager(s.config, { engine: await exampleEngine(s.config) });
  try {
    await manager.open(); const job = await manager.create(await exampleInput());
    const ready = await waitStatus(manager, job.id, ['awaiting_audio']); assert(ready.scriptSha256); assert(ready.sourceSha256);
    const events = await manager.store.events(job.id);
    const tools = events.filter(e => e.type === 'agent.tool').map(e => e.data as { role: string; tool: string });
    assert(tools.some(e => e.role === 'author' && e.tool === 'write_file'));
    assert(tools.some(e => e.role === 'reviewer' && e.tool === 'submit_review'));
    assert(!tools.some(e => e.role === 'reviewer' && /write|edit/.test(e.tool)));
    const review = JSON.parse(await fs.readFile(path.join(manager.store.workspace(job.id), 'reports/review.json'), 'utf8')); assert.equal(review.mode, 'fixture');
    assert.equal(review.subject, 'math'); assert.match(review.promptSha256, /^[a-f0-9]{64}$/);
    assert(!ready.artifacts.some(a => a.name === 'video'));
  } finally { await manager.close(); await s.cleanup(); }
});
test('a rejected independent review blocks narration synthesis/render and exhausts bounded repairs', async () => {
  const s = await setup(), manager = new JobManager(s.config, { engine: await exampleEngine(s.config, { rejectReview: true }) });
  try {
    await manager.open(); const job = await manager.create(await exampleInput());
    const failed = await waitStatus(manager, job.id, ['failed']); assert.equal(failed.error?.code, 'QUALITY_GATE_FAILED');
    assert.equal(failed.scriptSha256, undefined); assert(!failed.artifacts.some(a => a.name === 'video'));
    const files = await fs.readdir(path.join(manager.store.workspace(job.id), 'reports')); assert(files.includes('review-3.json'));
  } finally { await manager.close(); await s.cleanup(); }
});
test('workspace containment rejects traversal and symlinks escaping a job', async () => {
  const s = await setup();
  try {
    await assert.rejects(safeFile(s.temp, '../outside.env'), /escapes/);
    await fs.symlink('/etc', path.join(s.temp, 'outside'));
    await assert.rejects(safeFile(s.temp, 'outside/passwd'), /Symlink/);
  } finally { await s.cleanup(); }
});
