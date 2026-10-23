import { JobInputSchema } from '../shared/schema.js';
import { PipelineError } from '../core/process.js';
import { PiEngine } from '../core/pi.js';
import { profileForAttempt } from '../core/config.js';
import type { AiConfig } from './config.js';
import type { ObjectStorage } from './storage.js';
import { TaskEventSink } from './events.js';
import { TaskWorkspace } from './workspace.js';
import {
  classifyFailure, phaseForTask, parseTaskSpec,
  type PhaseResult, type RunTaskRequestParsed, type TaskTypeName,
} from './types.js';
import { emptyCheckpoint, parseCheckpoint, setPhaseStatus } from './checkpoint.js';
import { persistCheckpoint, type TaskContext } from './tasks/shared.js';
import { runAuthor } from './tasks/author.js';
import { runPrepare } from './tasks/prepare.js';
import { runRender } from './tasks/render.js';
import { runIngestAudio } from './tasks/ingest.js';

export interface RawTaskRequest {
  taskId: string;
  jobId: string;
  type: TaskTypeName;
  attempt: number;
  autoRepairs: number;
  specJson?: Uint8Array | Buffer;
  checkpointJson?: Uint8Array | Buffer;
  traceJson?: Uint8Array | Buffer;
  deadlineUnixMs: number;
}

function parseTrace(bytes: Uint8Array | Buffer | undefined) {
  if (!bytes?.length) return {};
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>; }
  catch { return { invalid: true }; }
}

export class PipelineExecutor {
  private engine: PiEngine;
  private readonly customEngine: boolean;
  constructor(readonly config: AiConfig, readonly storage: ObjectStorage, engine?: PiEngine) {
    this.engine = engine ?? new PiEngine(config.core);
    this.customEngine = Boolean(engine);
  }
  private engineForAttempt(attempt: number): PiEngine {
    if (this.customEngine) return this.engine;
    const profile = profileForAttempt(this.config.core.llmProfiles, attempt);
    return profile ? new PiEngine({ ...this.config.core, llm: profile }) : this.engine;
  }
  private async loadInput(spec: ReturnType<typeof parseTaskSpec>, jobId: string) {
    if (spec.input) return;
    const key = spec.inputObjectKey ?? `jobs/${jobId}/input/request.json`;
    let bytes: Buffer;
    try { bytes = (await this.storage.get(key)).bytes; }
    catch (error) {
      if (error instanceof PipelineError && error.code === 'OBJECT_NOT_FOUND') throw new PipelineError('INVALID_SPEC', `spec_json has no input and ${key} was not found`);
      throw error;
    }
    let stored: unknown;
    try { stored = JSON.parse(bytes.toString('utf8')); }
    catch (error) { throw new PipelineError('INVALID_SPEC', `Stored request ${key} is not valid JSON: ${(error as Error).message}`); }
    const parsed = parseTaskSpec(Buffer.from(JSON.stringify({ input: stored })), jobId);
    spec.input = parsed.input;
    spec.imageRefs = parsed.imageRefs;
  }
  async run(raw: RawTaskRequest, events: TaskEventSink, parentSignal: AbortSignal): Promise<PhaseResult> {
    const phase = phaseForTask(raw.type);
    let workspace: TaskWorkspace | undefined;
    let context: TaskContext | undefined;
    let completed = false;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new PipelineError('TASK_TIMEOUT', `${phase} exceeded ${this.config.timeouts[phase]} ms`)), this.config.timeouts[phase]);
    timer.unref();
    try {
      if (!this.config.capabilities.has(phase)) {
        const checkpoint = emptyCheckpoint(raw.jobId);
        checkpoint.error = { code: 'UNSUPPORTED_TASK', message: `This AI service does not provide the ${phase} capability` };
        setPhaseStatus(checkpoint, phase, 'failed');
        return { status: 'failed', checkpoint, errorCode: 'UNSUPPORTED_TASK', errorMessage: checkpoint.error.message, repairable: false, artifacts: [], usage: events.snapshotUsage() };
      }
      const spec = parseTaskSpec(raw.specJson, raw.jobId);
      await this.loadInput(spec, raw.jobId);
      let input;
      try { input = JobInputSchema.parse(spec.input); }
      catch (error) { throw new PipelineError('INVALID_SPEC', `Invalid canonical input: ${(error as Error).message}`); }
      const checkpoint = parseCheckpoint(raw.checkpointJson, raw.jobId);
      const signal = AbortSignal.any([parentSignal, timeout.signal]);
      signal.throwIfAborted();
      workspace = new TaskWorkspace(this.config.scratchDir, raw.jobId, raw.taskId);
      // Fallback is selected once per task attempt; a retry never switches models mid-request.
      const engine = this.engineForAttempt(raw.attempt);
      const artifactsVersion = raw.attempt + 1;
      const parsed: RunTaskRequestParsed = {
        taskId: raw.taskId,
        jobId: raw.jobId,
        type: raw.type,
        attempt: raw.attempt,
        autoRepairs: raw.autoRepairs,
        spec,
        checkpoint,
        trace: parseTrace(raw.traceJson),
        deadlineUnixMs: raw.deadlineUnixMs,
      };
      context = {
        request: parsed,
        config: this.config,
        storage: this.storage,
        workspace,
        events,
        signal,
        checkpoint,
        input,
        imageFiles: [],
        artifactVersion: spec.artifactVersion ?? String(artifactsVersion),
        engine,
      };
      setPhaseStatus(checkpoint, phase, 'running');
      const result = raw.type === 'AUTHOR' ? await runAuthor(context)
        : raw.type === 'PREPARE' ? await runPrepare(context)
          : raw.type === 'RENDER' ? await runRender(context)
            : await runIngestAudio(context);
      completed = result.status === 'completed';
      events.recordUsage();
      return result;
    } catch (error) {
      const failure = classifyFailure(error);
      const checkpoint = context?.checkpoint ?? emptyCheckpoint(raw.jobId);
      const message = events.redact(failure.message);
      checkpoint.error = { code: failure.code, message };
      setPhaseStatus(checkpoint, phase, failure.retryable ? 'retryable' : 'failed');
      if (failure.repairable) checkpoint.repair = { requested: true, failed_phase: phase, reason: failure.code, message };
      if (context) {
        try { await persistCheckpoint(context); } catch { /* the original failure is more important */ }
      }
      events.recordUsage();
      const usage = events.snapshotUsage();
      if (context) {
        try { await context.workspace.cleanup(this.config.keepScratch); } catch { /* best effort */ }
      }
      return {
        status: failure.retryable ? 'retryable' : 'failed',
        checkpoint,
        errorCode: failure.code,
        errorMessage: message,
        repairable: failure.repairable,
        artifacts: checkpoint.artifacts,
        usage,
      };
    } finally {
      clearTimeout(timer);
      if (workspace) {
        // Keep failed/interrupted workspaces so a retry can resume from drafts;
        // successful workspaces are always reclaimed.
        try { await workspace.cleanup(this.config.keepScratch && !completed); } catch { /* best effort */ }
      }
    }
  }
}
