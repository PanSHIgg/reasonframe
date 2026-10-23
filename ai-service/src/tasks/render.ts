import fs from 'node:fs/promises';
import type { Timeline } from '../../core/alignment.js';
import { compile } from '../../core/compiler.js';
import { readJson, sha256, writeJson } from '../../core/files.js';
import { renderVideo, verifyVideo, validatedCandidate, type VisualSample } from '../../core/quality.js';
import { PipelineError } from '../../core/process.js';
import type { PhaseResult } from '../types.js';
import { artifactByName, setPhaseStatus } from '../checkpoint.js';
import {
  compositionDigest, initWorkspace, localPathFor, persistCheckpoint, renderCacheKey, restoreApprovedSource,
  restoreArtifact, restoreArtifactOptional, restoreAuxiliaryFiles, resultFor, timelineDigest,
  uploadWorkspaceFile, uploadWorkspaceFileOptional, type TaskContext,
} from './shared.js';

async function restorePrepared(ctx: TaskContext, scriptSha256: string) {
  for (const name of ['timeline', 'audio', 'words', 'visual_check', 'hyperframes_check'] as const) {
    if (!artifactByName(ctx.checkpoint, name)) throw new PipelineError('NOT_PREPARED', `Prepare checkpoint has no ${name} artifact; run prepare first`);
  }
  await Promise.all([
    restoreArtifact(ctx, 'timeline'),
    restoreArtifact(ctx, 'audio'),
    restoreArtifact(ctx, 'words'),
    restoreArtifact(ctx, 'visual_check'),
    restoreArtifact(ctx, 'hyperframes_check'),
    restoreArtifactOptional(ctx, 'alignment_check'),
    restoreArtifactOptional(ctx, 'structure_check'),
    restoreArtifactOptional(ctx, 'math_check'),
  ]);
  await restoreAuxiliaryFiles(ctx);
  const timeline = await readJson<Timeline>(ctx.workspace.resolve('timeline.json'));
  if (timeline.speech?.scriptSha256 !== scriptSha256) throw new PipelineError('STALE_AUDIO', 'Prepared timeline belongs to a different narration');
  const audio = await fs.readFile(ctx.workspace.resolve(localPathFor('audio')));
  if (sha256(audio) !== ctx.checkpoint.audio_sha256 || timeline.speech.audioSha256 !== ctx.checkpoint.audio_sha256) {
    throw new PipelineError('STALE_AUDIO', 'Prepared audio no longer matches the checkpoint');
  }
  if (!ctx.checkpoint.timeline_sha256 || timelineDigest(timeline) !== ctx.checkpoint.timeline_sha256) {
    throw new PipelineError('TIMELINE_CHANGED', 'Prepared timeline does not match the checkpoint digest');
  }
  const visual = await readJson<{ passed?: boolean; samples?: VisualSample[] }>(ctx.workspace.resolve(localPathFor('visual_check')));
  if (visual.passed !== true) throw new PipelineError('NOT_PREPARED', 'Prepare visual report did not pass; rerun prepare');
  const hyperframes = await readJson<{ ok?: boolean; browserSkipped?: boolean }>(ctx.workspace.resolve(localPathFor('hyperframes_check')));
  if (hyperframes.ok !== true || hyperframes.browserSkipped === true) throw new PipelineError('NOT_PREPARED', 'Prepare HyperFrames report did not pass; rerun prepare');
  if (!Array.isArray(visual.samples) || !visual.samples.length) throw new PipelineError('VISUAL_SAMPLES_MISSING', 'Prepare visual report has no reference frames');
  for (const sample of visual.samples) {
    try { await fs.access(ctx.workspace.resolve(sample.file)); }
    catch { throw new PipelineError('VISUAL_SAMPLES_MISSING', `Reference frame is missing: ${sample.file}`); }
  }
  return { timeline, samples: visual.samples };
}

async function tryExistingVideo(ctx: TaskContext, timeline: Timeline) {
  if (ctx.checkpoint.phase_status.render !== 'completed' || !artifactByName(ctx.checkpoint, 'video') || !artifactByName(ctx.checkpoint, 'video_check')) return undefined;
  try {
    await restoreArtifact(ctx, 'video', 'pending.mp4');
    await restoreArtifact(ctx, 'video_check');
    const candidate = await validatedCandidate(ctx.workspace.root, timeline);
    if (!candidate) return undefined;
    if (ctx.checkpoint.video_sha256 && candidate.report.videoSha256 !== ctx.checkpoint.video_sha256) return undefined;
    ctx.events.progress('video.reused', { videoSha256: candidate.report.videoSha256 });
    return candidate;
  } catch (error) {
    if (error instanceof PipelineError && ['CHECKPOINT_ARTIFACT_MISSING', 'OBJECT_NOT_FOUND', 'ARTIFACT_MISSING'].includes(error.code)) return undefined;
    throw error;
  }
}

async function tryRenderCache(ctx: TaskContext, timeline: Timeline) {
  const key = await renderCacheKey(ctx.config, ctx.checkpoint.source_sha256!, ctx.checkpoint.timeline_sha256!, timeline.fps, ctx.input.options.quality);
  const videoKey = `${key}.mp4`, reportKey = `${key}.quality.json`;
  const [videoHead, reportHead] = await Promise.all([ctx.storage.head(videoKey), ctx.storage.head(reportKey)]);
  if (!videoHead || !reportHead) return undefined;
  const [video, report] = await Promise.all([ctx.storage.get(videoKey), ctx.storage.get(reportKey)]);
  await fs.writeFile(ctx.workspace.resolve('pending.mp4'), video.bytes);
  await fs.writeFile(ctx.workspace.resolve(localPathFor('video_check')), report.bytes);
  const candidate = await validatedCandidate(ctx.workspace.root, timeline);
  if (!candidate) {
    await fs.rm(ctx.workspace.resolve('pending.mp4'), { force: true });
    await fs.rm(ctx.workspace.resolve(localPathFor('video_check')), { force: true });
    return undefined;
  }
  ctx.checkpoint.cache = { ...ctx.checkpoint.cache, render_key: key };
  ctx.events.progress('video.cache_hit', { key, videoSha256: candidate.report.videoSha256 });
  return candidate;
}

async function storeRenderCache(ctx: TaskContext, key: string) {
  try {
    await Promise.all([
      ctx.storage.put(`${key}.mp4`, await fs.readFile(ctx.workspace.resolve(localPathFor('video'))), 'video/mp4'),
      ctx.storage.put(`${key}.quality.json`, await fs.readFile(ctx.workspace.resolve(localPathFor('video_check'))), 'application/json'),
    ]);
    ctx.checkpoint.cache = { ...ctx.checkpoint.cache, render_key: key };
    ctx.events.progress('video.cache_stored', { key });
  } catch (error) {
    ctx.events.progress('video.cache_write_failed', { key, message: ctx.events.redact((error as Error).message) });
  }
}

export async function runRender(ctx: TaskContext): Promise<PhaseResult> {
  await initWorkspace(ctx, { images: false });
  const lesson = await restoreApprovedSource(ctx);
  const scriptSha256 = ctx.checkpoint.script_sha256;
  if (!scriptSha256) throw new PipelineError('SOURCE_MISSING', 'Checkpoint has no script digest');
  const { timeline, samples } = await restorePrepared(ctx, scriptSha256);

  ctx.events.stageEvent('building', { fps: lesson.fps });
  await compile(ctx.workspace.root, lesson, timeline);
  const build = await compositionDigest(ctx.workspace.root);
  if (ctx.checkpoint.build_sha256 && ctx.checkpoint.build_sha256 !== build.digest) {
    throw new PipelineError('BUILD_MISMATCH', 'Compiled composition differs from the one checked during prepare; rerun prepare');
  }
  if (!ctx.checkpoint.build_sha256) ctx.checkpoint.build_sha256 = build.digest;
  await ctx.workspace.assertQuota(ctx.config.maxScratchBytes);

  let reused = await tryExistingVideo(ctx, timeline);
  const cacheKey = await renderCacheKey(ctx.config, ctx.checkpoint.source_sha256!, ctx.checkpoint.timeline_sha256!, timeline.fps, ctx.input.options.quality);
  if (!reused) reused = await tryRenderCache(ctx, timeline);
  try {
    if (!reused) {
      ctx.events.stageEvent('rendering', { fps: lesson.fps, quality: ctx.input.options.quality, bitrate: ctx.config.core.renderBitrate });
      const started = Date.now();
      await renderVideo(ctx.config.core, ctx.workspace.root, lesson.fps, ctx.input.options.quality, ctx.request.taskId, ctx.signal);
      ctx.events.addRenderSeconds((Date.now() - started) / 1000);
      ctx.events.stageEvent('validating', { samples: samples.length });
      await verifyVideo(ctx.workspace.root, ctx.workspace.resolve('pending.mp4'), timeline, samples, ctx.signal);
    } else {
      ctx.events.stageEvent('validating', { reused: true, samples: samples.length });
    }
  } catch (error) {
    try { await uploadWorkspaceFileOptional(ctx, 'video_check'); } catch { /* preserve the original failure */ }
    throw error;
  }

  const pending = ctx.workspace.resolve('pending.mp4');
  const video = ctx.workspace.resolve('lesson.mp4');
  await fs.rename(pending, video);
  const videoSha256 = sha256(await fs.readFile(video));
  ctx.checkpoint.video_sha256 = videoSha256;
  await writeJson(ctx.workspace.resolve(localPathFor('quality')), {
    passed: true,
    sourceSha256: ctx.checkpoint.source_sha256,
    scriptSha256: ctx.checkpoint.script_sha256,
    timelineSha256: ctx.checkpoint.timeline_sha256,
    videoSha256,
    gates: ['schema', 'numeric-math', 'independent-answer-review', 'independent-video-review', 'whole-script-alignment', 'object-and-word-cues', 'hyperframes', 'encoded-video'],
    limitation: 'Numeric checks and model review are evidence, not a formal proof or a guarantee of factual correctness.',
  });

  ctx.events.stageEvent('uploading', { artifacts: ['video', 'video_check', 'quality'] });
  // A video artifact is published only after verifyVideo/validatedCandidate has
  // validated the bindings. Never upload it before this point.
  await uploadWorkspaceFile(ctx, 'video_check');
  await uploadWorkspaceFile(ctx, 'quality');
  const artifact = await uploadWorkspaceFile(ctx, 'video');
  await storeRenderCache(ctx, cacheKey);

  ctx.checkpoint.error = undefined;
  ctx.checkpoint.repair = undefined;
  setPhaseStatus(ctx.checkpoint, 'done', 'completed');
  ctx.checkpoint.phase_status.render = 'completed';
  await persistCheckpoint(ctx);
  ctx.events.stageEvent('completed', { videoSha256, objectKey: artifact.object_key });
  return resultFor(ctx, 'completed');
}
