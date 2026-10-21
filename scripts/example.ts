import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { JobManager } from '../core/jobs.js';
import { JobInputSchema } from '../shared/schema.js';
import { readJson, writeJson } from '../core/files.js';
import { PROJECT_ROOT } from '../core/paths.js';
import { exampleEngine } from './fixture.js';

const config = await loadConfig(), manager = new JobManager(config, { engine: await exampleEngine(config) });
const input = JobInputSchema.parse(await readJson(path.join(PROJECT_ROOT, 'examples/solid-geometry/request.json')));
input.images = [{ mimeType: 'image/png', base64: (await fs.readFile(path.join(PROJECT_ROOT, 'examples/solid-geometry/problem.png'))).toString('base64') }];
input.options.audio = 'provided';
const render = process.argv.includes('--render');
const jobFlag = process.argv.indexOf('--job');
const existingId = jobFlag >= 0 ? process.argv[jobFlag + 1] : undefined;
if (jobFlag >= 0 && (!existingId || !render)) throw new Error('--job requires a job id and --render');
console.log('Offline Pi SDK fixture: reuses a verified lesson and whole MP3; no live model or TTS API is called.');
await manager.open();
const onEvent = (e: any) => { if (['stage', 'completed', 'failed', 'awaiting_audio'].includes(e.type)) console.log(JSON.stringify(e)); };
manager.store.on('jobEvent', onEvent);
try {
  let job = existingId ? manager.store.get(existingId) : await manager.create(input);
  if (existingId && ['failed', 'cancelled'].includes(job.status)) job = await manager.retry(job.id);
  const waitFor = async (statuses: string[]) => {
    const deadline = Date.now() + config.agentTimeoutMs + config.renderTimeoutMs;
    while (true) {
      job = manager.store.get(job.id);
      if (statuses.includes(job.status)) return;
      if (job.status === 'failed' || job.status === 'cancelled') throw new Error(JSON.stringify(job.error || job.status));
      if (Date.now() > deadline) throw new Error('Example timed out');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  };
  await waitFor(['awaiting_audio', 'completed']);
  if (render && job.status !== 'completed') {
    await manager.provideAudio(job.id, { scriptSha256: job.scriptSha256!, audioBase64: (await fs.readFile(path.join(PROJECT_ROOT, 'examples/solid-geometry/narration.mp3'))).toString('base64'), words: await readJson(path.join(PROJECT_ROOT, 'examples/solid-geometry/words.json')) });
    await waitFor(['completed']);
  }
  const result = { id: job.id, status: job.status, mode: 'offline-fixture', workspace: manager.store.workspace(job.id), video: render ? path.join(manager.store.workspace(job.id), 'lesson.mp4') : null };
  await writeJson(path.join(PROJECT_ROOT, '.reasonframe/latest-example.json'), result); console.log(JSON.stringify(result, null, 2));
} finally { manager.store.off('jobEvent', onEvent); await manager.close(); }
