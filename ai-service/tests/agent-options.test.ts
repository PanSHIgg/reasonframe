import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AssistantMessageEventStream, type AssistantMessage } from '@mariozechner/pi-ai';
import { loadConfig } from '../core/config.js';
import { PiEngine, type RuntimeOverrides } from '../core/pi.js';
import { plannedProvider } from '../scripts/fixture.js';
import { exampleAnswer, exampleLesson, exampleRoot, setup } from './helpers.js';

async function runtime(env: NodeJS.ProcessEnv = {}) {
  const s = await setup();
  const config = await loadConfig({ root: s.temp, env: {
    REASONFRAME_STATE_DIR: s.temp, LLM_ENDPOINT: 'responses', LLM_URL: 'https://agent-fixture.invalid/v1',
    LLM_API_KEY: 'agent-fixture-key', LLM_MODEL: 'configured-model', LLM_RETRY_DELAY_MS: '0', ...env,
  } });
  return { ...s, config };
}

test('Pi receives configured capacity, output, sampling, thinking and provider timeout options', async () => {
  const s = await runtime({ LLM_CONTEXT_WINDOW: '96000', LLM_MAX_TOKENS: '6144', LLM_TEMPERATURE: '0.4', LLM_THINKING_LEVEL: 'medium', LLM_REQUEST_TIMEOUT_MS: '45000' });
  const delegate = plannedProvider(() => undefined);
  let observed: any, session: Awaited<ReturnType<PiEngine['session']>> | undefined;
  try {
    const streamSimple: RuntimeOverrides['streamSimple'] = (model, context, options) => {
      observed = { model, options }; return delegate(model, context, options);
    };
    session = await new PiEngine(s.config, { streamSimple }).session(s.temp, 'video-author', 24, AbortSignal.timeout(3000), async () => {});
    await session.prompt('Finish.');
    assert.equal(observed.model.contextWindow, 96000); assert.equal(observed.model.reasoning, true);
    assert.equal(observed.options.maxTokens, 6144); assert.equal(observed.options.temperature, 0.4);
    assert.equal(observed.options.reasoning, 'medium'); assert.equal(observed.options.timeoutMs, 45000);
    assert.equal(observed.options.maxRetries, 0);
  } finally { session?.dispose(); await s.cleanup(); }
});

test('a fresh workspace lists real files and explains how to create a missing answer', async () => {
  const s = await runtime();
  let session: Awaited<ReturnType<PiEngine['session']>> | undefined, step = 0;
  const snapshots: any[][] = [];
  const answer = await exampleAnswer();
  const actions = [
    { name: 'list_files', arguments: {} },
    { name: 'read_file', arguments: { path: 'answer.json' } },
    { name: 'write_answer', arguments: { answer } },
    { name: 'list_files', arguments: {} },
  ];
  const delegate = plannedProvider(() => actions[step++]);
  try {
    await fs.writeFile(path.join(s.temp, 'AUTHORING.md'), 'Create a new answer.');
    const streamSimple: RuntimeOverrides['streamSimple'] = (model, context, options) => {
      snapshots.push(structuredClone(context.messages)); return delegate(model, context, options);
    };
    session = await new PiEngine(s.config, { streamSimple }).session(s.temp, 'answer-author', 24, AbortSignal.timeout(3000), async () => {});
    await session.prompt('List files, create the new answer, then list again.');
    const toolResult = (messages: any[], name: string) => JSON.parse(messages.filter(m => m.role === 'toolResult' && m.toolName === name).at(-1).content[0].text);
    const before = toolResult(snapshots[1], 'list_files');
    assert(before.readable.includes('AUTHORING.md'));
    assert(!before.readable.includes('answer.json'));
    assert(before.editable.includes('answer.json')); assert(before.notCreated.includes('answer.json'));
    const missing = toolResult(snapshots[2], 'read_file');
    assert.equal(missing.exists, false); assert.match(missing.nextStep, /write_answer/);
    const after = toolResult(snapshots[4], 'list_files');
    assert(after.readable.includes('answer.json')); assert(!after.notCreated.includes('answer.json'));
  } finally { session?.dispose(); await s.cleanup(); }
});

test('structured lesson tools preserve LaTeX and reject invalid updates without changing the file', async () => {
  const s = await runtime();
  let session: Awaited<ReturnType<PiEngine['session']>> | undefined, step = 0;
  const snapshots: any[][] = [];
  const note = String.raw`核对 \frac{7}{5}，不要增加转义。`;
  const original = await exampleLesson();
  await fs.writeFile(path.join(s.temp, 'answer.json'), JSON.stringify(await exampleAnswer()));
  const [entityId, entity] = Object.entries(original.entities).find(([, entity]) => entity.vertices?.length)!;
  const actions = [
    { name: 'write_lesson', arguments: { lesson: original } },
    { name: 'update_lesson', arguments: { changes: [
      { pointer: '/scenes/0/note', text: note }, { pointer: '/model/typedPoint', numbers: [110, 245, 0] },
      { pointer: `/entities/${entityId}/vertices`, strings: entity.vertices },
      { pointer: '/scenes/0/blocks', json: JSON.stringify(original.scenes[0].blocks) },
    ] } },
    { name: 'read_lesson', arguments: {} },
  ];
  const delegate = plannedProvider(() => actions[step++]);
  try {
    session = await new PiEngine(s.config, { streamSimple: (model, context, options) => {
      const schema = context.tools?.find(tool => tool.name === 'write_lesson')?.parameters as any;
      assert.equal(schema.properties.lesson.properties.scenes.type, 'array');
      assert.equal(schema.properties.lesson.properties.scenes.items.properties.beats.type, 'array');
      assert.equal(schema.properties.lesson.properties.model.additionalProperties.anyOf[0].type, 'number');
      const update = context.tools?.find(tool => tool.name === 'update_lesson')?.parameters as any;
      assert.equal(update.properties.changes.items.properties.numbers.type, 'array');
      assert.equal(update.properties.changes.items.properties.numbers.items.type, 'number');
      snapshots.push(structuredClone(context.messages)); return delegate(model, context, options);
    } }).session(s.temp, 'author', 24, AbortSignal.timeout(3000), async () => {});
    await session.prompt('Write, update and read the lesson.');
    const file = path.join(s.temp, 'lesson.json'), saved = await fs.readFile(file, 'utf8');
    assert.equal(JSON.parse(saved).scenes[0].note, note);
    assert.deepEqual(JSON.parse(saved).model.typedPoint, [110, 245, 0]);
    assert.deepEqual(JSON.parse(saved).entities[entityId].vertices, entity.vertices);
    const read = snapshots[3].findLast(m => m.role === 'toolResult' && m.toolName === 'read_lesson');
    assert.equal(JSON.parse(read.content[0].text).lesson.scenes[0].note, note);
    session.dispose(); session = undefined;
    for (const action of [
      { name: 'update_lesson', arguments: { changes: [{ pointer: '/scenes/0/note', text: 'This must not be committed.' }, { pointer: '/width', number: 1000 }] } },
      { name: 'update_lesson', arguments: { changes: [{ pointer: '/__proto__/polluted', boolean: true }] } },
      { name: 'update_lesson', arguments: { changes: [{ pointer: '/model/constructor/prototype/polluted', boolean: true }] } },
      { name: 'update_lesson', arguments: { changes: [{ pointer: '/missing/parent', boolean: true }] } },
      { name: 'update_lesson', arguments: { changes: [{ pointer: '/scenes/999/note', text: 'invalid index' }] } },
      { name: 'update_lesson', arguments: { changes: [{ pointer: '/model/~2invalid', number: 1 }] } },
      { name: 'update_lesson', arguments: { changes: [{ pointer: '/scenes/0/note', text: 'ambiguous', number: 1 }] } },
      { name: 'update_lesson', arguments: { changes: [{ pointer: '/scenes/0/blocks', json: '{' }] } },
      { name: 'edit_file', arguments: { path: 'lesson.json', oldText: note, newText: 'invalid path' } },
    ]) {
      session = await new PiEngine(s.config, { streamSimple: plannedProvider(() => action) }).session(s.temp, 'video-author', 24, AbortSignal.timeout(3000), async () => {});
      await assert.rejects(session.prompt('Try the invalid edit.'), { code: 'AGENT_RESPONSE_FAILED' });
      assert.equal(await fs.readFile(file, 'utf8'), saved);
      assert.equal(({} as any).polluted, undefined);
      session.dispose(); session = undefined;
    }
  } finally { session?.dispose(); await s.cleanup(); }
});

test('a read-only reviewer can request preview checks and learns when full audio is not available yet', async () => {
  const s = await runtime();
  let session: Awaited<ReturnType<PiEngine['session']>> | undefined, step = 0, observed: any;
  const delegate = plannedProvider(context => {
    if (step++ === 0) return { name: 'validate_preview', arguments: {} };
    observed = context.messages.findLast(message => message.role === 'toolResult');
    assert(!context.tools?.some(tool => ['write_lesson', 'update_lesson', 'write_file', 'edit_file'].includes(tool.name)));
    return undefined;
  });
  try {
    await fs.cp(path.join(exampleRoot, 'src'), path.join(s.temp, 'src'), { recursive: true });
    await fs.writeFile(path.join(s.temp, 'lesson.json'), JSON.stringify(await exampleLesson()));
    await fs.writeFile(path.join(s.temp, 'answer.json'), JSON.stringify(await exampleAnswer()));
    session = await new PiEngine(s.config, { streamSimple: delegate }).session(s.temp, 'video-reviewer', 24, AbortSignal.timeout(3000), async () => {}, () => {});
    await session.prompt('Check whether this lesson has a browser preview.');
    const result = JSON.parse(observed.content[0].text);
    assert.equal(result.available, false); assert.match(result.reason, /No complete audio yet/);
  } finally { session?.dispose(); await s.cleanup(); }
});

test('request attempts recover transient errors, stop at the configured limit, and skip authentication errors', async t => {
  for (const scenario of [
    { name: 'recover', max: 3, fail: 2, message: '503 service unavailable', expected: 3, success: true },
    { name: 'exhaust', max: 2, fail: 9, message: '503 service unavailable', expected: 2, success: false },
    { name: 'disabled', max: 1, fail: 9, message: '503 service unavailable', expected: 1, success: false },
    { name: 'auth', max: 3, fail: 9, message: '401 invalid_api_key', expected: 1, success: false },
  ]) {
    await t.test(scenario.name, async () => {
      const s = await runtime({ LLM_MAX_ATTEMPTS: String(scenario.max) });
      let calls = 0, session: Awaited<ReturnType<PiEngine['session']>> | undefined;
      const events: { type: string; data: any }[] = [];
      try {
        const engine = new PiEngine(s.config, { streamSimple: plannedProvider(() => {
          if (++calls <= scenario.fail) throw new Error(scenario.message);
          return undefined;
        }) });
        session = await engine.session(s.temp, 'author', 24, AbortSignal.timeout(3000), async (type, data) => { events.push({ type, data }); });
        if (scenario.success) await session.prompt('Finish.');
        else await assert.rejects(session.prompt('Finish.'), { code: 'AGENT_RESPONSE_FAILED' });
        assert.equal(calls, scenario.expected);
        const retries = events.filter(e => e.type === 'agent.retry');
        assert.equal(retries.length, scenario.expected - 1);
        if (retries.length) assert.equal(retries[0].data.attempt, 2);
      } finally { session?.dispose(); await s.cleanup(); }
    });
  }
});

test('tool budget stops before an excess write and model budget stops before an excess request', async t => {
  for (const kind of ['tool', 'model'] as const) {
    await t.test(kind, async () => {
      const s = await runtime(kind === 'tool' ? { REASONFRAME_AGENT_MAX_TOOL_CALLS: '1' } : { REASONFRAME_AGENT_MAX_TURNS: '1' });
      let calls = 0, session: Awaited<ReturnType<PiEngine['session']>> | undefined;
      try {
        const engine = new PiEngine(s.config, { streamSimple: plannedProvider(() => ({ name: 'write_file', arguments: {
          path: ++calls === 1 ? 'src/style.css' : 'src/visual.js', content: '/* budget fixture */',
        } })) });
        session = await engine.session(s.temp, 'author', 24, AbortSignal.timeout(3000), async () => {});
        await assert.rejects(session.prompt('Keep writing.'), { code: kind === 'tool' ? 'AGENT_TOOL_LIMIT' : 'AGENT_TURN_LIMIT' });
        assert.equal(await fs.readFile(path.join(s.temp, 'src/style.css'), 'utf8'), '/* budget fixture */');
        await assert.rejects(fs.access(path.join(s.temp, 'src/visual.js')), { code: 'ENOENT' });
        assert.equal(calls, kind === 'tool' ? 2 : 1);
      } finally { session?.dispose(); await s.cleanup(); }
    });
  }
});
