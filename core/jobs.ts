import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LessonSchema, ReviewSchema, type Artifact, type AudioInput, type JobInput, type JobRecord, type Stage } from '../shared/schema.js';
import type { Config } from './config.js';
import { JobStore } from './store.js';
import { PiEngine } from './pi.js';
import { prepareWorkspace, compile } from './compiler.js';
import { saveAudio, synthesize } from './audio.js';
import { narration, type Timeline } from './alignment.js';
import { atomicWrite, decodeBase64, readJson, sha256, sourceDigest, writeJson } from './files.js';
import { checkAbort, PipelineError } from './process.js';
import { loadAgentPrompt } from './prompts.js';
import { validateWorkspace } from './verification.js';
import { inspectVisuals, checkHyperFrames, renderVideo, verifyVideo, validatedCandidate } from './quality.js';

export interface PipelineOperations {
  inspect: typeof inspectVisuals; hyperframes: typeof checkHyperFrames;
  render: typeof renderVideo; video: typeof verifyVideo;
}
const operations: PipelineOperations = { inspect: inspectVisuals, hyperframes: checkHyperFrames, render: renderVideo, video: verifyVideo };
const artifactFiles: [string, string, string][] = [
  ['lesson', 'lesson.json', 'application/json'], ['visual_source', 'src/visual.js', 'text/javascript'], ['style_source', 'src/style.css', 'text/css'],
  ['narration', 'narration.txt', 'text/plain; charset=utf-8'], ['words', 'words.json', 'application/json'], ['timeline', 'timeline.json', 'application/json'],
  ['subtitles_srt', 'lesson.srt', 'application/x-subrip'], ['subtitles_vtt', 'lesson.vtt', 'text/vtt'],
  ['structure_check', 'reports/structure.json', 'application/json'], ['math_check', 'reports/math.json', 'application/json'], ['review', 'reports/review.json', 'application/json'],
  ['alignment_check', 'reports/alignment.json', 'application/json'], ['visual_check', 'reports/visual.json', 'application/json'],
  ['hyperframes_check', 'reports/hyperframes.json', 'application/json'], ['video_check', 'reports/video.json', 'application/json'], ['quality', 'reports/quality.json', 'application/json'],
  ['audio', 'render/assets/audio/narration.mp3', 'audio/mpeg'],
];

export class JobManager {
  readonly store: JobStore;
  readonly engine: PiEngine;
  private ops: PipelineOperations;
  private queue: string[] = [];
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private uploading = new Map<string, AbortController>();
  private uploadFinished = new Map<string, Promise<void>>();
  private cancelled = new Set<string>();
  private stopping = false;
  constructor(readonly config: Config, options: { engine?: PiEngine; operations?: Partial<PipelineOperations> } = {}) {
    this.store = new JobStore(config.stateDir); this.engine = options.engine ?? new PiEngine(config); this.ops = { ...operations, ...options.operations };
  }
  async open() { await this.store.open(); for (const j of this.store.list(Number.MAX_SAFE_INTEGER).reverse()) if (j.status === 'queued') this.enqueue(j.id); }
  private clean(message: string) {
    for (const secret of [this.config.llm?.apiKey, this.config.tts?.apiKey, this.config.serviceApiKey].filter(Boolean) as string[]) message = message.split(secret).join('[REDACTED]');
    return message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').slice(0, 10000);
  }
  async create(input: JobInput) {
    if (this.stopping) throw new PipelineError('SERVICE_STOPPING', 'Service is shutting down');
    if (!this.engine.configured) throw new PipelineError('MODEL_NOT_CONFIGURED', 'Configure LLM_ENDPOINT, LLM_URL, LLM_API_KEY and LLM_MODEL');
    const id = randomUUID(), workspace = this.store.workspace(id), now = new Date().toISOString();
    await prepareWorkspace(workspace, input);
    const images = await Promise.all(input.images.map(async (image, i) => {
      const file = `inputs/problem-${i + 1}.${image.mimeType.split('/')[1].replace('jpeg', 'jpg')}`;
      await atomicWrite(path.join(workspace, file), decodeBase64(image.base64, 8_000_000)); return { mimeType: image.mimeType, file };
    }));
    const record: JobRecord = { id, status: 'queued', stage: 'queued', createdAt: now, updatedAt: now, input: { ...input, images }, attempt: 0, eventSequence: 0, artifacts: [] };
    const saved = await this.store.create(record); this.enqueue(id); return saved;
  }
  private enqueue(id: string) {
    if (!this.queue.includes(id)) this.queue.push(id);
    queueMicrotask(() => this.drain());
  }
  private drain() {
    while (!this.stopping && this.active.size < this.config.concurrency && this.queue.length) {
      const next = this.queue.findIndex(id => !this.active.has(id)); if (next < 0) break;
      const [id] = this.queue.splice(next, 1); if (this.store.get(id).status !== 'queued') continue;
      const controller = new AbortController();
      const promise = this.execute(id, controller.signal).catch(async e => {
        const current = this.store.get(id);
        if (!this.cancelled.has(id) && current.status !== 'cancelled') {
          const error = { code: controller.signal.aborted ? 'INTERRUPTED' : e instanceof PipelineError ? e.code : 'GENERATION_FAILED', message: this.clean((e as Error).message) };
          const repair = !controller.signal.aborted && !this.stopping && ['VISUAL_CHECK_FAILED', 'HYPERFRAMES_CHECK_FAILED'].includes(error.code) && (current.autoRepairs ?? 0) < this.config.maxVisualRepairAttempts;
          if (repair) {
            await this.store.update(id, { status: 'queued', stage: 'queued', sourceSha256: undefined, scriptSha256: undefined, autoRepairs: (current.autoRepairs ?? 0) + 1, error }, 'repair.queued', error);
            this.enqueue(id);
          } else await this.store.update(id, { status: 'failed', stage: 'failed', error }, 'failed');
        }
      }).finally(async () => { await this.refreshArtifacts(id).catch(() => {}); this.active.delete(id); this.drain(); });
      this.active.set(id, { controller, promise });
    }
  }
  private async stage(id: string, stage: Stage, signal: AbortSignal) {
    checkAbort(signal); await this.store.update(id, { status: 'running', stage }, 'stage'); checkAbort(signal);
  }
  private async artifactList(id: string, completed = this.store.get(id).status === 'completed') {
    const workspace = this.store.workspace(id), job = this.store.get(id);
    const artifacts = (await Promise.all(artifactFiles.map(async ([name, file, mimeType]) => {
      try { await fs.access(path.join(workspace, file)); return { name, file, mimeType }; } catch { return undefined; }
    }))).filter(Boolean) as Artifact[];
    if (completed) artifacts.push({ name: 'video', file: 'lesson.mp4', mimeType: 'video/mp4' });
    return artifacts;
  }
  async refreshArtifacts(id: string) {
    await this.store.update(id, { artifacts: await this.artifactList(id) });
  }
  private async execute(id: string, signal: AbortSignal) {
    const workspace = this.store.workspace(id); let job = this.store.get(id);
    await this.store.update(id, { attempt: job.attempt + 1, error: undefined }, 'started');
    const progress = async (type: string, data: unknown) => { await this.store.update(id, {}, type, data); };
    let lesson;
    if (!job.sourceSha256) {
      const authored = await this.engine.authorAndReview(workspace, job, signal, progress, stage => this.stage(id, stage, signal));
      lesson = authored.lesson;
      job = await this.store.update(id, { sourceSha256: authored.sourceSha256, scriptSha256: sha256(narration(lesson)) }, 'source.approved');
      await atomicWrite(path.join(workspace, 'narration.txt'), narration(lesson)); await this.refreshArtifacts(id);
    } else {
      await this.assertApproved(id); lesson = LessonSchema.parse(await readJson(path.join(workspace, 'lesson.json')));
    }
    checkAbort(signal);
    let timeline: Timeline | undefined;
    try {
      const saved = await readJson<Timeline>(path.join(workspace, 'timeline.json'));
      if (saved.speech.scriptSha256 === job.scriptSha256 && saved.speech.audioSha256 === sha256(await fs.readFile(path.join(workspace, 'render/assets/audio/narration.mp3')))) timeline = saved;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (!timeline) {
      if (job.input.options.audio === 'provided' || !this.config.tts) {
        checkAbort(signal); await this.store.update(id, { status: 'awaiting_audio', stage: 'awaiting_audio' }, 'awaiting_audio', { scriptSha256: job.scriptSha256 }); return;
      }
      await this.stage(id, 'synthesizing', signal); timeline = await synthesize(this.config, workspace, lesson, signal);
    }
    await this.stage(id, 'aligning', signal); await this.assertApproved(id);
    await this.stage(id, 'building', signal); await compile(workspace, lesson, timeline);
    await this.stage(id, 'checking', signal);
    const checkController = new AbortController(), checksSignal = AbortSignal.any([signal, checkController.signal, AbortSignal.timeout(240000)]);
    const checks = await Promise.allSettled([
      this.ops.inspect(this.config, workspace, timeline, checksSignal), this.ops.hyperframes(this.config, workspace, id, checksSignal),
    ].map(p => p.catch(e => { checkController.abort(); throw e; })));
    const failure = checks.find(r => r.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
    const samples = (checks[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof inspectVisuals>>>).value;
    await this.assertApproved(id); await this.stage(id, 'rendering', signal);
    const candidate = await validatedCandidate(workspace, timeline);
    const pending = candidate?.file ?? await this.ops.render(this.config, workspace, lesson.fps, job.input.options.quality, id, signal);
    await this.stage(id, 'validating', signal);
    if (candidate) await progress('video.reused', { videoSha256: candidate.report.videoSha256 });
    else await this.ops.video(workspace, pending, timeline, samples, signal);
    await this.assertApproved(id); checkAbort(signal);
    await fs.rename(pending, path.join(workspace, 'lesson.mp4'));
    await writeJson(path.join(workspace, 'reports/quality.json'), { passed: true, sourceSha256: job.sourceSha256, scriptSha256: job.scriptSha256,
      gates: ['schema', 'numeric-math', 'independent-review', 'whole-script-alignment', 'object-and-word-cues', 'hyperframes', 'encoded-video'],
      limitation: 'Numeric checks and model review are evidence, not a formal proof or a guarantee of factual correctness.' });
    checkAbort(signal); await this.store.update(id, { status: 'completed', stage: 'completed', error: undefined, artifacts: await this.artifactList(id, true) }, 'completed');
  }
  private async assertApproved(id: string) {
    const job = this.store.get(id), workspace = this.store.workspace(id);
    if (!job.sourceSha256 || await sourceDigest(workspace) !== job.sourceSha256) throw new PipelineError('SOURCE_CHANGED', 'Source changed after independent review; retry to re-author and re-review before rendering');
    const raw = await readJson<Record<string, unknown>>(path.join(workspace, 'reports/review.json'));
    const parsed = ReviewSchema.safeParse({ approved: raw.approved, checks: raw.checks, answer: raw.answer, issues: raw.issues });
    const promptSha256 = sha256(await loadAgentPrompt('reviewer', job.input.scope.subject));
    if (!parsed.success || !parsed.data.approved || raw.sourceSha256 !== job.sourceSha256 || raw.promptSha256 !== promptSha256) throw new PipelineError('REVIEW_INVALID', 'Independent review is missing, stale, lacks the current text/logic gates, or was made with a different prompt');
  }
  async provideAudio(id: string, input: AudioInput) {
    if (this.stopping) throw new PipelineError('SERVICE_STOPPING', 'Service is shutting down');
    const job = this.store.get(id);
    if (job.status !== 'awaiting_audio' || this.uploading.has(id)) throw new PipelineError('INVALID_STATE', 'Audio can only be supplied while awaiting_audio');
    const controller = new AbortController(); this.uploading.set(id, controller);
    let finished!: () => void;
    this.uploadFinished.set(id, new Promise<void>(resolve => { finished = resolve; }));
    try {
      await this.assertApproved(id); await this.stage(id, 'aligning', controller.signal);
      const lesson = LessonSchema.parse(await readJson(path.join(this.store.workspace(id), 'lesson.json')));
      await saveAudio(this.store.workspace(id), input, lesson, controller.signal);
      checkAbort(controller.signal); await this.store.update(id, { status: 'queued', stage: 'queued', error: undefined }, 'audio.accepted'); this.enqueue(id);
      return this.store.get(id);
    } catch (e) {
      const error = { code: e instanceof PipelineError ? e.code : 'AUDIO_REJECTED', message: this.clean((e as Error).message) };
      const staleSource = ['SOURCE_CHANGED', 'REVIEW_INVALID'].includes(error.code);
      if (!this.cancelled.has(id) && this.store.get(id).status !== 'cancelled') await this.store.update(id, { status: staleSource ? 'failed' : 'awaiting_audio', stage: staleSource ? 'failed' : 'awaiting_audio', error }, 'audio.rejected');
      throw new PipelineError(error.code, error.message);
    } finally { this.uploading.delete(id); try { await this.refreshArtifacts(id); } finally { finished(); this.uploadFinished.delete(id); } }
  }
  async cancel(id: string) {
    const job = this.store.get(id);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) throw new PipelineError('INVALID_STATE', `Cannot cancel a ${job.status} job`);
    this.cancelled.add(id); this.active.get(id)?.controller.abort(); this.uploading.get(id)?.abort(); this.queue = this.queue.filter(j => j !== id);
    return this.store.update(id, { status: 'cancelled', stage: 'cancelled', error: undefined }, 'cancelled');
  }
  async retry(id: string) {
    if (this.stopping) throw new PipelineError('SERVICE_STOPPING', 'Service is shutting down');
    const job = this.store.get(id);
    if (!['failed', 'cancelled'].includes(job.status) || this.active.has(id) || this.uploading.has(id)) throw new PipelineError('INVALID_STATE', 'Retry requires a stopped failed/cancelled job');
    let approved = false;
    try { await this.assertApproved(id); approved = true; } catch { /* must re-author and review */ }
    this.cancelled.delete(id);
    const needsRepair = ['VISUAL_CHECK_FAILED', 'HYPERFRAMES_CHECK_FAILED'].includes(job.error?.code ?? '');
    const saved = await this.store.update(id, { status: 'queued', stage: 'queued', autoRepairs: 0,
      error: needsRepair ? job.error : undefined, ...(!approved || needsRepair ? { sourceSha256: undefined, scriptSha256: undefined } : {}) }, 'retried');
    this.enqueue(id); return saved;
  }
  async close() {
    this.stopping = true; this.queue = [];
    for (const value of this.active.values()) value.controller.abort(); for (const controller of this.uploading.values()) controller.abort();
    await Promise.all([...this.active.values()].map(v => v.promise)); await Promise.all(this.uploadFinished.values()); await this.store.close();
  }
}
