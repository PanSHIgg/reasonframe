import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeModelUrl, endpointType, loadConfig, publicConfig } from '../core/config.js';
import { setup } from './helpers.js';

test('all three endpoint types preserve gateway prefixes and accept full standard URLs', () => {
  const cases = [
    ['responses', 'https://gateway.example/prefix/v1/responses', 'https://gateway.example/prefix/v1'],
    ['completions', 'https://gateway.example/prefix/v1/chat/completions', 'https://gateway.example/prefix/v1'],
    ['messages', 'https://gateway.example/prefix/v1/messages', 'https://gateway.example/prefix'],
    ['messages', 'https://api.anthropic.com/v1', 'https://api.anthropic.com'],
    ['messages', 'https://gateway.example/anthropic', 'https://gateway.example/anthropic'],
    ['responses', 'http://localhost:9000/v1/', 'http://localhost:9000/v1'],
  ] as const;
  for (const [kind, url, expected] of cases) assert.equal(normalizeModelUrl(kind, url), expected);
  assert.equal(endpointType('anthropic-messages'), 'messages');
  assert.throws(() => normalizeModelUrl('completions', 'https://example.com/v1/completions'), /legacy/);
  assert.throws(() => normalizeModelUrl('responses', 'https://user:secret@example.com/v1'), /credentials/);
  assert.throws(() => endpointType('invalid'), /LLM_ENDPOINT/);
});
test('env overrides the JSON config and public config never includes API keys', async () => {
  const s = await setup();
  try {
    await fs.writeFile(path.join(s.temp, 'reasonframe.config.json'), JSON.stringify({ llm: { endpoint: 'messages', url: 'https://example.com/v1/messages', apiKey: 'server-secret', model: 'file-model' } }));
    const config = await loadConfig({ root: s.temp, env: { LLM_MODEL: 'env-model' } });
    assert.equal(config.llm?.model, 'env-model'); assert.equal(config.llm?.url, 'https://example.com');
    assert(!JSON.stringify(publicConfig(config)).includes('server-secret'));
    const empty = await loadConfig({ root: s.temp, env: { LLM_API_KEY: '' } }); assert.equal(empty.llm, null);
  } finally { await s.cleanup(); }
});

test('model and agent budgets support JSON, env overrides, and safe public inspection', async () => {
  const s = await setup();
  try {
    await fs.writeFile(path.join(s.temp, 'reasonframe.config.json'), JSON.stringify({
      llm: { endpoint: 'messages', url: 'https://example.com', apiKey: 'private-key', model: 'file-model',
        contextWindow: 64000, maxTokens: 4096, requestTimeoutMs: 90000, maxAttempts: 4, retryDelayMs: 500, thinkingLevel: 'low', temperature: 0.4 },
      agent: { timeoutMs: 300000, maxAttempts: 2, maxToolCalls: 24, maxTurns: 12, visualMaxRepairAttempts: 0 },
      render: { timeoutMs: 900000, workers: 3, bitrate: '8M' }, server: { concurrency: 2 },
    }));
    const config = await loadConfig({ root: s.temp, env: { LLM_CONTEXT_WINDOW: '96000', LLM_MAX_TOKENS: '6144',
      LLM_REQUEST_TIMEOUT_MS: '45000', LLM_MAX_ATTEMPTS: '2', LLM_THINKING_LEVEL: 'medium', LLM_TEMPERATURE: '',
      REASONFRAME_AGENT_MAX_ATTEMPTS: '4', REASONFRAME_AGENT_MAX_TOOL_CALLS: '30', REASONFRAME_AGENT_MAX_TURNS: '15' } });
    assert.equal(config.llm?.contextWindow, 96000); assert.equal(config.llm?.maxTokens, 6144);
    assert.equal(config.llm?.requestTimeoutMs, 45000); assert.equal(config.llm?.maxAttempts, 2);
    assert.equal(config.llm?.retryDelayMs, 500); assert.equal(config.llm?.thinkingLevel, 'medium');
    assert.equal(config.llm?.temperature, undefined); assert.equal(config.maxRepairAttempts, 3);
    assert.equal(config.agentMaxToolCalls, 30); assert.equal(config.agentMaxTurns, 15);
    assert.equal(config.agentTimeoutMs, 300000); assert.equal(config.maxVisualRepairAttempts, 0);
    assert.equal(config.renderTimeoutMs, 900000); assert.equal(config.renderWorkers, 3); assert.equal(config.renderBitrate, '8M'); assert.equal(config.concurrency, 2);
    const visible = publicConfig(config);
    assert.equal(visible.agent.maxAttempts, 4); assert.equal(visible.model?.maxTokens, 6144); assert.equal(visible.render.bitrate, '8M');
    assert(!JSON.stringify(visible).includes('private-key')); assert(!JSON.stringify(visible).includes('apiKey'));
  } finally { await s.cleanup(); }
});

test('official MiniMax M3.1 Flash context and output limits are accepted', async () => {
  const s = await setup();
  try {
    const config = await loadConfig({ root: s.temp, env: {
      LLM_ENDPOINT: 'completions', LLM_URL: 'https://opencode.ai/inference/go/openai/v1',
      LLM_API_KEY: 'test-key', LLM_MODEL: 'minimax-m3.1-flash-free',
      LLM_CONTEXT_WINDOW: '1000000', LLM_MAX_TOKENS: '524288',
    } });
    assert.equal(config.llm?.contextWindow, 1000000);
    assert.equal(config.llm?.maxTokens, 524288);
    assert.equal(publicConfig(config).model?.maxTokens, 524288);
  } finally { await s.cleanup(); }
});

test('invalid budgets fail at startup, including without model credentials', async () => {
  const s = await setup();
  try {
    const invalid: [NodeJS.ProcessEnv, RegExp][] = [
      [{ LLM_CONTEXT_WINDOW: '8192', LLM_MAX_TOKENS: '8192' }, /less than/],
      [{ LLM_CONTEXT_WINDOW: '1000000', LLM_MAX_TOKENS: '524289' }, /LLM_MAX_TOKENS/],
      [{ LLM_MAX_TOKENS: '1.5' }, /LLM_MAX_TOKENS/],
      [{ LLM_REQUEST_TIMEOUT_MS: '0' }, /LLM_REQUEST_TIMEOUT_MS/],
      [{ LLM_MAX_ATTEMPTS: '0' }, /LLM_MAX_ATTEMPTS/],
      [{ LLM_RETRY_DELAY_MS: '-1' }, /LLM_RETRY_DELAY_MS/],
      [{ LLM_THINKING_LEVEL: 'turbo' }, /LLM_THINKING_LEVEL/],
      [{ LLM_TEMPERATURE: 'Infinity' }, /LLM_TEMPERATURE/],
      [{ REASONFRAME_AGENT_TIMEOUT_MS: '0' }, /REASONFRAME_AGENT_TIMEOUT_MS/],
      [{ REASONFRAME_AGENT_MAX_ATTEMPTS: '11' }, /REASONFRAME_AGENT_MAX_ATTEMPTS/],
      [{ REASONFRAME_AGENT_MAX_TOOL_CALLS: '0' }, /REASONFRAME_AGENT_MAX_TOOL_CALLS/],
      [{ REASONFRAME_AGENT_MAX_TURNS: '0' }, /REASONFRAME_AGENT_MAX_TURNS/],
      [{ REASONFRAME_RENDER_BITRATE: 'fast' }, /REASONFRAME_RENDER_BITRATE/],
      [{ REASONFRAME_VISUAL_MAX_REPAIR_ATTEMPTS: '-1' }, /REASONFRAME_VISUAL_MAX_REPAIR_ATTEMPTS/],
    ];
    for (const [env, error] of invalid) await assert.rejects(loadConfig({ root: s.temp, env }), error);
    await fs.writeFile(path.join(s.temp, 'reasonframe.config.json'), JSON.stringify({ agent: { maxAttemps: 3 } }));
    await assert.rejects(loadConfig({ root: s.temp, env: {} }), /maxAttemps/);
  } finally { await s.cleanup(); }
});

test('TTS provider supports direct Edge without a local service and validates HTTP URL', async () => {
  const s = await setup();
  try {
    const edge = await loadConfig({ root: s.temp, env: { TTS_PROVIDER: 'edge', TTS_VOICE: 'zh-CN-YunxiNeural' } });
    assert.equal(edge.tts?.provider, 'edge');
    assert.equal(edge.tts?.voice, 'zh-CN-YunxiNeural');
    assert.equal(edge.tts?.url, '');
    assert(edge.tts?.python.endsWith('.venv/bin/python'));
    await assert.rejects(loadConfig({ root: s.temp, env: { TTS_PROVIDER: 'http' } }), /TTS_URL/);
    const http = await loadConfig({ root: s.temp, env: { TTS_PROVIDER: 'http', TTS_URL: 'https://tts.example/synthesize' } });
    assert.equal(http.tts?.provider, 'http');
    assert.equal(http.tts?.url, 'https://tts.example/synthesize');
    const none = await loadConfig({ root: s.temp, env: {} });
    assert.equal(none.tts, null);
  } finally { await s.cleanup(); }
});
