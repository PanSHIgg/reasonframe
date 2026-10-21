import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PiEngine } from '../core/pi.js';
import { loadConfig, type Endpoint } from '../core/config.js';
import { PROJECT_ROOT } from '../core/paths.js';
import { setup } from './helpers.js';

const args = { path: 'src/style.css', content: '/* written through the real provider tool-call stream */' };
function chat(tool: boolean) {
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'write_file', arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'done' };
  return [{ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', model: 'configured-model', choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', model: 'configured-model', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}
function responses(tool: boolean) {
  const item = tool ? { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'write_file', arguments: JSON.stringify(args), status: 'completed' } : { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
  const events: any[] = [{ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', model: 'configured-model' } },
    { type: 'response.output_item.added', output_index: 0, item: tool ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } }];
  events.push(tool ? { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: JSON.stringify(args) } : { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'done' });
  events.push({ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', model: 'configured-model', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  return events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join('');
}
function messages(tool: boolean) {
  const events = [
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'configured-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'toolu_fixture', name: 'write_file', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
test('Responses, Chat Completions and Anthropic Messages each complete a real Pi file-tool round trip', async t => {
  for (const endpoint of ['responses', 'completions', 'messages'] as Endpoint[]) {
    await t.test(endpoint, async () => {
      const s = await setup(), oldFetch = globalThis.fetch;
      let session: Awaited<ReturnType<PiEngine['session']>> | undefined;
      try {
        const suffix = { responses: '/v1/responses', completions: '/v1/chat/completions', messages: '/v1/messages' }[endpoint];
        const config = await loadConfig({ root: PROJECT_ROOT, env: { REASONFRAME_STATE_DIR: s.temp, LLM_ENDPOINT: endpoint, LLM_URL: 'https://protocol-fixture.invalid/gateway' + suffix, LLM_API_KEY: 'protocol-fixture-key', LLM_MODEL: 'configured-model', LLM_MAX_TOKENS: '6144', LLM_TEMPERATURE: '0.3' } });
        const requests: { url: string; headers: Headers; body: any }[] = [];
        globalThis.fetch = (async (input: any, init: any) => {
          const req = new Request(input, init); requests.push({ url: req.url, headers: req.headers, body: await req.json() });
          const tool = requests.length === 1;
          return new Response(({ responses, completions: chat, messages })[endpoint](tool), { headers: { 'content-type': 'text/event-stream' } });
        }) as typeof fetch;
        const engine = new PiEngine(config);
        session = await engine.session(s.temp, 'author', 24, AbortSignal.timeout(15000), async () => {});
        await session.prompt('Use write_file to update src/style.css, then finish.');
        assert.equal(requests.length, 2); assert(requests.every(r => r.url === 'https://protocol-fixture.invalid/gateway' + suffix));
        assert(requests.every(r => r.body.model === 'configured-model' && r.body.stream === true));
        assert(requests.every(r => (r.body.max_output_tokens ?? r.body.max_completion_tokens ?? r.body.max_tokens) === 6144));
        assert(requests.every(r => r.body.temperature === 0.3));
        assert(requests.every(r => !r.headers.has('x-opencode-session')));
        assert(requests[0].body.tools.some((tool: any) => (tool.name ?? tool.function?.name) === 'write_file'));
        assert.equal(requests[0].headers.get(endpoint === 'messages' ? 'x-api-key' : 'authorization'), endpoint === 'messages' ? 'protocol-fixture-key' : 'Bearer protocol-fixture-key');
        assert.equal(await fs.readFile(path.join(s.temp, 'src/style.css'), 'utf8'), args.content);
        assert(JSON.stringify(requests[1].body).includes(endpoint === 'responses' ? 'function_call_output' : endpoint === 'messages' ? 'tool_result' : '"role":"tool"'));
      } finally { session?.dispose(); globalThis.fetch = oldFetch; await s.cleanup(); }
    });
  }
});

test('OpenCode uses the real Pi session ID and its own user agent across file-tool requests', async () => {
  const s = await setup(), oldFetch = globalThis.fetch;
  const seen: Headers[] = [];
  let session: Awaited<ReturnType<PiEngine['session']>> | undefined;
  try {
    const config = await loadConfig({ root: s.temp, env: {
      LLM_ENDPOINT: 'completions', LLM_URL: 'https://opencode.ai/inference/go/openai/v1',
      LLM_API_KEY: 'protocol-fixture-key', LLM_MODEL: 'minimax-m3.1-flash-free',
    } });
    globalThis.fetch = (async (input: any, init: any) => {
      const request = new Request(input, init); seen.push(request.headers);
      return new Response(chat(seen.length % 2 === 1), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const engine = new PiEngine(config);
    for (let i = 0; i < 2; i++) {
      session = await engine.session(s.temp, 'author', 24, AbortSignal.timeout(3000), async () => {});
      await session.prompt('Write the stylesheet and finish.');
      session.dispose(); session = undefined;
    }
    assert.equal(seen.length, 4);
    assert(seen.every(headers => headers.get('user-agent')?.startsWith('reasonframe/')));
    assert(seen.every(headers => headers.get('x-opencode-session')));
    assert.equal(seen[0].get('x-opencode-session'), seen[1].get('x-opencode-session'));
    assert.equal(seen[2].get('x-opencode-session'), seen[3].get('x-opencode-session'));
    assert.notEqual(seen[0].get('x-opencode-session'), seen[2].get('x-opencode-session'));
  } finally { session?.dispose(); globalThis.fetch = oldFetch; await s.cleanup(); }
});

test('all three protocol SDKs apply HTTP timeout with no hidden extra retries', async t => {
  for (const endpoint of ['responses', 'completions', 'messages'] as Endpoint[]) {
    await t.test(endpoint, async () => {
      const s = await setup(), oldFetch = globalThis.fetch;
      let calls = 0, session: Awaited<ReturnType<PiEngine['session']>> | undefined;
      try {
        const config = await loadConfig({ root: s.temp, env: {
          LLM_ENDPOINT: endpoint, LLM_URL: 'https://timeout-fixture.invalid', LLM_API_KEY: 'timeout-fixture-key', LLM_MODEL: 'configured-model',
          LLM_REQUEST_TIMEOUT_MS: '100', LLM_MAX_ATTEMPTS: '2', LLM_RETRY_DELAY_MS: '0',
        } });
        globalThis.fetch = ((input: any, init: any) => {
          calls++; const request = new Request(input, init);
          return new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(request.signal.reason);
            if (request.signal.aborted) abort();
            else request.signal.addEventListener('abort', abort, { once: true });
          });
        }) as typeof fetch;
        session = await new PiEngine(config).session(s.temp, 'author', 24, AbortSignal.timeout(3000), async () => {});
        await assert.rejects(session.prompt('Complete this request.'), (error: any) => error.code === 'AGENT_RESPONSE_FAILED' && /timed?\s*out|timeout/i.test(error.message));
        assert.equal(calls, 2, 'initial request plus one Pi retry, with SDK retries disabled');
      } finally { session?.dispose(); globalThis.fetch = oldFetch; await s.cleanup(); }
    });
  }
});
