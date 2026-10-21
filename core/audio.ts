import path from 'node:path';
import fs from 'node:fs/promises';
import type { Config } from './config.js';
import { AudioInputSchema, type AudioInput, type Lesson, type WordTable } from '../shared/schema.js';
import { align, narration } from './alignment.js';
import { atomicWrite, decodeBase64, readJson, sha256, writeJson } from './files.js';
import { checkAbort, command, PipelineError, probeAudio } from './process.js';
import { PROJECT_ROOT } from './paths.js';

export async function saveAudio(workspace: string, input: AudioInput, lesson: Lesson, signal: AbortSignal, source = 'external-import') {
  const scriptHash = sha256(narration(lesson));
  if (input.scriptSha256 !== scriptHash) throw new PipelineError('STALE_AUDIO', 'MP3/word table belong to a different narration; fetch the current narration and regenerate the whole audio');
  const bytes = decodeBase64(input.audioBase64, 44_000_000), pending = path.join(workspace, 'inputs/pending.mp3');
  await atomicWrite(pending, bytes);
  try {
    const duration = await probeAudio(pending, signal), timeline = align(lesson, input.words, duration, sha256(bytes), source);
    checkAbort(signal);
    await atomicWrite(path.join(workspace, 'render/assets/audio/narration.mp3'), bytes);
    await Promise.all([
      writeJson(path.join(workspace, 'words.json'), { ...input.words, scriptSha256: scriptHash }),
      writeJson(path.join(workspace, 'timeline.json'), timeline),
      writeJson(path.join(workspace, 'reports/alignment.json'), { passed: true, ...timeline.alignment, ...timeline.speech }),
    ]);
    return timeline;
  } finally { await fs.rm(pending, { force: true }); }
}
export async function synthesize(config: Config, workspace: string, lesson: Lesson, signal: AbortSignal, voice?: string) {
  if (!config.tts) throw new PipelineError('TTS_NOT_CONFIGURED', 'Configure TTS_PROVIDER=edge (with Python/edge-tts) or set TTS_PROVIDER=http with TTS_URL');
  if (config.tts.provider === 'edge') return synthesizeEdge(config, workspace, lesson, signal, voice);
  return synthesizeHttp(config, workspace, lesson, signal, voice);
}

async function synthesizeEdge(config: Config, workspace: string, lesson: Lesson, signal: AbortSignal, voiceOverride?: string) {
  const tts = config.tts!;
  const script = narration(lesson), scriptHash = sha256(script);
  let python = tts.python;
  try { await fs.access(python); } catch { python = 'python3'; }
  const cli = path.join(PROJECT_ROOT, 'scripts/edge-tts-cli.py');
  const base = path.join(workspace, '.reasonframe');
  await fs.mkdir(base, { recursive: true });
  await fs.mkdir(path.join(workspace, 'reports'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'tts-'));
  const request = path.join(dir, 'request.json'), audioFile = path.join(dir, 'narration.mp3'), wordsFile = path.join(dir, 'words.json');
  try {
    await writeJson(request, { text: script, scriptSha256: scriptHash, voice: voiceOverride || tts.voice, rate: '+0%', wordTimestamps: true });
    const result = await command(python, [cli, '--input', request, '--audio', audioFile, '--words', wordsFile], {
      signal, timeoutMs: 300000, maxOutput: 2_000_000, log: path.join(workspace, 'reports/tts.log'),
    });
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!line) throw new PipelineError('TTS_FAILED', 'Edge TTS returned no metadata');
    const meta = JSON.parse(line);
    if (meta.scriptSha256 && meta.scriptSha256 !== scriptHash) throw new PipelineError('STALE_AUDIO', 'TTS returned audio for a different narration');
    const audio = await fs.readFile(audioFile), words = await readJson(wordsFile);
    if (audio.length < 1500 || audio.length > 44_000_000) throw new PipelineError('TTS_RESPONSE_TOO_LARGE', 'Edge TTS returned an invalid MP3 size');
    const input = AudioInputSchema.parse({ scriptSha256: scriptHash, audioBase64: audio.toString('base64'), words });
    return saveAudio(workspace, input, lesson, signal, 'edge-tts');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function synthesizeHttp(config: Config, workspace: string, lesson: Lesson, signal: AbortSignal, voiceOverride?: string) {
  const tts = config.tts!;
  if (!tts.url) throw new PipelineError('TTS_NOT_CONFIGURED', 'TTS_URL is required for the HTTP provider');
  const script = narration(lesson), scriptHash = sha256(script);
  // One request for the complete script; no sentence split, concat or automatic retry.
  const response = await fetch(tts.url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
    headers: { 'content-type': 'application/json', ...(tts.apiKey ? { authorization: `Bearer ${tts.apiKey}` } : {}), 'idempotency-key': scriptHash },
    body: JSON.stringify({ text: script, scriptSha256: scriptHash, voice: voiceOverride || tts.voice, language: 'zh-CN', wordTimestamps: true }),
  });
  if (!response.ok) throw new PipelineError('TTS_FAILED', `Whole-script TTS returned HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > 64_000_000) throw new PipelineError('TTS_RESPONSE_TOO_LARGE', 'TTS response exceeds 64 MB');
  const reader = response.body!.getReader(), buffers: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 64_000_000) throw new PipelineError('TTS_RESPONSE_TOO_LARGE', 'TTS response exceeds 64 MB'); buffers.push(value); }
  } finally { await reader.cancel(); }
  const data = JSON.parse(Buffer.concat(buffers).toString('utf8'));
  if (data.scriptSha256 && data.scriptSha256 !== scriptHash) throw new PipelineError('STALE_AUDIO', 'TTS returned audio for a different narration');
  const input = AudioInputSchema.parse({ scriptSha256: scriptHash, audioBase64: data.audioBase64, words: data.words });
  return saveAudio(workspace, input, lesson, signal, 'http-tts');
}
