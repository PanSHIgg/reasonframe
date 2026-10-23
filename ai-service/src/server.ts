import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { PROJECT_ROOT } from '../core/paths.js';
import { PipelineError } from '../core/process.js';
import { profileForAttempt } from '../core/config.js';
import type { AiConfig } from './config.js';
import type { ObjectStorage } from './storage.js';
import { PipelineExecutor, type RawTaskRequest } from './executor.js';
import { HealthChecker, type HealthOverrides } from './health.js';
import { TaskEventSink, type OutboundEvent } from './events.js';
import { normalizeTaskType, type PhaseResult, type TaskTypeName } from './types.js';
import { emptyCheckpoint } from './checkpoint.js';

const PROTO_PATH = path.join(PROJECT_ROOT, '..', 'proto/pipeline/v1/pipeline.proto');
const LOADER_OPTIONS: protoLoader.Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.join(PROJECT_ROOT, '..', 'proto')],
};

export interface PipelineServerOptions {
  address?: string;
  executor?: PipelineExecutor;
  health?: HealthChecker;
  healthOverrides?: HealthOverrides;
}

interface ActiveTask {
  taskId: string;
  jobId: string;
  controller: AbortController;
  startedAt: number;
}

export class ActiveTaskRegistry {
  private tasks = new Map<string, ActiveTask>();
  register(taskId: string, jobId: string) {
    const existing = this.tasks.get(taskId);
    existing?.controller.abort(new PipelineError('CANCELLED', 'A newer task with the same task_id replaced this run'));
    const controller = new AbortController();
    this.tasks.set(taskId, { taskId, jobId, controller, startedAt: Date.now() });
    return controller;
  }
  unregister(taskId: string, controller: AbortController) {
    if (this.tasks.get(taskId)?.controller === controller) this.tasks.delete(taskId);
  }
  cancel(options: { taskId?: string; jobId?: string; reason?: string }) {
    if (!options.taskId && !options.jobId) return false;
    let cancelled = false;
    for (const task of this.tasks.values()) {
      if (options.taskId && task.taskId !== options.taskId) continue;
      if (options.jobId && task.jobId !== options.jobId) continue;
      task.controller.abort(new PipelineError('CANCELLED', options.reason || 'Task cancelled'));
      cancelled = true;
    }
    return cancelled;
  }
  cancelAll(reason: string) {
    for (const task of this.tasks.values()) task.controller.abort(new PipelineError('CANCELLED', reason));
  }
  get size() { return this.tasks.size; }
  list() { return [...this.tasks.values()].map(task => ({ taskId: task.taskId, jobId: task.jobId, startedAt: task.startedAt })); }
}

function loadPipelineService() {
  const definition = protoLoader.loadSync(PROTO_PATH, LOADER_OPTIONS);
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    reasonframe: { pipeline: { v1: { PipelineService: grpc.ServiceClientConstructor & { service: grpc.ServiceDefinition } } } };
  };
  return loaded.reasonframe.pipeline.v1.PipelineService;
}

function toProtoResult(result: PhaseResult) {
  return {
    status: result.status,
    error_code: result.errorCode ?? '',
    error_message: result.errorMessage ?? '',
    repairable: result.repairable,
    checkpoint_json: Buffer.from(JSON.stringify(result.checkpoint)),
    artifacts: result.artifacts.map(artifact => ({
      name: artifact.name,
      object_key: artifact.object_key,
      mime_type: artifact.mime_type,
      size_bytes: artifact.size_bytes,
      sha256: artifact.sha256,
    })),
    usage: {
      provider: result.usage.provider,
      model: result.usage.model,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      audio_chars: result.usage.audio_chars,
      render_seconds: result.usage.render_seconds,
      cost_micros: result.usage.cost_micros,
    },
  };
}

function toProtoEvent(event: OutboundEvent) {
  return {
    seq: event.seq,
    type: event.type,
    stage: event.stage,
    data_json: Buffer.from(JSON.stringify(event.data ?? {})),
    at_unix_ms: event.at_unix_ms,
  };
}

function writeEvent(call: grpc.ServerWritableStream<any, any>, event: unknown) {
  try { call.write(event); } catch { /* cancellation closes the stream */ }
}

function sendFailure(call: grpc.ServerWritableStream<any, any>, jobId: string, code: string, message: string, status: 'failed' | 'retryable' = 'failed') {
  const checkpoint = emptyCheckpoint(jobId);
  checkpoint.error = { code, message };
  const result: PhaseResult = { status, checkpoint, errorCode: code, errorMessage: message, repairable: false, artifacts: [], usage: { provider: '', model: '', input_tokens: 0, output_tokens: 0, audio_chars: 0, render_seconds: 0, cost_micros: 0 } };
  writeEvent(call, {
    seq: 1,
    type: 'result',
    stage: 'failed',
    data_json: Buffer.from('{}'),
    at_unix_ms: Date.now(),
    result: toProtoResult(result),
  });
  try { call.end(); } catch { /* stream already closed */ }
}

export function createPipelineServer(config: AiConfig, storage: ObjectStorage, options: PipelineServerOptions = {}) {
  const executor = options.executor ?? new PipelineExecutor(config, storage);
  const health = options.health ?? new HealthChecker(config, storage, options.healthOverrides);
  const registry = new ActiveTaskRegistry();
  const service = loadPipelineService();

  const runTask = (call: grpc.ServerWritableStream<any, any>) => {
    const request = call.request ?? {};
    const jobId = String(request.job_id ?? '');
    const taskId = String(request.task_id ?? '');
    let type: TaskTypeName;
    try {
      if (!jobId || !taskId) throw new PipelineError('INVALID_REQUEST', 'task_id and job_id are required');
      type = normalizeTaskType(request.type);
    } catch (error) {
      sendFailure(call, jobId, error instanceof PipelineError ? error.code : 'INVALID_REQUEST', (error as Error).message);
      return;
    }
    if (registry.size >= config.maxTasks) {
      sendFailure(call, jobId, 'RESOURCE_EXHAUSTED', `AI service is at capacity (${config.maxTasks} active tasks)`, 'retryable');
      return;
    }
    const controller = registry.register(taskId, jobId);
    const attempt = Number(request.attempt ?? 0) || 0;
    const activeModel = profileForAttempt(config.core.llmProfiles, attempt) ?? config.core.llm;
    let provider = '';
    try { provider = activeModel ? new URL(activeModel.url).hostname : ''; }
    catch { provider = activeModel?.endpoint ?? ''; }
    const sink = new TaskEventSink(
      event => writeEvent(call, toProtoEvent(event)),
      [...config.core.llmProfiles.map(profile => profile.apiKey), config.core.llm?.apiKey, config.core.tts?.apiKey, config.internalToken,
        config.storage.kind === 's3' ? config.storage.accessKey : undefined,
        config.storage.kind === 's3' ? config.storage.secretKey : undefined].filter((value): value is string => Boolean(value)),
      provider,
      activeModel?.model ?? '',
    );
    const cancel = () => controller.abort(new PipelineError('CANCELLED', 'gRPC call cancelled'));
    (call as unknown as NodeJS.EventEmitter).on('cancelled', cancel);
    const deadline = Number(request.deadline_unix_ms ?? 0);
    const deadlineTimer = deadline > 0
      ? setTimeout(() => controller.abort(new PipelineError('TASK_TIMEOUT', 'Task deadline exceeded')), Math.max(0, deadline - Date.now()))
      : undefined;
    deadlineTimer?.unref();
    const raw: RawTaskRequest = {
      taskId,
      jobId,
      type,
      attempt,
      autoRepairs: Number(request.auto_repairs ?? 0) || 0,
      specJson: request.spec_json,
      checkpointJson: request.checkpoint_json,
      traceJson: request.trace_json,
      deadlineUnixMs: deadline,
    };
    void (async () => {
      try {
        const result = await executor.run(raw, sink, controller.signal);
        if (!controller.signal.aborted || !call.cancelled) {
          writeEvent(call, {
            seq: sink.seq + 1,
            type: 'result',
            stage: sink.stage,
            data_json: Buffer.from('{}'),
            at_unix_ms: Date.now(),
            result: toProtoResult(result),
          });
        }
      } catch (error) {
        const failure = new PipelineError('INTERNAL', (error as Error).message);
        const result: PhaseResult = {
          status: 'failed',
          checkpoint: emptyCheckpoint(jobId),
          errorCode: failure.code,
          errorMessage: sink.redact(failure.message),
          repairable: false,
          artifacts: [],
          usage: sink.snapshotUsage(),
        };
        writeEvent(call, {
          seq: sink.seq + 1,
          type: 'result',
          stage: sink.stage,
          data_json: Buffer.from('{}'),
          at_unix_ms: Date.now(),
          result: toProtoResult(result),
        });
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        (call as unknown as NodeJS.EventEmitter).removeListener('cancelled', cancel);
        registry.unregister(taskId, controller);
        try { call.end(); } catch { /* already closed */ }
      }
    })();
  };

  const impl = {
    RunTask: runTask,
    Cancel: (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
      const cancelled = registry.cancel({
        taskId: call.request?.task_id ? String(call.request.task_id) : undefined,
        jobId: call.request?.job_id ? String(call.request.job_id) : undefined,
        reason: call.request?.reason ? String(call.request.reason) : undefined,
      });
      callback(null, { cancelled });
    },
    Health: (_call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => {
      health.check(registry.size).then(
        snapshot => callback(null, snapshot),
        error => callback({ code: grpc.status.INTERNAL, message: (error as Error).message } as grpc.ServiceError),
      );
    },
  };

  const server = new grpc.Server();
  server.addService(service.service, impl);
  return { server, registry, executor, health, service };
}

export interface StartedPipelineServer {
  server: grpc.Server;
  registry: ActiveTaskRegistry;
  port: number;
  address: string;
  shutdown: (graceMs?: number) => Promise<void>;
}

export async function startPipelineServer(config: AiConfig, storage: ObjectStorage, options: PipelineServerOptions = {}): Promise<StartedPipelineServer> {
  const { server, registry } = createPipelineServer(config, storage, options);
  const address = options.address ?? config.grpcAddress;
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (error, boundPort) => error ? reject(error) : resolve(boundPort));
  });
  return {
    server,
    registry,
    port,
    address,
    async shutdown(graceMs = 5000) {
      registry.cancelAll('AI service is shutting down');
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { try { server.forceShutdown(); } catch { /* stopped */ } resolve(); }, graceMs);
        timer.unref();
        server.tryShutdown(() => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

export { PROTO_PATH, LOADER_OPTIONS };
