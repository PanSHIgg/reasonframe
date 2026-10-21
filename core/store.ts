import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { JobEvent, JobRecord } from '../shared/schema.js';
import { readJson, writeJson } from './files.js';
import { PipelineError } from './process.js';

export class JobStore extends EventEmitter {
  private records = new Map<string, JobRecord>();
  private writes = new Map<string, Promise<unknown>>();
  private lockToken = randomUUID();
  constructor(readonly root: string) { super(); }
  workspace(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new PipelineError('NOT_FOUND', 'Job not found');
    return path.join(this.root, id);
  }
  async open() {
    await fs.mkdir(this.root, { recursive: true });
    const lock = path.join(this.root, '.service.lock');
    let locked = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await fs.open(lock, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken })); await handle.close(); locked = true; break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const existing = await readJson<{ pid: number }>(lock);
        try { process.kill(existing.pid, 0); throw new PipelineError('STORE_LOCKED', 'Another ReasonFrame process owns this state directory'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        await fs.rm(lock);
      }
    }
    if (!locked) throw new PipelineError('STORE_LOCKED', 'Could not acquire state directory lock');
    for (const dir of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^[a-f0-9-]{36}$/.test(dir.name)) continue;
      let record: JobRecord;
      try { record = await readJson<JobRecord>(path.join(this.root, dir.name, 'job.json')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      const eventFile = path.join(this.root, dir.name, 'events.jsonl');
      try {
        const bytes = await fs.readFile(eventFile);
        if (bytes.length && bytes.at(-1) !== 10) await fs.truncate(eventFile, bytes.lastIndexOf(10) + 1);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; await fs.writeFile(eventFile, '', { mode: 0o600 }); }
      this.records.set(record.id, record);
      if (record.status === 'running') await this.update(record.id, { status: 'failed', stage: 'failed', error: { code: 'INTERRUPTED', message: 'Service stopped during this task; retry to continue from verified files' } }, 'interrupted');
    }
  }
  get(id: string) {
    const job = this.records.get(id); if (!job) throw new PipelineError('NOT_FOUND', 'Job not found');
    return structuredClone(job);
  }
  list(limit = 100) { return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(j => structuredClone(j)); }
  async create(record: JobRecord) {
    this.records.set(record.id, structuredClone(record));
    await writeJson(path.join(this.workspace(record.id), 'job.json'), record);
    return this.update(record.id, {}, 'created', { stage: 'queued' });
  }
  update(id: string, patch: Partial<JobRecord>, type?: string, data?: unknown): Promise<JobRecord> {
    const task = (this.writes.get(id) ?? Promise.resolve()).then(async () => {
      const current = this.get(id), next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      const event: JobEvent | undefined = type ? { id: ++next.eventSequence, jobId: id, time: next.updatedAt, type, data: data ?? { status: next.status, stage: next.stage } } : undefined;
      await writeJson(path.join(this.workspace(id), 'job.json'), next);
      if (event) await fs.appendFile(path.join(this.workspace(id), 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
      this.records.set(id, next);
      if (event) this.emit('jobEvent', event);
      return structuredClone(next);
    });
    this.writes.set(id, task.catch(() => {})); return task;
  }
  async events(id: string, after = 0): Promise<JobEvent[]> {
    this.get(id);
    const text = await fs.readFile(path.join(this.workspace(id), 'events.jsonl'), 'utf8');
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line) as JobEvent).filter(e => e.id > after);
  }
  async close() {
    await Promise.all(this.writes.values());
    const lock = path.join(this.root, '.service.lock');
    try { const value = await readJson<{ token: string }>(lock); if (value.token === this.lockToken) await fs.rm(lock); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}
