import { command } from '../core/process.js';
import { browserExecutable } from '../core/quality.js';
import type { AiConfig } from './config.js';
import type { ObjectStorage } from './storage.js';

export interface HealthSnapshot {
  ok: boolean;
  model_configured: boolean;
  tts_configured: boolean;
  ffmpeg_ready: boolean;
  chromium_ready: boolean;
  minio_ready: boolean;
  active_tasks: number;
  max_tasks: number;
  capabilities: string[];
}

export interface HealthOverrides {
  ffmpeg?: () => Promise<boolean>;
  chromium?: () => Promise<boolean>;
  storage?: () => Promise<boolean>;
}

async function executable(bin: string, args: string[]) {
  try { await command(bin, args, { timeoutMs: 2500, maxOutput: 8192 }); return true; }
  catch { return false; }
}

export class HealthChecker {
  private cached?: { at: number; value: Promise<Omit<HealthSnapshot, 'active_tasks' | 'max_tasks' | 'capabilities'>> };
  constructor(
    private readonly config: AiConfig,
    private readonly storage: ObjectStorage,
    private readonly overrides: HealthOverrides = {},
  ) {}
  private async probe() {
    const [ffmpeg, chromium, ready] = await Promise.all([
      this.overrides.ffmpeg?.() ?? executable('ffmpeg', ['-version']),
      this.overrides.chromium?.() ?? (async () => { try { await browserExecutable(this.config.core); return true; } catch { return false; } })(),
      this.overrides.storage?.() ?? this.storage.ready(),
    ]);
    return {
      ok: true,
      model_configured: Boolean(this.config.core.llm),
      tts_configured: Boolean(this.config.core.tts),
      ffmpeg_ready: ffmpeg,
      chromium_ready: chromium,
      minio_ready: ready,
    };
  }
  async check(activeTasks: number): Promise<HealthSnapshot> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at > 5000) this.cached = { at: now, value: this.probe() };
    const base = await this.cached.value;
    return {
      ...base,
      active_tasks: activeTasks,
      max_tasks: this.config.maxTasks,
      capabilities: [...this.config.capabilities],
    };
  }
}
