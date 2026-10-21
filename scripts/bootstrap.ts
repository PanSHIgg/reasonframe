import { loadConfig } from '../core/config.js';
import { command } from '../core/process.js';
import { browserExecutable } from '../core/quality.js';

const config = await loadConfig();
const checks = await Promise.allSettled([
  command('ffmpeg', ['-version']), command('ffprobe', ['-version']), browserExecutable(config),
]);
const names = ['ffmpeg', 'ffprobe', 'browser'];
const report = { ok: Number(process.versions.node.split('.')[0]) >= 24 && checks.every(c => c.status === 'fulfilled'), node: process.version,
  modelConfigured: Boolean(config.llm), ttsConfigured: Boolean(config.tts),
  checks: checks.map((c, i) => ({ name: names[i], ok: c.status === 'fulfilled', ...(c.status === 'rejected' ? { error: c.reason.message } : i === 2 ? { path: c.value } : {}) })) };
console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
