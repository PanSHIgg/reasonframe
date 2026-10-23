import fs from 'node:fs/promises';
import { WordTableSchema } from '../../shared/schema.js';
import { saveAudio } from '../../core/audio.js';
import { narrationLesson } from '../../core/answer.js';
import { readJson, sha256 } from '../../core/files.js';
import { PipelineError } from '../../core/process.js';
import type { PhaseResult } from '../types.js';
import { clearDownstream, setPhaseStatus } from '../checkpoint.js';
import type { BinaryRef } from '../types.js';
import {
  initWorkspace, localPathFor, persistCheckpoint, resolveBinary, restoreApprovedAnswer, resultFor,
  timelineDigest, uploadWorkspaceFile, type TaskContext,
} from './shared.js';

async function resolveWords(ctx: TaskContext) {
  const words = ctx.request.spec.words;
  if (!words) throw new PipelineError('WORD_TABLE_INVALID', 'spec_json must include an inline word table or a words object reference');
  if ('words' in words && Array.isArray(words.words)) return WordTableSchema.parse(words);
  const { bytes } = await resolveBinary(ctx.config, ctx.storage, words as BinaryRef, 10_000_000, 'word table');
  try { return WordTableSchema.parse(JSON.parse(bytes.toString('utf8'))); }
  catch (error) { throw new PipelineError('WORD_TABLE_INVALID', `Word table is invalid JSON/schema: ${(error as Error).message}`); }
}

export async function runIngestAudio(ctx: TaskContext): Promise<PhaseResult> {
  await initWorkspace(ctx, { images: false });
  const approved = await restoreApprovedAnswer(ctx);
  const { answer, answerSha256, scriptSha256 } = approved;
  ctx.checkpoint.answer_sha256 = answerSha256;
  ctx.checkpoint.script_sha256 = scriptSha256;

  ctx.events.stageEvent('validating', { scriptSha256 });
  if (!ctx.request.spec.audio) throw new PipelineError('INVALID_AUDIO', 'spec_json must include an audio reference for ingest_audio');
  const audio = await resolveBinary(ctx.config, ctx.storage, ctx.request.spec.audio, 44_000_000, 'audio');
  const words = await resolveWords(ctx);

  ctx.events.stageEvent('aligning', { audioSha256: audio.sha256, words: words.words.length });
  const timeline = await saveAudio(ctx.workspace.root, {
    scriptSha256,
    audioBase64: audio.bytes.toString('base64'),
    words,
  }, narrationLesson(answer, ctx.input.options.fps), ctx.signal, 'external-import');
  if (timeline.speech.scriptSha256 !== scriptSha256) throw new PipelineError('STALE_AUDIO', 'Imported audio belongs to a different narration');
  const savedAudio = await fs.readFile(ctx.workspace.resolve(localPathFor('audio')));
  if (sha256(savedAudio) !== timeline.speech.audioSha256) throw new PipelineError('INVALID_AUDIO', 'Audio changed while being imported');

  clearDownstream(ctx.checkpoint);
  ctx.checkpoint.answer_sha256 = answerSha256;
  ctx.checkpoint.script_sha256 = scriptSha256;
  ctx.checkpoint.audio_sha256 = timeline.speech.audioSha256;
  ctx.checkpoint.timeline_sha256 = timelineDigest(timeline);
  ctx.checkpoint.cache = { ...ctx.checkpoint.cache, tts_key: undefined, render_key: undefined };
  ctx.checkpoint.error = undefined;
  ctx.checkpoint.repair = undefined;

  ctx.events.stageEvent('uploading', { artifacts: ['audio', 'words', 'timeline', 'alignment_check'] });
  await uploadWorkspaceFile(ctx, 'audio');
  await uploadWorkspaceFile(ctx, 'words');
  await uploadWorkspaceFile(ctx, 'timeline');
  await uploadWorkspaceFile(ctx, 'alignment_check');
  setPhaseStatus(ctx.checkpoint, 'prepare', 'pending');
  ctx.checkpoint.phase_status.ingest_audio = 'completed';
  await ctx.workspace.assertQuota(ctx.config.maxScratchBytes);
  await persistCheckpoint(ctx);
  ctx.events.stageEvent('completed', { audioSha256: ctx.checkpoint.audio_sha256, timelineSha256: ctx.checkpoint.timeline_sha256 });
  return resultFor(ctx, 'completed');
}
