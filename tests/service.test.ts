import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { JobManager } from '../core/jobs.js';
import { JobStore } from '../core/store.js';
import { exampleEngine } from '../scripts/fixture.js';
import { PipelineError } from '../core/process.js';
import { readJson } from '../core/files.js';
import type { JobRecord } from '../shared/schema.js';
import { exampleInput, exampleRoot, setup, waitStatus } from './helpers.js';

test('HTTP jobs enforce auth, replay events, reject stale audio, cancel checks and withhold MP4 until validation', async () => {
  const s = await setup(); s.config.serviceApiKey = 'service-test-secret';
  let holdInspection = true, needsVisualRepair = false, finishVideo!: () => void;
  const validation = new Promise<void>(resolve => { finishVideo = resolve; });
  const manager = new JobManager(s.config, { engine: await exampleEngine(s.config), operations: {
    inspect: async (_c, _w, _t, signal) => {
      if (holdInspection) await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new PipelineError('CANCELLED', 'Cancelled during test inspection'));
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
      if (needsVisualRepair) { needsVisualRepair = false; throw new PipelineError('VISUAL_CHECK_FAILED', 'Intentional fixture defect: re-author and re-review once'); }
      return [];
    },
    hyperframes: async () => ({ ok: true }),
    render: async (_c, workspace) => { const file = path.join(workspace, 'pending.mp4'); await fs.writeFile(file, 'test transport bytes, not a real video'); return file; },
    video: async () => { await validation; return { passed: true } as any; },
  } });
  const server = createServer(createApp(manager));
  try {
    await manager.open();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const request = (url: string, data?: unknown, method = data === undefined ? 'GET' : 'POST') => fetch(origin + url, { method, headers: { authorization: 'Bearer service-test-secret', ...(data !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    assert.equal((await fetch(origin + '/health')).status, 200); assert.equal((await fetch(origin + '/v1/config')).status, 401);
    assert(!JSON.stringify(await (await request('/v1/config')).json()).includes('service-test-secret'));
    const spec = await (await request('/openapi.json')).json() as any;
    assert.equal(spec.openapi, '3.1.0'); assert(spec.paths['/v1/jobs/{id}/audio']); assert(spec.components.schemas.JobInput.properties.scope);
    assert.equal((await request('/v1/jobs', {})).status, 422);
    const created = await request('/v1/jobs', await exampleInput()); assert.equal(created.status, 202);
    const { id } = await created.json() as any, ready = await waitStatus(manager, id, ['awaiting_audio']);
    const narration = await (await request(`/v1/jobs/${id}/narration`)).json() as any; assert.equal(narration.scriptSha256, ready.scriptSha256);
    assert.equal((await request(`/v1/jobs/${id}/artifacts/video`)).status, 404);
    assert.equal((await request(`/v1/jobs/${id}/artifacts/.env`)).status, 404);
    const events = await manager.store.events(id), last = events.at(-1)!.id;
    const streamAbort = new AbortController();
    const response = await fetch(`${origin}/v1/jobs/${id}/events?after=${last - 1}`, { headers: { authorization: 'Bearer service-test-secret' }, signal: streamAbort.signal });
    const reader = response.body!.getReader(); let replay = '';
    while (!replay.includes('event: awaiting_audio')) { const chunk = await reader.read(); replay += new TextDecoder().decode(chunk.value); }
    assert(replay.includes(`id: ${last}`)); assert(!replay.includes('event: created'));
    await reader.cancel(); streamAbort.abort();
    const [audio, words] = await Promise.all([fs.readFile(path.join(exampleRoot, 'narration.mp3')), readJson(path.join(exampleRoot, 'words.json'))]);
    const payload = { scriptSha256: ready.scriptSha256, audioBase64: audio.toString('base64'), words };
    const rejected = await request(`/v1/jobs/${id}/audio`, { ...payload, scriptSha256: '0'.repeat(64) }); assert.equal(rejected.status, 422);
    assert.equal((await rejected.json() as any).error.code, 'STALE_AUDIO'); assert.equal(manager.store.get(id).status, 'awaiting_audio');
    const wrongWords: any = structuredClone(words); wrongWords.words[0].text = '错误词表';
    const mismatch = await request(`/v1/jobs/${id}/audio`, { ...payload, words: wrongWords });
    assert.equal(mismatch.status, 422); assert.equal((await mismatch.json() as any).error.code, 'AUDIO_REJECTED');
    assert.equal((await request(`/v1/jobs/${id}/audio`, payload)).status, 202);
    for (let i = 0; manager.store.get(id).stage !== 'checking' && i < 200; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(manager.store.get(id).stage, 'checking');
    assert.equal((await request(`/v1/jobs/${id}/cancel`, {}, 'POST')).status, 200);
    await new Promise(r => setTimeout(r, 50)); assert.equal(manager.store.get(id).status, 'cancelled');
    holdInspection = false; needsVisualRepair = true;
    const second = await (await request('/v1/jobs', await exampleInput())).json() as any;
    const secondReady = await waitStatus(manager, second.id, ['awaiting_audio']);
    await request(`/v1/jobs/${second.id}/audio`, { ...payload, scriptSha256: secondReady.scriptSha256 });
    for (let i = 0; manager.store.get(second.id).stage !== 'validating' && i < 200; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(manager.store.get(second.id).stage, 'validating'); assert.equal((await request(`/v1/jobs/${second.id}/artifacts/video`)).status, 404);
    finishVideo(); const completed = await waitStatus(manager, second.id, ['completed']);
    assert.equal(completed.autoRepairs, 1); assert((await manager.store.events(second.id)).some(e => e.type === 'repair.queued'));
    assert(completed.artifacts.some(a => a.name === 'video')); assert.equal((await request(`/v1/jobs/${second.id}/artifacts/video`)).status, 200);
    assert.equal((await request(`/v1/jobs/${second.id}/cancel`, {})).status, 409);
  } finally {
    finishVideo(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await manager.close(); await s.cleanup();
  }
});
test('durable store prevents multiple owners and marks interrupted work for explicit retry', async () => {
  const s = await setup(), store = new JobStore(s.temp), other = new JobStore(s.temp);
  try {
    await store.open(); await assert.rejects(other.open(), (e: any) => e.code === 'STORE_LOCKED');
    const input = await exampleInput(), now = new Date().toISOString(), id = randomUUID();
    const record: JobRecord = { id, status: 'running', stage: 'rendering', createdAt: now, updatedAt: now, input: { ...input, images: [] }, artifacts: [], eventSequence: 0, attempt: 1 };
    await store.create(record); await store.close();
    await fs.appendFile(path.join(s.temp, id, 'events.jsonl'), '{"id":999,"incomplete":');
    await other.open();
    assert.equal(other.get(id).status, 'failed'); assert.equal(other.get(id).error?.code, 'INTERRUPTED');
    assert((await other.events(id)).some(e => e.type === 'interrupted'));
  } finally { await store.close(); await other.close(); await s.cleanup(); }
});
