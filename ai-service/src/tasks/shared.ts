import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { AnswerReviewSchema, AnswerSchema, LessonSchema, ReviewSchema, type Answer, type JobInput, type JobRecord, type Lesson } from '../../shared/schema.js';
import { narration } from '../../core/alignment.js';
import { prepareWorkspace } from '../../core/compiler.js';
import { decodeBase64, readJson, safeFile, sha256, sourceDigest, atomicWrite, writeJson } from '../../core/files.js';
import { loadAgentPrompt } from '../../core/prompts.js';
import { answerDigest, answerNarration, assertStoryboard } from '../../core/answer.js';
import { PipelineError } from '../../core/process.js';
import { PROJECT_ROOT } from '../../core/paths.js';
import type { AiConfig } from '../config.js';
import type { ObjectStorage } from '../storage.js';
import type { TaskEventSink } from '../events.js';
import type { Checkpoint, ImageRef, RunTaskRequestParsed } from '../types.js';
import { addArtifact, artifactByName } from '../checkpoint.js';
import type { TaskWorkspace } from '../workspace.js';

export interface TaskContext {
  request: RunTaskRequestParsed;
  config: AiConfig;
  storage: ObjectStorage;
  workspace: TaskWorkspace;
  events: TaskEventSink;
  signal: AbortSignal;
  checkpoint: Checkpoint;
  input: JobInput;
  imageFiles: { mimeType: string; file: string }[];
  artifactVersion: string;
  engine: import('../../core/pi.js').PiEngine;
}

const localPaths: Record<string, string> = {
  answer: 'answer.json',
  answer_check: 'reports/answer-check.json',
  answer_math: 'reports/answer-math.json',
  answer_review: 'reports/answer-review.json',
  video_review: 'reports/video-review.json',
  lesson: 'lesson.json',
  visual_source: 'src/visual.js',
  style_source: 'src/style.css',
  narration: 'narration.txt',
  words: 'words.json',
  timeline: 'timeline.json',
  subtitles_srt: 'lesson.srt',
  subtitles_vtt: 'lesson.vtt',
  audio: 'render/assets/audio/narration.mp3',
  structure_check: 'reports/structure.json',
  math_check: 'reports/math.json',
  review: 'reports/review.json',
  preview_check: 'reports/preview.json',
  alignment_check: 'reports/alignment.json',
  visual_check: 'reports/visual.json',
  hyperframes_check: 'reports/hyperframes.json',
  video_check: 'reports/video.json',
  quality: 'reports/quality.json',
  video: 'lesson.mp4',
};

const workPaths: Record<string, string> = {
  answer: 'answer.json',
  answer_check: 'reports/answer-check.json',
  answer_math: 'reports/answer-math.json',
  answer_review: 'reports/answer-review.json',
  video_review: 'reports/video-review.json',
  lesson: 'lesson.json',
  visual_source: 'visual.js',
  style_source: 'style.css',
  narration: 'narration.txt',
  words: 'words.json',
  timeline: 'timeline.json',
  subtitles_srt: 'lesson.srt',
  subtitles_vtt: 'lesson.vtt',
  audio: 'narration.mp3',
  structure_check: 'reports/structure.json',
  math_check: 'reports/math.json',
  review: 'reports/review.json',
  preview_check: 'reports/preview.json',
  alignment_check: 'reports/alignment.json',
  visual_check: 'reports/visual.json',
  hyperframes_check: 'reports/hyperframes.json',
  video_check: 'reports/video.json',
  quality: 'reports/quality.json',
  video: 'lesson.mp4',
};

const mimeTypes: Record<string, string> = {
  answer: 'application/json',
  answer_check: 'application/json',
  answer_math: 'application/json',
  answer_review: 'application/json',
  video_review: 'application/json',
  lesson: 'application/json',
  visual_source: 'text/javascript',
  style_source: 'text/css',
  narration: 'text/plain; charset=utf-8',
  words: 'application/json',
  timeline: 'application/json',
  subtitles_srt: 'application/x-subrip',
  subtitles_vtt: 'text/vtt',
  audio: 'audio/mpeg',
  structure_check: 'application/json',
  math_check: 'application/json',
  review: 'application/json',
  preview_check: 'application/json',
  alignment_check: 'application/json',
  visual_check: 'application/json',
  hyperframes_check: 'application/json',
  video_check: 'application/json',
  quality: 'application/json',
  video: 'video/mp4',
};

export function localPathFor(name: string) {
  const file = localPaths[name];
  if (!file) throw new PipelineError('UNKNOWN_ARTIFACT', `Unknown artifact: ${name}`);
  return file;
}

export function mimeFor(name: string) {
  return mimeTypes[name] ?? 'application/octet-stream';
}

export function workKey(config: AiConfig, jobId: string, name: string) {
  return `jobs/${jobId}/work/${workPaths[name] ?? name}`;
}

export function artifactKey(config: AiConfig, jobId: string, version: string, name: string) {
  return `jobs/${jobId}/artifacts/${version}/${name}`;
}

async function readLocalInput(config: AiConfig, relative: string) {
  await fs.mkdir(config.localInputDir, { recursive: true, mode: 0o700 });
  let target: string;
  try { target = await safeFile(config.localInputDir, relative); }
  catch (error) { throw new PipelineError('INVALID_PATH', (error as Error).message); }
  try { return await fs.readFile(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PipelineError('OBJECT_NOT_FOUND', `Local input not found: ${relative}`); throw error; }
}

export async function resolveBinary(config: AiConfig, storage: ObjectStorage, ref: { base64?: string; path?: string; objectKey?: string; sha256?: string } | undefined, limit: number, label: string) {
  if (!ref) throw new PipelineError('INVALID_SPEC', `${label} reference is required`);
  let bytes: Buffer;
  if (ref.base64) bytes = Buffer.from(decodeBase64(ref.base64, limit));
  else if (ref.path) bytes = await readLocalInput(config, ref.path);
  else if (ref.objectKey) bytes = (await storage.get(ref.objectKey, ref.sha256)).bytes;
  else throw new PipelineError('INVALID_SPEC', `${label} reference needs base64, path or objectKey`);
  if (!bytes.length) throw new PipelineError('INVALID_SPEC', `${label} is empty`);
  if (bytes.length > limit) throw new PipelineError('INVALID_SPEC', `${label} exceeds ${limit} bytes`);
  const digest = sha256(bytes);
  if (ref.sha256 && ref.sha256 !== digest) throw new PipelineError('STORAGE_INTEGRITY', `${label} SHA-256 mismatch`);
  return { bytes, sha256: digest };
}

export async function materializeImages(ctx: TaskContext, refs: ImageRef[]) {
  const files: { mimeType: string; file: string }[] = [];
  for (const [index, ref] of refs.entries()) {
    const { bytes } = await resolveBinary(ctx.config, ctx.storage, ref, 8_000_000, `image ${index + 1}`);
    const extension = ref.mimeType === 'image/jpeg' ? 'jpg' : ref.mimeType.split('/')[1];
    const file = `inputs/problem-${index + 1}.${extension}`;
    await atomicWrite(ctx.workspace.resolve(file), bytes);
    files.push({ mimeType: ref.mimeType, file });
  }
  return files;
}

export async function initWorkspace(ctx: TaskContext, options: { images: boolean }) {
  await ctx.workspace.open();
  await prepareWorkspace(ctx.workspace.root, ctx.input);
  if (options.images && ctx.request.spec.imageRefs.length) {
    ctx.imageFiles = await materializeImages(ctx, ctx.request.spec.imageRefs);
    await writeJson(ctx.workspace.resolve('request.json'), {
      ...ctx.input,
      images: ctx.imageFiles,
    });
  }
  await ctx.workspace.assertQuota(ctx.config.maxScratchBytes);
}

export async function uploadWorkspaceFile(ctx: TaskContext, name: string, options: { local?: string; artifact?: boolean; mime?: string } = {}) {
  const local = options.local ?? localPathFor(name);
  const file = ctx.workspace.resolve(local);
  let bytes: Buffer;
  try { bytes = await fs.readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PipelineError('ARTIFACT_MISSING', `Workspace file is missing: ${local}`); throw error; }
  const digest = sha256(bytes), mime = options.mime ?? mimeFor(name);
  const storedWork = await ctx.storage.put(workKey(ctx.config, ctx.request.jobId, name), bytes, mime, digest);
  let objectKey = storedWork.object_key;
  const publish = options.artifact !== false;
  if (publish) {
    const storedArtifact = await ctx.storage.put(artifactKey(ctx.config, ctx.request.jobId, ctx.artifactVersion, name), bytes, mime, digest);
    objectKey = storedArtifact.object_key;
  }
  const record = {
    name,
    object_key: objectKey,
    work_key: storedWork.object_key,
    mime_type: mime,
    size_bytes: bytes.length,
    sha256: digest,
  };
  addArtifact(ctx.checkpoint, record);
  ctx.events.artifact(record);
  return record;
}

export async function uploadWorkspaceFileOptional(ctx: TaskContext, name: string, options: { local?: string; artifact?: boolean; mime?: string } = {}) {
  try { await fs.access(ctx.workspace.resolve(options.local ?? localPathFor(name))); }
  catch { return undefined; }
  return uploadWorkspaceFile(ctx, name, options);
}

export async function uploadAuxiliaryFiles(ctx: TaskContext, relativeRoot: string) {
  const root = ctx.workspace.resolve(relativeRoot);
  let entries: Dirent[];
  try { entries = await fs.readdir(root, { recursive: true, withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith('.log')) continue;
    const relative = path.relative(ctx.workspace.root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
    const bytes = await fs.readFile(path.join(entry.parentPath, entry.name));
    const digest = sha256(bytes);
    const key = `jobs/${ctx.request.jobId}/work/${relative}`;
    await ctx.storage.put(key, bytes, mimeFromName(entry.name), digest);
    ctx.checkpoint.auxiliary = [
      ...ctx.checkpoint.auxiliary.filter(file => file.path !== relative),
      { object_key: key, path: relative, sha256: digest, size_bytes: bytes.length },
    ];
    count++;
  }
  ctx.checkpoint.updated_at = new Date().toISOString();
  if (count) ctx.events.progress('auxiliary.uploaded', { count, root: relativeRoot });
  return count;
}

function mimeFromName(name: string) {
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.log')) return 'text/plain';
  if (name.endsWith('.mp4')) return 'video/mp4';
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

export async function restoreArtifact(ctx: TaskContext, name: string, target = localPathFor(name)) {
  const artifact = artifactByName(ctx.checkpoint, name);
  if (!artifact) throw new PipelineError('CHECKPOINT_ARTIFACT_MISSING', `Checkpoint has no ${name} artifact`);
  let stored;
  try { stored = await ctx.storage.get(artifact.work_key ?? artifact.object_key, artifact.sha256 || undefined); }
  catch (error) {
    if (artifact.work_key && artifact.work_key !== artifact.object_key && error instanceof PipelineError && error.code === 'OBJECT_NOT_FOUND') {
      stored = await ctx.storage.get(artifact.object_key, artifact.sha256 || undefined);
    } else throw error;
  }
  await atomicWrite(ctx.workspace.resolve(target), stored.bytes);
  return stored.bytes;
}

const draftPaths = [
  'answer.json', 'lesson.json', 'src/visual.js', 'src/style.css', 'narration.txt',
  'reports/answer-check.json', 'reports/answer-math.json', 'reports/answer-review.json',
  'reports/structure.json', 'reports/math.json', 'reports/visual.json', 'reports/hyperframes.json',
  'reports/preview.json', 'reports/video-review.json', 'reports/review.json',
];

export async function uploadDraftFiles(ctx: TaskContext) {
  for (const relative of draftPaths) {
    let bytes: Buffer;
    try { bytes = await fs.readFile(ctx.workspace.resolve(relative)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const digest = sha256(bytes);
    const key = `jobs/${ctx.request.jobId}/work/${relative}`;
    await ctx.storage.put(key, bytes, mimeFromName(relative), digest);
    ctx.checkpoint.auxiliary = [
      ...ctx.checkpoint.auxiliary.filter(file => file.path !== relative),
      { object_key: key, path: relative, sha256: digest, size_bytes: bytes.length },
    ];
  }
  ctx.checkpoint.updated_at = new Date().toISOString();
}

export async function restoreAuxiliaryFiles(ctx: TaskContext) {
  let count = 0;
  for (const file of ctx.checkpoint.auxiliary) {
    if (file.path.endsWith('.log')) continue;
    const stored = await ctx.storage.get(file.object_key, file.sha256 || undefined);
    await atomicWrite(ctx.workspace.resolve(file.path), stored.bytes);
    count++;
  }
  return count;
}

const videoDraftPaths = new Set([
  'lesson.json', 'src/visual.js', 'src/style.css',
  'reports/preview.json', 'reports/visual.json', 'reports/hyperframes.json',
  'reports/structure.json', 'reports/math.json', 'reports/video-review.json', 'reports/review.json',
]);

// Restore only the approved-answer-compatible video draft. This never
// overwrites answer.json or narration.txt, so a stale draft cannot change an
// approved answer.
export async function restoreVideoDraft(ctx: TaskContext) {
  let count = 0;
  for (const file of ctx.checkpoint.auxiliary) {
    if (!videoDraftPaths.has(file.path)) continue;
    const stored = await ctx.storage.get(file.object_key, file.sha256 || undefined);
    await atomicWrite(ctx.workspace.resolve(file.path), stored.bytes);
    count++;
  }
  if (count) ctx.events.progress('video.draft_restored', { count });
  return count;
}

export async function assertAnswerReview(workspace: string, answerSha256: string, scriptSha256: string, subject: JobInput['scope']['subject']) {
  let raw: Record<string, unknown>;
  try { raw = await readJson<Record<string, unknown>>(path.join(workspace, 'reports/answer-review.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PipelineError('REVIEW_INVALID', 'Independent answer review report is missing'); throw error; }
  const parsed = AnswerReviewSchema.safeParse({ approved: raw.approved, checks: raw.checks, answer: raw.answer, issues: raw.issues });
  const promptSha256 = sha256(await loadAgentPrompt('answer-reviewer', subject));
  const reportAnswerSha = typeof raw.answerSha256 === 'string' ? raw.answerSha256 : raw.sourceSha256;
  if (!parsed.success || !parsed.data.approved || reportAnswerSha !== answerSha256
    || raw.scriptSha256 !== scriptSha256 || raw.promptSha256 !== promptSha256) {
    throw new PipelineError('REVIEW_INVALID', 'Independent answer review is missing, stale, lacks the current text/logic/narration gates, or was made with a different prompt');
  }
}

export async function assertVideoReview(workspace: string, sourceSha256: string, scriptSha256: string, answerSha256: string, subject: JobInput['scope']['subject']) {
  let raw: Record<string, unknown>;
  try { raw = await readJson<Record<string, unknown>>(path.join(workspace, 'reports/video-review.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PipelineError('REVIEW_INVALID', 'Independent video review report is missing'); throw error; }
  const parsed = ReviewSchema.safeParse({ approved: raw.approved, checks: raw.checks, answer: raw.answer, issues: raw.issues });
  const promptSha256 = sha256(await loadAgentPrompt('video-reviewer', subject));
  if (!parsed.success || !parsed.data.approved || raw.sourceSha256 !== sourceSha256
    || raw.scriptSha256 !== scriptSha256 || raw.answerSha256 !== answerSha256 || raw.promptSha256 !== promptSha256) {
    throw new PipelineError('REVIEW_INVALID', 'Independent video review is missing, stale, lacks the current visual/narration/answer gates, or was made with a different prompt');
  }
}

export async function restoreApprovedAnswer(ctx: TaskContext) {
  const checkpoint = ctx.checkpoint;
  if (checkpoint.answer_review?.approved !== true || !artifactByName(checkpoint, 'answer') || !artifactByName(checkpoint, 'answer_review')) {
    throw new PipelineError('ANSWER_MISSING', 'Checkpoint has no approved answer');
  }
  await restoreArtifact(ctx, 'answer');
  await restoreArtifact(ctx, 'answer_review');
  await restoreArtifactOptional(ctx, 'answer_check');
  await restoreArtifactOptional(ctx, 'answer_math');
  await restoreArtifactOptional(ctx, 'narration');
  const answer = AnswerSchema.parse(await readJson(ctx.workspace.resolve('answer.json')));
  const scriptSha256 = sha256(answerNarration(answer));
  const answerSha256 = answerDigest(answer, scriptSha256);
  if (checkpoint.answer_sha256 && checkpoint.answer_sha256 !== answerSha256) throw new PipelineError('ANSWER_CHANGED', 'Approved answer changed after review; re-author and re-review before continuing');
  if (checkpoint.script_sha256 && checkpoint.script_sha256 !== scriptSha256) throw new PipelineError('ANSWER_CHANGED', 'Approved narration changed after review; re-author and re-review before continuing');
  await assertAnswerReview(ctx.workspace.root, answerSha256, scriptSha256, ctx.input.scope.subject);
  checkpoint.answer_sha256 = answerSha256;
  checkpoint.script_sha256 = scriptSha256;
  await atomicWrite(ctx.workspace.resolve('narration.txt'), answerNarration(answer));
  return { answer, answerSha256, scriptSha256 };
}

export async function tryRestoreApprovedAnswer(ctx: TaskContext) {
  try { return await restoreApprovedAnswer(ctx); }
  catch (error) {
    if (error instanceof PipelineError && ['ANSWER_MISSING', 'CHECKPOINT_ARTIFACT_MISSING', 'OBJECT_NOT_FOUND', 'REVIEW_INVALID', 'ANSWER_CHANGED'].includes(error.code)) return undefined;
    throw error;
  }
}

export async function tryRestoreApprovedVideo(ctx: TaskContext, answer: Answer, scriptSha256: string) {
  const checkpoint = ctx.checkpoint;
  if (checkpoint.video_review?.approved !== true || !artifactByName(checkpoint, 'video_review')) return undefined;
  for (const name of ['lesson', 'visual_source', 'style_source'] as const) if (!artifactByName(checkpoint, name)) return undefined;
  try {
    for (const name of ['lesson', 'visual_source', 'style_source', 'video_review'] as const) await restoreArtifact(ctx, name);
    await fs.copyFile(ctx.workspace.resolve('reports/video-review.json'), ctx.workspace.resolve('reports/review.json'));
    const lesson = LessonSchema.parse(await readJson(ctx.workspace.resolve('lesson.json')));
    assertStoryboard(answer, lesson);
    const script = sha256(await import('../../core/alignment.js').then(module => module.narration(lesson)));
    if (script !== scriptSha256) return undefined;
    const digest = await sourceDigest(ctx.workspace.root);
    if (checkpoint.source_sha256 && checkpoint.source_sha256 !== digest) return undefined;
    const answerSha256 = answerDigest(answer, scriptSha256);
    await assertVideoReview(ctx.workspace.root, digest, script, answerSha256, ctx.input.scope.subject);
    await restoreArtifactOptional(ctx, 'structure_check');
    await restoreArtifactOptional(ctx, 'math_check');
    await restoreArtifactOptional(ctx, 'visual_check');
    await restoreArtifactOptional(ctx, 'hyperframes_check');
    await restoreArtifactOptional(ctx, 'review');
    return { lesson, sourceSha256: digest };
  } catch (error) {
    if (error instanceof PipelineError && ['CHECKPOINT_ARTIFACT_MISSING', 'OBJECT_NOT_FOUND', 'REVIEW_INVALID', 'ANSWER_CHANGED', 'SOURCE_CHANGED'].includes(error.code)) return undefined;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function restoreApprovedSource(ctx: TaskContext) {
  const checkpoint = ctx.checkpoint;
  const { answer, answerSha256, scriptSha256 } = await restoreApprovedAnswer(ctx);
  if (!artifactByName(checkpoint, 'lesson') || !artifactByName(checkpoint, 'video_review')) throw new PipelineError('SOURCE_MISSING', 'Checkpoint has no approved video source');
  await restoreArtifact(ctx, 'lesson');
  await restoreArtifact(ctx, 'visual_source');
  await restoreArtifact(ctx, 'style_source');
  await restoreArtifact(ctx, 'video_review');
  await restoreArtifactOptional(ctx, 'structure_check');
  await restoreArtifactOptional(ctx, 'math_check');
  await restoreArtifactOptional(ctx, 'visual_check');
  await restoreArtifactOptional(ctx, 'hyperframes_check');
  const digest = await sourceDigest(ctx.workspace.root);
  if (checkpoint.source_sha256 && checkpoint.source_sha256 !== digest) throw new PipelineError('SOURCE_CHANGED', 'Approved video source changed after review; re-run the video loop before continuing');
  const lesson = LessonSchema.parse(await readJson(ctx.workspace.resolve('lesson.json')));
  const script = sha256((await import('../../core/alignment.js')).narration(lesson));
  if (script !== scriptSha256) throw new PipelineError('SOURCE_CHANGED', 'Narration changed after video approval; re-author and re-review before continuing');
  assertStoryboard(answer, lesson);
  await assertVideoReview(ctx.workspace.root, digest, script, answerSha256, ctx.input.scope.subject);
  checkpoint.source_sha256 = digest;
  checkpoint.script_sha256 = script;
  checkpoint.answer_sha256 = answerSha256;
  await atomicWrite(ctx.workspace.resolve('narration.txt'), (await import('../../core/alignment.js')).narration(lesson));
  return lesson;
}

export async function restoreArtifactOptional(ctx: TaskContext, name: string, target = localPathFor(name)) {
  if (!artifactByName(ctx.checkpoint, name)) return false;
  await restoreArtifact(ctx, name, target);
  return true;
}

export async function restoreSourceFiles(ctx: TaskContext) {
  const files = ['answer', 'answer_review', 'answer_check', 'answer_math', 'lesson', 'visual_source', 'style_source', 'narration', 'structure_check', 'math_check', 'review', 'video_review', 'visual_check', 'hyperframes_check'] as const;
  let restored = false;
  for (const name of files) {
    if (!artifactByName(ctx.checkpoint, name)) continue;
    await restoreArtifact(ctx, name);
    restored = true;
  }
  return restored;
}

export async function persistCheckpoint(ctx: TaskContext) {
  ctx.checkpoint.updated_at = new Date().toISOString();
  const bytes = Buffer.from(JSON.stringify(ctx.checkpoint, null, 2) + '\n');
  const digest = sha256(bytes);
  await ctx.storage.put(`jobs/${ctx.request.jobId}/work/checkpoint.json`, bytes, 'application/json', digest);
  await ctx.storage.put(`jobs/${ctx.request.jobId}/work/checkpoints/${ctx.checkpoint.phase}.json`, bytes, 'application/json', digest);
}

export async function compositionDigest(workspace: string) {
  const render = path.join(workspace, 'render');
  const assets = path.join(render, 'assets');
  const entries = await fs.readdir(assets, { recursive: true, withFileTypes: true });
  const files = ['index.html', 'index.motion.json', ...entries.filter(entry => entry.isFile()).map(entry => path.relative(render, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))].sort();
  const content = await Promise.all(files.map(async name => [name, sha256(await fs.readFile(path.join(render, name)))]));
  return { digest: sha256(JSON.stringify(content)), files: content.length };
}

export function timelineDigest(timeline: unknown) { return sha256(JSON.stringify(timeline)); }

let renderVersions: Promise<string> | undefined;
export function renderVersionDigest() {
  renderVersions ??= (async () => {
    try {
      const [compiler, quality, packageJson] = await Promise.all([
        fs.readFile(path.join(PROJECT_ROOT, 'core/compiler.ts')),
        fs.readFile(path.join(PROJECT_ROOT, 'core/quality.ts')),
        fs.readFile(path.join(PROJECT_ROOT, 'package.json')),
      ]);
      const dependencies = JSON.parse(packageJson.toString('utf8')) as { dependencies?: Record<string, string> };
      return sha256(Buffer.concat([compiler, quality, Buffer.from(JSON.stringify({ hyperframes: dependencies.dependencies?.hyperframes, gsap: dependencies.dependencies?.gsap, katex: dependencies.dependencies?.katex }))]));
    } catch {
      return 'reasonframe-0.1.0';
    }
  })();
  return renderVersions;
}

export async function ttsCacheKey(config: AiConfig, scriptSha256: string) {
  if (!config.core.tts) return undefined;
  const tts = config.core.tts;
  const settings = sha256(JSON.stringify({ provider: tts.provider, voice: tts.voice, url: tts.url, python: tts.python }));
  return `cache/tts/${sha256(`tts:v1|${tts.provider}|${tts.voice}|${scriptSha256}|${settings}`)}`;
}

export async function renderCacheKey(config: AiConfig, sourceSha256: string, timelineSha256: string, fps: number, quality: string) {
  const versions = await renderVersionDigest();
  return `cache/render/${sha256(`render:v1|${sourceSha256}|${timelineSha256}|${fps}|${quality}|${config.core.renderBitrate}|${versions}`)}`;
}

export function taskJobRecord(ctx: TaskContext, options: { error?: { code: string; message: string } } = {}): JobRecord {
  const now = new Date().toISOString();
  return {
    id: ctx.request.jobId,
    status: 'queued',
    stage: 'queued',
    createdAt: now,
    updatedAt: now,
    input: { ...ctx.input, images: ctx.imageFiles },
    attempt: ctx.request.attempt,
    autoRepairs: ctx.request.autoRepairs,
    eventSequence: 0,
    artifacts: [],
    sourceSha256: ctx.checkpoint.source_sha256,
    scriptSha256: ctx.checkpoint.script_sha256,
    ...(options.error ? { error: options.error } : {}),
  };
}

export function repairError(ctx: TaskContext) {
  const repair = ctx.checkpoint.repair;
  if (!repair?.requested) return undefined;
  const reason = repair.reason ?? ctx.checkpoint.error?.code ?? 'VISUAL_CHECK_FAILED';
  const message = repair.message ?? ctx.checkpoint.error?.message ?? 'Previous prepare-quality check failed; fix the source and re-review';
  return { code: reason, message };
}

export function resultFor(ctx: TaskContext, status: import('../types.js').ResultStatus, options: { errorCode?: string; errorMessage?: string; repairable?: boolean } = {}): import('../types.js').PhaseResult {
  return {
    status,
    checkpoint: ctx.checkpoint,
    errorCode: options.errorCode,
    errorMessage: options.errorMessage ? ctx.events.redact(options.errorMessage) : undefined,
    repairable: options.repairable ?? false,
    artifacts: ctx.checkpoint.artifacts,
    usage: ctx.events.snapshotUsage(),
  };
}
