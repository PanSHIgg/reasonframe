import fs from 'node:fs/promises';
import path from 'node:path';
import { narration, type Timeline } from '../../core/alignment.js';
import { LessonSchema, type Answer, type Lesson } from '../../shared/schema.js';
import { saveAudio, synthesize } from '../../core/audio.js';
import { compile } from '../../core/compiler.js';
import { readJson, sha256, sourceDigest, writeJson } from '../../core/files.js';
import { inspectVisuals, checkHyperFrames } from '../../core/quality.js';
import { PipelineError } from '../../core/process.js';
import { alignLessonAudio, narrationLesson } from '../../core/answer.js';
import { loadAgentPrompt } from '../../core/prompts.js';
import type { PhaseResult } from '../types.js';
import { artifactByName, invalidateVideo, setPhaseStatus } from '../checkpoint.js';
import {
  compositionDigest, initWorkspace, localPathFor, persistCheckpoint, restoreApprovedAnswer,
  restoreArtifact, restoreArtifactOptional, restoreAuxiliaryFiles, resultFor, restoreApprovedSource,
  taskJobRecord, timelineDigest, ttsCacheKey, tryRestoreApprovedVideo, restoreVideoDraft,
  uploadAuxiliaryFiles, uploadDraftFiles, uploadWorkspaceFile, uploadWorkspaceFileOptional, type TaskContext,
} from './shared.js';

async function existingTimeline(ctx: TaskContext, scriptSha256: string): Promise<Timeline | undefined> {
  if (!ctx.checkpoint.audio_sha256 || !artifactByName(ctx.checkpoint, 'audio') || !artifactByName(ctx.checkpoint, 'timeline') || !artifactByName(ctx.checkpoint, 'words')) return undefined;
  try {
    await restoreArtifact(ctx, 'audio');
    await restoreArtifact(ctx, 'timeline');
    await restoreArtifactOptional(ctx, 'words');
    await restoreArtifactOptional(ctx, 'alignment_check');
    const timeline = await readJson<Timeline>(ctx.workspace.resolve('timeline.json'));
    const audio = await fs.readFile(ctx.workspace.resolve(localPathFor('audio')));
    if (sha256(audio) !== ctx.checkpoint.audio_sha256) return undefined;
    if (timeline.speech?.audioSha256 !== ctx.checkpoint.audio_sha256) return undefined;
    if (timeline.speech?.scriptSha256 !== scriptSha256) return undefined;
    if (!artifactByName(ctx.checkpoint, 'alignment_check')) {
      await writeJson(ctx.workspace.resolve(localPathFor('alignment_check')), { passed: true, ...timeline.alignment, ...timeline.speech });
    }
    return timeline;
  } catch (error) {
    if (error instanceof PipelineError && ['CHECKPOINT_ARTIFACT_MISSING', 'OBJECT_NOT_FOUND', 'ARTIFACT_MISSING'].includes(error.code)) return undefined;
    throw error;
  }
}

async function restoreCompletedPrepare(ctx: TaskContext, answer: Answer, scriptSha256: string): Promise<{ timeline: Timeline; lesson: Lesson } | undefined> {
  if (!ctx.checkpoint.timeline_sha256 || !ctx.checkpoint.build_sha256 || ctx.checkpoint.video_review?.approved !== true) return undefined;
  try {
    const timeline = await existingTimeline(ctx, scriptSha256);
    if (!timeline) return undefined;
    if (!artifactByName(ctx.checkpoint, 'visual_check') || !artifactByName(ctx.checkpoint, 'hyperframes_check') || !artifactByName(ctx.checkpoint, 'video_review')) return undefined;
    const video = await tryRestoreApprovedVideo(ctx, answer, scriptSha256);
    if (!video) return undefined;
    await restoreArtifact(ctx, 'visual_check');
    await restoreArtifact(ctx, 'hyperframes_check');
    await restoreAuxiliaryFiles(ctx);
    const visualReport = await readJson<{ passed?: boolean; samples?: { file?: string }[] }>(ctx.workspace.resolve(localPathFor('visual_check')));
    if (visualReport.passed !== true || !Array.isArray(visualReport.samples) || !visualReport.samples.length) return undefined;
    for (const sample of visualReport.samples) {
      if (!sample.file) return undefined;
      try { await fs.access(ctx.workspace.resolve(sample.file)); } catch { return undefined; }
    }
    const hyperframesReport = await readJson<{ ok?: boolean; browserSkipped?: boolean }>(ctx.workspace.resolve(localPathFor('hyperframes_check')));
    if (hyperframesReport.ok !== true || hyperframesReport.browserSkipped === true) return undefined;
    await restoreArtifactOptional(ctx, 'structure_check');
    await restoreArtifactOptional(ctx, 'math_check');
    await restoreArtifactOptional(ctx, 'review');
    await compile(ctx.workspace.root, video.lesson, timeline);
    const build = await compositionDigest(ctx.workspace.root);
    if (build.digest !== ctx.checkpoint.build_sha256) return undefined;
    if (timelineDigest(timeline) !== ctx.checkpoint.timeline_sha256) return undefined;
    return { timeline, lesson: video.lesson };
  } catch (error) {
    if (error instanceof PipelineError && ['CHECKPOINT_ARTIFACT_MISSING', 'OBJECT_NOT_FOUND', 'ARTIFACT_MISSING', 'REVIEW_INVALID', 'SOURCE_CHANGED'].includes(error.code)) return undefined;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function restoreTtsCache(ctx: TaskContext, plan: Lesson, scriptSha256: string) {
  const key = await ttsCacheKey(ctx.config, scriptSha256);
  if (!key) return undefined;
  const audioKey = `${key}.mp3`, wordsKey = `${key}.words.json`;
  const [audioHead, wordsHead] = await Promise.all([ctx.storage.head(audioKey), ctx.storage.head(wordsKey)]);
  if (!audioHead || !wordsHead) return undefined;
  const [audio, words] = await Promise.all([ctx.storage.get(audioKey), ctx.storage.get(wordsKey)]);
  const table = JSON.parse(words.bytes.toString('utf8'));
  const timeline = await saveAudio(ctx.workspace.root, {
    scriptSha256,
    audioBase64: audio.bytes.toString('base64'),
    words: table,
  }, plan, ctx.signal, 'tts-cache');
  ctx.checkpoint.cache = { ...ctx.checkpoint.cache, tts_key: key };
  ctx.events.progress('tts.cache_hit', { key, audioSha256: timeline.speech.audioSha256 });
  return timeline;
}

async function storeTtsCache(ctx: TaskContext, key: string) {
  try {
    const [audio, words] = await Promise.all([
      fs.readFile(ctx.workspace.resolve(localPathFor('audio'))),
      fs.readFile(ctx.workspace.resolve(localPathFor('words'))),
    ]);
    await Promise.all([
      ctx.storage.put(`${key}.mp3`, audio, 'audio/mpeg'),
      ctx.storage.put(`${key}.words.json`, words, 'application/json'),
    ]);
    ctx.events.progress('tts.cache_stored', { key });
  } catch (error) {
    // Cache writes are an optimization; the durable phase artifacts are uploaded below.
    ctx.events.progress('tts_cache_write_failed', { key, message: ctx.events.redact((error as Error).message) });
  }
}

async function finalChecks(ctx: TaskContext, lesson: Lesson, timeline: Timeline) {
  ctx.events.stageEvent('checking', { checks: ['visual', 'hyperframes'] });
  const checksController = new AbortController();
  const checksSignal = AbortSignal.any([ctx.signal, checksController.signal, AbortSignal.timeout(240_000)]);
  let samples: Awaited<ReturnType<typeof inspectVisuals>>;
  try {
    const checks = await Promise.allSettled([
      inspectVisuals(ctx.config.core, ctx.workspace.root, timeline, checksSignal),
      checkHyperFrames(ctx.config.core, ctx.workspace.root, ctx.request.taskId, checksSignal),
    ].map(promise => promise.catch(error => { checksController.abort(); throw error; })));
    const failure = checks.find((check): check is PromiseRejectedResult => check.status === 'rejected');
    if (failure) throw failure.reason;
    samples = (checks[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof inspectVisuals>>>).value;
  } catch (error) {
    try {
      await uploadWorkspaceFileOptional(ctx, 'visual_check');
      await uploadWorkspaceFileOptional(ctx, 'hyperframes_check');
      await uploadAuxiliaryFiles(ctx, 'reports/frames');
    } catch { /* preserve the original quality failure */ }
    if (!ctx.signal.aborted && (error as Error)?.name === 'TimeoutError') throw new PipelineError('CHECK_TIMEOUT', 'Visual/HyperFrames checks exceeded 240000 ms');
    throw error;
  }
  if (!samples.length) throw new PipelineError('VISUAL_CHECK_FAILED', 'Visual inspection produced no reference frames');
  return samples;
}

async function currentPreviewSamples(ctx: TaskContext, passed: boolean | undefined) {
  if (!passed) return undefined;
  try {
    const report = await readJson<{ samples?: { file?: string }[] }>(ctx.workspace.resolve('reports/visual.json'));
    if (!Array.isArray(report.samples) || !report.samples.length) return undefined;
    const hyperframes = await readJson<{ ok?: boolean; browserSkipped?: boolean }>(ctx.workspace.resolve('reports/hyperframes.json'));
    if (hyperframes.ok !== true || hyperframes.browserSkipped === true) return undefined;
    return report.samples.filter((sample): sample is { file: string } => typeof sample.file === 'string' && sample.file.length > 0);
  } catch { return undefined; }
}

export async function runPrepare(ctx: TaskContext): Promise<PhaseResult> {
  await initWorkspace(ctx, { images: false });
  const approved = await restoreApprovedAnswer(ctx);
  const { answer, answerSha256, scriptSha256 } = approved;
  if (ctx.checkpoint.script_sha256 !== scriptSha256) throw new PipelineError('STALE_AUDIO', 'Approved answer script does not match the checkpoint');
  ctx.checkpoint.answer_sha256 = answerSha256;
  ctx.checkpoint.script_sha256 = scriptSha256;

  const restored = await restoreCompletedPrepare(ctx, answer, scriptSha256);
  if (restored) {
    setPhaseStatus(ctx.checkpoint, 'prepare', 'completed');
    await persistCheckpoint(ctx);
    ctx.events.stageEvent('completed', { reused: true, timelineSha256: ctx.checkpoint.timeline_sha256 });
    return resultFor(ctx, 'completed');
  }
  await restoreVideoDraft(ctx);

  const plan = narrationLesson(answer, ctx.input.options.fps);
  let timeline = await existingTimeline(ctx, scriptSha256);
  if (!timeline) {
    if (ctx.input.options.audio === 'provided' || !ctx.config.core.tts) {
      ctx.checkpoint.error = undefined;
      ctx.checkpoint.repair = undefined;
      setPhaseStatus(ctx.checkpoint, 'prepare', 'awaiting_audio');
      await persistCheckpoint(ctx);
      ctx.events.stageEvent('awaiting_audio', { scriptSha256 });
      return resultFor(ctx, 'awaiting_audio', { errorCode: 'AWAITING_AUDIO', errorMessage: 'Upload a complete MP3 and word table, then run ingest_audio and prepare again', repairable: true });
    }
    ctx.events.stageEvent('synthesizing', { provider: ctx.config.core.tts.provider });
    timeline = await restoreTtsCache(ctx, plan, scriptSha256);
    if (!timeline) {
      timeline = await synthesize(ctx.config.core, ctx.workspace.root, plan, ctx.signal);
      const key = await ttsCacheKey(ctx.config, scriptSha256);
      if (key) await storeTtsCache(ctx, key);
    }
    ctx.events.addAudioCharacters(narration(plan).length);
  }

  ctx.events.stageEvent('aligning', { source: timeline.speech.source });
  if (timeline.speech.scriptSha256 !== scriptSha256) throw new PipelineError('STALE_AUDIO', 'Aligned timeline belongs to a different narration');
  const audioBytes = await fs.readFile(ctx.workspace.resolve(localPathFor('audio')));
  const audioSha256 = sha256(audioBytes);
  if (timeline.speech.audioSha256 !== audioSha256) throw new PipelineError('STALE_AUDIO', 'Timeline audio digest differs from the narration file');
  ctx.checkpoint.audio_sha256 = audioSha256;

  // The answer and whole-script audio are approved before the video agent runs.
  // The video agent can only add visual structure; it cannot rewrite narration.
  let lesson: Lesson;
  let previewSamples: { file: string }[] | undefined;
  let trustedPreview = false;
  const existing = await tryRestoreApprovedVideo(ctx, answer, scriptSha256);
  if (existing) {
    lesson = existing.lesson;
  } else {
    const job = taskJobRecord(ctx, ctx.checkpoint.error ? { error: ctx.checkpoint.error } : {});
    const progress = async (type: string, data: unknown) => {
      ctx.events.observeAgentEvent(type, data);
      ctx.events.progress(type, data && typeof data === 'object' ? data as Record<string, unknown> : { value: data });
    };
    const stage = async (name: 'video_authoring' | 'verifying' | 'video_reviewing') => {
      ctx.events.stageEvent(name, { role: name === 'video_reviewing' ? 'video-reviewer' : 'video-author' });
    };
    const saveDraft = async () => {
      await uploadDraftFiles(ctx);
      await persistCheckpoint(ctx);
    };
    const outcome = await ctx.engine.videoAndReview(ctx.workspace.root, job, ctx.signal, progress, stage, saveDraft);
    lesson = LessonSchema.parse(outcome.lesson);
    const digest = await sourceDigest(ctx.workspace.root);
    if (digest !== outcome.sourceSha256) throw new PipelineError('SOURCE_CHANGED', 'Video source changed after the reviewer approved it');
    previewSamples = Array.isArray(outcome.preview.samples) ? outcome.preview.samples.filter((sample): sample is { file: string } => typeof sample.file === 'string') : undefined;
    trustedPreview = Boolean(outcome.preview.passed);
  }

  ctx.events.stageEvent('building', { fps: lesson.fps });
  timeline = await alignLessonAudio(ctx.workspace.root, lesson, ctx.signal, timeline.speech?.source);
  await compile(ctx.workspace.root, lesson, timeline);
  ctx.checkpoint.source_sha256 = await sourceDigest(ctx.workspace.root);
  ctx.checkpoint.timeline_sha256 = timelineDigest(timeline);
  const build = await compositionDigest(ctx.workspace.root);
  ctx.checkpoint.build_sha256 = build.digest;

  let samples = trustedPreview ? await currentPreviewSamples(ctx, true) : undefined;
  if (!samples?.length) samples = await finalChecks(ctx, lesson, timeline);
  if (!samples.length) throw new PipelineError('VISUAL_CHECK_FAILED', 'Visual inspection produced no reference frames');

  ctx.events.stageEvent('uploading', { artifacts: ['answer', 'answer_review', 'lesson', 'visual_source', 'style_source', 'video_review', 'audio', 'timeline', 'visual_check', 'hyperframes_check'] });
  await uploadWorkspaceFile(ctx, 'answer');
  await uploadWorkspaceFile(ctx, 'answer_review');
  await uploadWorkspaceFile(ctx, 'answer_check');
  await uploadWorkspaceFile(ctx, 'answer_math');
  await uploadWorkspaceFile(ctx, 'lesson');
  await uploadWorkspaceFile(ctx, 'visual_source');
  await uploadWorkspaceFile(ctx, 'style_source');
  await uploadWorkspaceFile(ctx, 'narration');
  await uploadWorkspaceFile(ctx, 'words');
  await uploadWorkspaceFile(ctx, 'timeline');
  await uploadWorkspaceFile(ctx, 'audio');
  await uploadWorkspaceFile(ctx, 'subtitles_srt');
  await uploadWorkspaceFile(ctx, 'subtitles_vtt');
  await uploadWorkspaceFile(ctx, 'structure_check');
  await uploadWorkspaceFile(ctx, 'math_check');
  await uploadWorkspaceFile(ctx, 'answer_review');
  const videoReview = await uploadWorkspaceFile(ctx, 'video_review');
  const review = await uploadWorkspaceFile(ctx, 'review');
  const videoBinding = {
    object_key: videoReview.object_key,
    sha256: videoReview.sha256,
    approved: true as const,
    kind: 'video' as const,
    prompt_sha256: sha256(await loadAgentPrompt('video-reviewer', ctx.input.scope.subject)),
    source_sha256: ctx.checkpoint.source_sha256,
    answer_sha256: answerSha256,
    script_sha256: scriptSha256,
  };
  ctx.checkpoint.video_review = videoBinding;
  ctx.checkpoint.review = videoBinding;
  await uploadWorkspaceFile(ctx, 'alignment_check');
  await uploadWorkspaceFile(ctx, 'visual_check');
  await uploadWorkspaceFile(ctx, 'hyperframes_check');
  await uploadWorkspaceFileOptional(ctx, 'preview_check');
  await uploadAuxiliaryFiles(ctx, 'reports/frames');

  ctx.checkpoint.error = undefined;
  ctx.checkpoint.repair = undefined;
  invalidateVideo(ctx.checkpoint);
  setPhaseStatus(ctx.checkpoint, 'prepare', 'completed');
  await ctx.workspace.assertQuota(ctx.config.maxScratchBytes);
  await persistCheckpoint(ctx);
  ctx.events.stageEvent('completed', { timelineSha256: ctx.checkpoint.timeline_sha256, audioSha256 });
  return resultFor(ctx, 'completed');
}
