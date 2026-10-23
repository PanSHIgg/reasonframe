import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
export class PipelineError extends Error { constructor(public code: string, message: string) { super(message); this.name = 'PipelineError'; } }
export function checkAbort(signal?: AbortSignal) { signal?.throwIfAborted(); }
export async function command(bin: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv; log?: string; maxOutput?: number; allowFailure?: boolean } = {}) {
  checkAbort(options.signal); const max = options.maxOutput ?? 2_000_000;
  return await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, env: options.env ?? process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure: Error | undefined; const chunks: Buffer[] = [];
    const stop = (error: Error) => {
      failure ??= error;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* exited */ }
      const hard = setTimeout(() => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* exited */ } }, 1500); hard.unref();
    };
    const onAbort = () => stop(new PipelineError('CANCELLED', 'Task cancelled'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop(new PipelineError('TIMEOUT', `${bin} exceeded its time limit`)), options.timeoutMs ?? 120000); timer.unref();
    child.stdout.on('data', (b: Buffer) => { stdout = (stdout + b.toString()).slice(-max); if (options.log) chunks.push(b); });
    child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-max); if (options.log) chunks.push(b); });
    child.once('error', e => { failure = e; });
    child.once('close', async code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      try {
        if (options.log) await fs.writeFile(options.log, Buffer.concat(chunks));
        if (failure) reject(failure);
        else if (code !== 0 && !options.allowFailure) reject(new PipelineError('COMMAND_FAILED', `${bin} exited ${code}: ${(stderr || stdout).slice(-5000)}`));
        else resolve({ stdout, stderr, code: code ?? 1 });
      } catch (e) { reject(e); }
    });
    if (options.signal?.aborted) onAbort();
  });
}
export async function probeAudio(file: string, signal?: AbortSignal) {
  const result = await command('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_name,codec_type', '-of', 'json', file], { signal });
  const value = JSON.parse(result.stdout), duration = Number(value.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 7200 || !value.streams?.some((s: any) => s.codec_type === 'audio' && s.codec_name === 'mp3')) throw new PipelineError('INVALID_AUDIO', 'Expected a complete MP3 narration, between 0 and 7200 seconds');
  await command('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { signal, timeoutMs: 120000 }); return duration;
}
