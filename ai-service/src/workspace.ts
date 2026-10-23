import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { PipelineError } from '../core/process.js';

function segment(value: string, name: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) || value.includes('..')) throw new PipelineError('INVALID_IDENTIFIER', `Invalid ${name}: ${value}`);
  return value;
}

export class TaskWorkspace {
  readonly root: string;
  readonly jobId: string;
  readonly taskId: string;
  constructor(scratchDir: string, jobId: string, taskId: string) {
    this.jobId = segment(jobId, 'job_id');
    this.taskId = segment(taskId, 'task_id');
    this.root = path.join(scratchDir, this.jobId, this.taskId);
  }
  async open() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    return this;
  }
  resolve(relative: string) {
    const target = path.resolve(this.root, relative);
    const rel = path.relative(this.root, target);
    if (!rel || rel === '..' || rel.startsWith('../')) throw new PipelineError('INVALID_PATH', `Path escapes the task workspace: ${relative}`);
    return target;
  }
  async sizeBytes() {
    let total = 0;
    const walk = async (dir: string) => {
      let entries: Dirent[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) {
          try { total += (await fs.stat(file)).size; } catch { /* raced with cleanup */ }
        }
      }
    };
    await walk(this.root);
    return total;
  }
  async assertQuota(maxBytes: number) {
    const size = await this.sizeBytes();
    if (size > maxBytes) throw new PipelineError('SCRATCH_QUOTA_EXCEEDED', `Scratch directory uses ${size} bytes, exceeding MAX_SCRATCH_BYTES=${maxBytes}`);
    return size;
  }
  async cleanup(keep = false) {
    if (keep) return;
    await fs.rm(this.root, { recursive: true, force: true });
    try { await fs.rmdir(path.dirname(this.root)); } catch { /* other tasks may still exist */ }
  }
}
