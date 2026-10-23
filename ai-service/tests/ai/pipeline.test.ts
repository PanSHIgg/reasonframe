import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssistantMessageEventStream, type AssistantMessage } from '@mariozechner/pi-ai';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { loadAiConfig } from '../../src/config.js';
import { createObjectStorage } from '../../src/storage.js';
import { startPipelineServer, PROTO_PATH, LOADER_OPTIONS } from '../../src/server.js';
import { parseTaskSpec } from '../../src/types.js';
import { emptyCheckpoint, mergeCheckpoint, parseCheckpoint } from '../../src/checkpoint.js';
import { sha256, writeJson } from '../../core/files.js';
import { PiEngine } from '../../core/pi.js';
import { PROJECT_ROOT } from '../../core/paths.js';

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'reasonframe-ai-test-'));
}

function exampleInput(overrides: Record<string, unknown> = {}) {
  return {
    problem: '已知球 O 的半径为 √3，点 A、B 在球面上，且 AO=1，求 cos θ。',
    scope: { subject: 'math', grade: '高中', topics: ['立体几何'], allowedMethods: [], forbiddenMethods: [] },
    supplements: '',
    options: { template: 'solid-geometry', fps: 24, quality: 'delivery', audio: 'auto' },
    ...overrides,
  };
}

function serviceClient(address: string) {
  const definition = protoLoader.loadSync(PROTO_PATH, LOADER_OPTIONS);
  const loaded = grpc.loadPackageDefinition(definition) as any;
  return new loaded.reasonframe.pipeline.v1.PipelineService(address, grpc.credentials.createInsecure());
}

function runTask(client: any, request: Record<string, unknown>) {
  return new Promise<any[]>((resolve, reject) => {
    const events: any[] = [];
    const stream = client.runTask(request);
    stream.on('data', (event: any) => events.push(event));
    stream.on('error', reject);
    stream.on('end', () => resolve(events));
  });
}

function callUnary(client: any, method: string, request: Record<string, unknown>) {
  return new Promise<any>((resolve, reject) => {
    client[method](request, (error: Error | null, response: any) => error ? reject(error) : resolve(response));
  });
}

test('task spec accepts canonical input with object references and defaults', () => {
  const spec = parseTaskSpec(Buffer.from(JSON.stringify({
    jobId: '11111111-1111-4111-8111-111111111111',
    input: exampleInput({ images: [{ mimeType: 'image/png', objectKey: 'jobs/11111111-1111-4111-8111-111111111111/input/problem-1.png', sha256: 'a'.repeat(64) }] }),
  })), '11111111-1111-4111-8111-111111111111');
  assert.equal(spec.input?.options.fps, 24);
  assert.equal(spec.imageRefs.length, 1);
  assert.equal(spec.imageRefs[0]?.objectKey, 'jobs/11111111-1111-4111-8111-111111111111/input/problem-1.png');
  assert.equal(spec.input?.images.length, 0);
});

test('checkpoint accepts snake_case hashes, map artifacts and merges by name', () => {
  const job = '11111111-1111-4111-8111-111111111111';
  const checkpoint = parseCheckpoint(Buffer.from(JSON.stringify({
    job_id: job,
    phase: 'prepare',
    phase_status: { author: 'completed', prepare: 'completed' },
    source_sha256: 'a'.repeat(64),
    script_sha256: 'b'.repeat(64),
    audio_sha256: 'c'.repeat(64),
    timeline_sha256: 'd'.repeat(64),
    artifacts: {
      timeline: { object_key: 'jobs/x/work/timeline.json', mime_type: 'application/json', size_bytes: 12, sha256: 'e'.repeat(64) },
    },
  })), job);
  assert.equal(checkpoint.source_sha256, 'a'.repeat(64));
  assert.equal(checkpoint.artifacts[0]?.name, 'timeline');
  const merged = mergeCheckpoint(checkpoint, { artifacts: [{ name: 'timeline', object_key: 'new', mime_type: 'application/json', size_bytes: 1, sha256: 'f'.repeat(64) }] });
  assert.equal(merged.artifacts.length, 1);
  assert.equal(merged.artifacts[0]?.object_key, 'new');
});

test('local object storage verifies sha256 and rejects path traversal', async () => {
  const root = await tempRoot();
  try {
    const config = await loadAiConfig({ root: PROJECT_ROOT, env: {
      SCRATCH_DIR: path.join(root, 'scratch'),
      LOCAL_OBJECT_STORE: path.join(root, 'objects'),
      AI_CAPABILITIES: 'author',
    } });
    const storage = await createObjectStorage(config);
    const body = Buffer.from('checkpoint bytes');
    const digest = sha256(body);
    await storage.put('jobs/j/work/checkpoint.json', body, 'application/json');
    const got = await storage.get('jobs/j/work/checkpoint.json', digest);
    assert.equal(got.bytes.toString(), 'checkpoint bytes');
    await assert.rejects(storage.get('jobs/j/work/checkpoint.json', '0'.repeat(64)), /SHA-256 mismatch/);
    await assert.rejects(storage.get('../escape'), /Unsafe object key/);
    assert.equal(await storage.head('jobs/j/missing.json'), null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('gRPC service reports structured failures, health and cancel over the real proto', async () => {
  const root = await tempRoot();
  const jobId = '11111111-1111-4111-8111-111111111111';
  let started: Awaited<ReturnType<typeof startPipelineServer>> | undefined;
  let client: any;
  try {
    const config = await loadAiConfig({ root: PROJECT_ROOT, env: {
      SCRATCH_DIR: path.join(root, 'scratch'),
      LOCAL_OBJECT_STORE: path.join(root, 'objects'),
      AI_CAPABILITIES: 'author',
      AI_MAX_TASKS: '3',
    } });
    const storage = await createObjectStorage(config);
    started = await startPipelineServer(config, storage, {
      address: '127.0.0.1:0',
      healthOverrides: { ffmpeg: async () => true, chromium: async () => true, storage: async () => true },
    });
    client = serviceClient(`127.0.0.1:${started.port}`);

    const invalid = await runTask(client, {
      task_id: 'task-invalid', job_id: jobId, type: 'AUTHOR', attempt: 0, auto_repairs: 0,
      spec_json: Buffer.from('{bad'), checkpoint_json: Buffer.alloc(0), trace_json: Buffer.alloc(0), deadline_unix_ms: 0,
    });
    const invalidResult = invalid.at(-1);
    assert.equal(invalidResult.type, 'result');
    assert.equal(invalidResult.result.status, 'failed');
    assert.equal(invalidResult.result.error_code, 'INVALID_SPEC');

    const unsupported = await runTask(client, {
      task_id: 'task-unsupported', job_id: jobId, type: 'PREPARE', attempt: 0, auto_repairs: 0,
      spec_json: Buffer.from('{}'), checkpoint_json: Buffer.alloc(0), trace_json: Buffer.alloc(0), deadline_unix_ms: 0,
    });
    assert.equal(unsupported.at(-1).result.error_code, 'UNSUPPORTED_TASK');

    const health = await callUnary(client, 'health', {});
    assert.equal(health.ok, true);
    assert.equal(health.model_configured, false);
    assert.equal(health.ffmpeg_ready, true);
    assert.equal(health.chromium_ready, true);
    assert.equal(health.minio_ready, true);
    assert.equal(health.max_tasks, 3);
    assert.deepEqual(health.capabilities, ['author']);

    const cancel = await callUnary(client, 'cancel', { task_id: 'missing', job_id: jobId, reason: 'test' });
    assert.equal(cancel.cancelled, false);
  } finally {
    client?.close();
    await started?.shutdown(100);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('checkpoint output names stay stable', async () => {
  const root = await tempRoot();
  try {
    const checkpoint = emptyCheckpoint('11111111-1111-4111-8111-111111111111');
    await writeJson(path.join(root, 'checkpoint.json'), checkpoint);
    const parsed = parseCheckpoint(await fs.readFile(path.join(root, 'checkpoint.json')), checkpoint.job_id);
    assert.equal(parsed.phase_status.author, 'pending');
    assert.equal(parsed.artifacts.length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('author phase persists approved source and replays without a configured model', async () => {
  const root = await tempRoot();
  try {
    const config = await loadAiConfig({ root: PROJECT_ROOT, env: {
      SCRATCH_DIR: path.join(root, 'scratch'),
      LOCAL_OBJECT_STORE: path.join(root, 'objects'),
      AI_CAPABILITIES: 'author,ingest_audio',
    } });
    const storage = await createObjectStorage(config);
    const { exampleEngine } = await import('../../scripts/fixture.js');
    const { PipelineExecutor } = await import('../../src/executor.js');
    const { TaskEventSink } = await import('../../src/events.js');
    const { exampleInput: input, exampleRoot } = await import('../../tests/helpers.js');
    const jobId = '11111111-1111-4111-8111-111111111111';
    const spec = { jobId, input: await input() };
    const raw = {
      taskId: `${jobId}:author:0:0`, jobId, type: 'AUTHOR' as const, attempt: 0, autoRepairs: 0,
      specJson: Buffer.from(JSON.stringify(spec)), checkpointJson: Buffer.alloc(0), traceJson: Buffer.alloc(0), deadlineUnixMs: 0,
    };
    const events: string[] = [];
    const observed: Record<string, unknown>[] = [];
    const first = await new PipelineExecutor(config, storage, await exampleEngine(config.core)).run(
      raw, new TaskEventSink(event => { events.push(event.type); observed.push(event.data as Record<string, unknown>); }), new AbortController().signal,
    );
    assert.equal(first.status, 'completed', `${first.errorCode}: ${first.errorMessage}`);
    assert.match(first.checkpoint.source_sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.match(first.checkpoint.script_sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.ok(first.checkpoint.artifacts.some(artifact => artifact.name === 'answer'));
    assert.ok(first.checkpoint.artifacts.some(artifact => artifact.name === 'answer_review'));
    assert.ok(first.checkpoint.artifacts.some(artifact => artifact.name === 'review'));
    assert.ok(!first.checkpoint.artifacts.some(artifact => artifact.name === 'lesson'), 'AUTHOR must stop after answer approval');
    assert.match(first.checkpoint.answer_sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(first.checkpoint.phase_status.author, 'completed');
    assert.ok(events.includes('stage') && events.includes('artifact'));
    const progressKinds = observed.filter(event => typeof event.kind === 'string');
    assert.ok(progressKinds.some(event => event.kind === 'agent.tool' && event.role === 'answer-author'));
    assert.ok(progressKinds.some(event => event.kind === 'agent.tool' && event.role === 'answer-reviewer'));

    const replayEvents: string[] = [];
    const replay = await new PipelineExecutor(config, storage).run(
      { ...raw, taskId: `${jobId}:author:0:0-replay`, checkpointJson: Buffer.from(JSON.stringify(first.checkpoint)) },
      new TaskEventSink(event => replayEvents.push(event.type)),
      new AbortController().signal,
    );
    assert.equal(replay.status, 'completed');
    assert.equal(replay.checkpoint.source_sha256, first.checkpoint.source_sha256);
    assert.ok(replayEvents.includes('stage'));

    const [audio, words] = await Promise.all([
      fs.readFile(path.join(exampleRoot, 'narration.mp3')),
      fs.readFile(path.join(exampleRoot, 'words.json'), 'utf8'),
    ]);
    const ingestSpec = { jobId, input: await input(), audio: { base64: audio.toString('base64'), mimeType: 'audio/mpeg' }, words: JSON.parse(words) };
    const ingested = await new PipelineExecutor(config, storage).run({
      ...raw,
      taskId: `${jobId}:ingest_audio:0:0`,
      type: 'INGEST_AUDIO',
      specJson: Buffer.from(JSON.stringify(ingestSpec)),
      checkpointJson: Buffer.from(JSON.stringify(replay.checkpoint)),
    }, new TaskEventSink(() => {}), new AbortController().signal);
    assert.equal(ingested.status, 'completed', `${ingested.errorCode}: ${ingested.errorMessage}`);
    assert.match(ingested.checkpoint.audio_sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.match(ingested.checkpoint.timeline_sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(ingested.checkpoint.phase_status.ingest_audio, 'completed');
    assert.equal(ingested.checkpoint.phase_status.prepare, 'pending');
    assert.ok(ingested.checkpoint.artifacts.some(artifact => artifact.name === 'audio'));
    assert.ok(ingested.checkpoint.artifacts.some(artifact => artifact.name === 'timeline'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Cancel aborts the matching active gRPC task', async () => {
  const root = await tempRoot();
  const jobId = '33333333-3333-4333-8333-333333333333';
  let started: Awaited<ReturnType<typeof startPipelineServer>> | undefined;
  let client: any;
  try {
    const config = await loadAiConfig({ root: PROJECT_ROOT, env: {
      SCRATCH_DIR: path.join(root, 'scratch'),
      LOCAL_OBJECT_STORE: path.join(root, 'objects'),
      AI_CAPABILITIES: 'author',
    } });
    const storage = await createObjectStorage(config);
    const { PipelineExecutor } = await import('../../src/executor.js');
    const { emptyCheckpoint } = await import('../../src/checkpoint.js');
    const fake = {
      run: (raw: any, _events: any, signal: AbortSignal) => new Promise<any>(resolve => {
        const finish = (code: string) => resolve({
          status: 'failed', checkpoint: { ...emptyCheckpoint(raw.jobId), error: { code, message: code } },
          errorCode: code, errorMessage: code, repairable: false, artifacts: [],
          usage: { provider: '', model: '', input_tokens: 0, output_tokens: 0, audio_chars: 0, render_seconds: 0, cost_micros: 0 },
        });
        if (signal.aborted) return finish('CANCELLED');
        signal.addEventListener('abort', () => finish('CANCELLED'), { once: true });
      }),
    } as unknown as InstanceType<typeof PipelineExecutor>;
    started = await startPipelineServer(config, storage, {
      address: '127.0.0.1:0',
      executor: fake,
      healthOverrides: { ffmpeg: async () => true, chromium: async () => true, storage: async () => true },
    });
    client = serviceClient(`127.0.0.1:${started.port}`);
    const streaming = runTask(client, {
      task_id: 'cancel-me', job_id: jobId, type: 'AUTHOR', attempt: 0, auto_repairs: 0,
      spec_json: Buffer.from('{}'), checkpoint_json: Buffer.alloc(0), trace_json: Buffer.alloc(0), deadline_unix_ms: 0,
    });
    for (let i = 0; i < 50; i++) {
      const health = await callUnary(client, 'health', {});
      if (health.active_tasks === 1) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await callUnary(client, 'health', {})).active_tasks, 1);
    const cancelled = await callUnary(client, 'cancel', { task_id: 'cancel-me', job_id: jobId, reason: 'test cancel' });
    assert.equal(cancelled.cancelled, true);
    const events = await streaming;
    assert.equal(events.at(-1).type, 'result');
    assert.equal(events.at(-1).result.error_code, 'CANCELLED');
  } finally {
    client?.close();
    await started?.shutdown(100);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task spec accepts Go normalized input with nested audio references', () => {
  const job = '11111111-1111-4111-8111-111111111111';
  const spec = parseTaskSpec(Buffer.from(JSON.stringify(exampleInput({
    images: [{ mimeType: 'image/png', objectKey: `jobs/${job}/input/problem-1.png`, file: 'inputs/problem-1.png' }],
    audio: {
      audioObjectKey: `jobs/${job}/input/audio.mp3`,
      wordsObjectKey: `jobs/${job}/input/words.json`,
      scriptSha256: 'a'.repeat(64),
    },
  }))), job);
  assert.equal(spec.input?.problem, exampleInput().problem);
  assert.equal(spec.imageRefs[0]?.objectKey, `jobs/${job}/input/problem-1.png`);
  assert.equal(spec.imageRefs[0]?.path, undefined);
  assert.equal(spec.audio?.objectKey, `jobs/${job}/input/audio.mp3`);
  assert.equal(spec.words?.objectKey, `jobs/${job}/input/words.json`);
});


test('a rejected independent review fails authoring without publishing a video', async () => {
  const root = await tempRoot();
  try {
    const config = await loadAiConfig({ root: PROJECT_ROOT, env: {
      SCRATCH_DIR: path.join(root, 'scratch'),
      LOCAL_OBJECT_STORE: path.join(root, 'objects'),
      AI_CAPABILITIES: 'author',
      REASONFRAME_AGENT_MAX_ATTEMPTS: '1',
    } });
    const storage = await createObjectStorage(config);
    const { exampleEngine } = await import('../../scripts/fixture.js');
    const { PipelineExecutor } = await import('../../src/executor.js');
    const { TaskEventSink } = await import('../../src/events.js');
    const jobId = randomUUID();
    const result = await new PipelineExecutor(config, storage, await exampleEngine(config.core, { rejectReview: true })).run({
      taskId: `${jobId}:author:0:0`, jobId, type: 'AUTHOR', attempt: 0, autoRepairs: 0,
      specJson: Buffer.from(JSON.stringify({ jobId, input: exampleInput() })),
      checkpointJson: Buffer.alloc(0), traceJson: Buffer.alloc(0), deadlineUnixMs: 0,
    }, new TaskEventSink(() => {}), new AbortController().signal);
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'QUALITY_GATE_FAILED');
    assert.equal(result.checkpoint.phase_status.author, 'failed');
    assert.ok(!result.artifacts.some(artifact => artifact.name === 'video'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an author/reviewer deadline terminates a stalled model stream', async () => {
  const root = await tempRoot();
  try {
    const config = await loadAiConfig({ root: PROJECT_ROOT, env: {
      SCRATCH_DIR: path.join(root, 'scratch'),
      LOCAL_OBJECT_STORE: path.join(root, 'objects'),
      AI_CAPABILITIES: 'author',
      REASONFRAME_AGENT_TIMEOUT_MS: '1000',
      TASK_TIMEOUT_AUTHOR_MS: '5000',
      LLM_ENDPOINT: 'responses', LLM_URL: 'https://deadline-fixture.invalid/v1',
      LLM_API_KEY: 'deadline-fixture-key', LLM_MODEL: 'configured-model',
    } });
    const storage = await createObjectStorage(config);
    let calls = 0;
    const streamSimple = (model: any, _context: any, options: any) => {
      calls++;
      const stream = new AssistantMessageEventStream();
      const abort = () => {
        const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [], stopReason: 'aborted', errorMessage: 'Aborted', timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(message);
      };
      if (options?.signal?.aborted) queueMicrotask(abort);
      else options?.signal?.addEventListener('abort', abort, { once: true });
      return stream;
    };
    const { PipelineExecutor } = await import('../../src/executor.js');
    const { TaskEventSink } = await import('../../src/events.js');
    const jobId = randomUUID();
    const result = await new PipelineExecutor(config, storage, new PiEngine(config.core, { streamSimple })).run({
      taskId: `${jobId}:author:0:0`, jobId, type: 'AUTHOR', attempt: 0, autoRepairs: 0,
      specJson: Buffer.from(JSON.stringify({ jobId, input: exampleInput() })),
      checkpointJson: Buffer.alloc(0), traceJson: Buffer.alloc(0), deadlineUnixMs: 0,
    }, new TaskEventSink(() => {}), new AbortController().signal);
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'AGENT_TIMEOUT');
    assert.equal(calls, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('prepare runs the video author/reviewer loop and replays an approved video source without calling the model', async () => {
  const root = await tempRoot();
  try {
    const config = await loadAiConfig({ root: PROJECT_ROOT, env: {
      SCRATCH_DIR: path.join(root, 'scratch'),
      LOCAL_OBJECT_STORE: path.join(root, 'objects'),
      AI_CAPABILITIES: 'author,prepare,ingest_audio',
    } });
    const storage = await createObjectStorage(config);
    const { exampleEngine } = await import('../../scripts/fixture.js');
    const { PipelineExecutor } = await import('../../src/executor.js');
    const { TaskEventSink } = await import('../../src/events.js');
    const { exampleInput: input, exampleRoot } = await import('../../tests/helpers.js');
    const jobId = randomUUID();
    const preview = async (workspace: string) => {
      await fs.mkdir(path.join(workspace, 'reports/frames'), { recursive: true });
      await fs.writeFile(path.join(workspace, 'reports/frames/fake.png'), 'fake frame');
      await fs.writeFile(path.join(workspace, 'reports/visual.json'), JSON.stringify({ passed: true, samples: [{ file: 'reports/frames/fake.png' }] }));
      await fs.writeFile(path.join(workspace, 'reports/hyperframes.json'), JSON.stringify({ ok: true, browserSkipped: false }));
      return { available: true, passed: true, samples: [{ file: 'reports/frames/fake.png' }], report: { passed: true } };
    };
    const run = (type: any, checkpoint?: any, spec?: any, engine?: any) => new PipelineExecutor(config, storage, engine).run({
      taskId: `${jobId}:${type}:0:0`, jobId, type, attempt: 0, autoRepairs: 0,
      specJson: Buffer.from(JSON.stringify(spec ?? { jobId, input: exampleInputSync })), checkpointJson: checkpoint ? Buffer.from(JSON.stringify(checkpoint)) : Buffer.alloc(0),
      traceJson: Buffer.alloc(0), deadlineUnixMs: 0,
    }, new TaskEventSink(() => {}), new AbortController().signal);
    const exampleInputSync = await input();
    const firstEngine = await exampleEngine(config.core, { preview });
    const authored = await run('AUTHOR', undefined, { jobId, input: exampleInputSync }, firstEngine);
    assert.equal(authored.status, 'completed', `${authored.errorCode}: ${authored.errorMessage}`);
    const [audio, words] = await Promise.all([
      fs.readFile(path.join(exampleRoot, 'narration.mp3')),
      fs.readFile(path.join(exampleRoot, 'words.json'), 'utf8'),
    ]);
    const ingested = await run('INGEST_AUDIO', authored.checkpoint, {
      jobId, input: exampleInputSync, audio: { base64: audio.toString('base64'), mimeType: 'audio/mpeg' }, words: JSON.parse(words),
    }, firstEngine);
    assert.equal(ingested.status, 'completed', `${ingested.errorCode}: ${ingested.errorMessage}`);

    const prepared = await run('PREPARE', ingested.checkpoint, undefined, firstEngine);
    assert.equal(prepared.status, 'completed', `${prepared.errorCode}: ${prepared.errorMessage}`);
    assert.ok(prepared.checkpoint.artifacts.some(artifact => artifact.name === 'lesson'));
    assert.ok(prepared.checkpoint.artifacts.some(artifact => artifact.name === 'video_review'));
    assert.equal(prepared.checkpoint.video_review?.approved, true);
    assert.match(prepared.checkpoint.source_sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.notEqual(prepared.checkpoint.source_sha256, prepared.checkpoint.answer_sha256);

    let modelCalls = 0;
    const replayEngine = await exampleEngine(config.core, { preview, observe: () => { modelCalls++; } });
    const replay = await run('PREPARE', prepared.checkpoint, undefined, replayEngine);
    assert.equal(replay.status, 'completed', `${replay.errorCode}: ${replay.errorMessage}`);
    assert.equal(modelCalls, 0, 'an approved video source must replay without re-running the video agent or reviewer');
    assert.equal(replay.checkpoint.source_sha256, prepared.checkpoint.source_sha256);
    assert.equal(replay.checkpoint.timeline_sha256, prepared.checkpoint.timeline_sha256);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('checkpoint parses answer and video review bindings with distinct hashes', () => {
  const job = '11111111-1111-4111-8111-111111111111';
  const checkpoint = parseCheckpoint(Buffer.from(JSON.stringify({
    job_id: job, answer_sha256: 'a'.repeat(64), script_sha256: 'b'.repeat(64), source_sha256: 'c'.repeat(64),
    answer_review: { approved: true, kind: 'answer', answer_sha256: 'a'.repeat(64), script_sha256: 'b'.repeat(64), prompt_sha256: 'd'.repeat(64) },
    video_review: { approved: true, kind: 'video', source_sha256: 'c'.repeat(64), answer_sha256: 'a'.repeat(64), script_sha256: 'b'.repeat(64), prompt_sha256: 'e'.repeat(64) },
  })), job);
  assert.equal(checkpoint.answer_sha256, 'a'.repeat(64));
  assert.equal(checkpoint.answer_review?.kind, 'answer');
  assert.equal(checkpoint.answer_review?.answer_sha256, 'a'.repeat(64));
  assert.equal(checkpoint.video_review?.kind, 'video');
  assert.equal(checkpoint.video_review?.source_sha256, 'c'.repeat(64));
  assert.equal(checkpoint.video_review?.script_sha256, 'b'.repeat(64));
});
