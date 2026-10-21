import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { PROJECT_ROOT } from '../core/paths.js';
import { readJson } from '../core/files.js';
import { JobInputSchema, LessonSchema, type JobStatus } from '../shared/schema.js';
import type { JobManager } from '../core/jobs.js';

export const exampleRoot = path.join(PROJECT_ROOT, 'examples/solid-geometry');
export async function setup() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reasonframe-test-'));
  const config = await loadConfig({ env: { REASONFRAME_STATE_DIR: temp }, root: PROJECT_ROOT });
  return { temp, config, cleanup: () => fs.rm(temp, { recursive: true, force: true }) };
}
export const exampleLesson = async () => LessonSchema.parse(await readJson(path.join(exampleRoot, 'lesson.json')));
export const exampleInput = async () => JobInputSchema.parse(await readJson(path.join(exampleRoot, 'request.json')));
export async function waitStatus(manager: JobManager, id: string, statuses: JobStatus[], timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const job = manager.store.get(id);
    if (statuses.includes(job.status)) return job;
    if (job.status === 'failed') throw new Error(JSON.stringify(job.error));
    if (Date.now() > deadline) throw new Error(`Job remained ${job.status}/${job.stage}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
