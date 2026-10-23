import fs from 'node:fs/promises';
import { atomicWrite, readJson, sha256, writeJson } from '../../core/files.js';
import { AnswerSchema } from '../../shared/schema.js';
import { answerDigest, answerNarration } from '../../core/answer.js';
import { loadAgentPrompt } from '../../core/prompts.js';
import { PipelineError } from '../../core/process.js';
import type { PhaseResult } from '../types.js';
import { clearDownstream, invalidateVideoSource, setPhaseStatus } from '../checkpoint.js';
import {
  assertAnswerReview, initWorkspace, materializeImages, persistCheckpoint, repairError, restoreAuxiliaryFiles,
  restoreSourceFiles, resultFor, taskJobRecord, tryRestoreApprovedAnswer, uploadDraftFiles, uploadWorkspaceFile,
  type TaskContext,
} from './shared.js';

export async function runAuthor(ctx: TaskContext): Promise<PhaseResult> {
  await initWorkspace(ctx, { images: false });
  const hasDraft = ctx.checkpoint.auxiliary.some(file => file.path === 'answer.json' || file.path === 'lesson.json');
  const repairMode = ctx.request.autoRepairs > 0 || ctx.request.spec.repair === true || ctx.checkpoint.repair?.requested === true || hasDraft;
  if (repairMode) { await restoreSourceFiles(ctx); await restoreAuxiliaryFiles(ctx); }
  if (!repairMode) {
    const restored = await tryRestoreApprovedAnswer(ctx);
    if (restored) {
      await writeJson(ctx.workspace.resolve('request.json'), { ...ctx.input, images: ctx.imageFiles });
      setPhaseStatus(ctx.checkpoint, 'author', 'completed');
      await persistCheckpoint(ctx);
      ctx.events.stageEvent('completed', { reused: true, answerSha256: restored.answerSha256, scriptSha256: restored.scriptSha256 });
      return resultFor(ctx, 'completed');
    }
  }
  if (ctx.request.spec.imageRefs.length) {
    ctx.imageFiles = await materializeImages(ctx, ctx.request.spec.imageRefs);
  }
  await writeJson(ctx.workspace.resolve('request.json'), { ...ctx.input, images: ctx.imageFiles });

  const inheritedError = repairError(ctx) ?? ctx.checkpoint.error;
  const job = taskJobRecord(ctx, inheritedError ? { error: inheritedError } : {});
  ctx.events.stageEvent('answering', { role: 'answer-author' });
  const progress = async (type: string, data: unknown) => {
    ctx.events.observeAgentEvent(type, data);
    ctx.events.progress(type, data && typeof data === 'object' ? data as Record<string, unknown> : { value: data });
  };
  const stage = async (name: 'answering' | 'verifying' | 'answer_reviewing') => {
    ctx.events.stageEvent(name, { role: name === 'answer_reviewing' ? 'answer-reviewer' : 'answer-author' });
    if (name === 'answer_reviewing') { try { await uploadDraftFiles(ctx); } catch { /* draft recovery is best effort */ } }
  };
  const authored = await ctx.engine.answerAndReview(ctx.workspace.root, job, ctx.signal, progress, stage);
  const answer = AnswerSchema.parse(await readJson(ctx.workspace.resolve('answer.json')));
  const script = answerNarration(answer);
  const scriptSha256 = sha256(script);
  const sourceSha256 = answerDigest(answer, scriptSha256);
  if (authored.answerSha256 !== sourceSha256 || authored.scriptSha256 !== scriptSha256) {
    throw new PipelineError('ANSWER_CHANGED', 'answer.json changed after the answer reviewer approved it');
  }
  await atomicWrite(ctx.workspace.resolve('narration.txt'), script);
  // The engine writes answer-review.json. Verify the review that will be
  // published, rather than trusting only the in-memory return value.
  await assertAnswerReview(ctx.workspace.root, sourceSha256, scriptSha256, ctx.input.scope.subject);
  await fs.copyFile(ctx.workspace.resolve('reports/answer-review.json'), ctx.workspace.resolve('reports/review.json'));

  const previousScript = ctx.checkpoint.script_sha256;
  const previousAnswer = ctx.checkpoint.answer_sha256;
  if (!previousScript || previousScript !== scriptSha256) clearDownstream(ctx.checkpoint);
  else if (repairMode || !previousAnswer || previousAnswer !== sourceSha256) invalidateVideoSource(ctx.checkpoint);
  ctx.checkpoint.answer_sha256 = sourceSha256;
  ctx.checkpoint.source_sha256 = sourceSha256;
  ctx.checkpoint.script_sha256 = scriptSha256;
  ctx.events.addAudioCharacters(script.length);
  ctx.checkpoint.error = undefined;
  ctx.checkpoint.repair = undefined;
  ctx.events.stageEvent('uploading', { artifacts: ['answer', 'answer_review', 'answer_check', 'answer_math', 'narration'] });
  const answerArtifact = await uploadWorkspaceFile(ctx, 'answer');
  const answerReview = await uploadWorkspaceFile(ctx, 'answer_review');
  await uploadWorkspaceFile(ctx, 'answer_check');
  await uploadWorkspaceFile(ctx, 'answer_math');
  await uploadWorkspaceFile(ctx, 'narration');
  await uploadWorkspaceFile(ctx, 'review');
  const binding = {
    object_key: answerReview.object_key,
    sha256: answerReview.sha256,
    approved: true as const,
    kind: 'answer' as const,
    prompt_sha256: sha256(await loadAgentPrompt('answer-reviewer', ctx.input.scope.subject)),
    source_sha256: sourceSha256,
    answer_sha256: sourceSha256,
    script_sha256: scriptSha256,
  };
  ctx.checkpoint.answer_review = binding;
  ctx.checkpoint.review = binding;
  if (!answerArtifact.sha256) throw new PipelineError('ANSWER_MISSING', 'Approved answer artifact has no digest');
  setPhaseStatus(ctx.checkpoint, 'author', 'completed');
  await ctx.workspace.assertQuota(ctx.config.maxScratchBytes);
  await persistCheckpoint(ctx);
  ctx.events.stageEvent('completed', { sourceSha256, answerSha256: sourceSha256, scriptSha256 });
  return resultFor(ctx, 'completed');
}
