import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  llmProfileForAttempt, loadConfig, profileForAttempt, publicConfig,
} from '../core/config.js';
import { PROJECT_ROOT } from '../core/paths.js';

function baseConfig() {
  return {
    providers: {
      opencode: {
        endpoint: 'completions',
        url: 'https://opencode.ai/inference/go/openai/v1',
        apiKeyEnv: 'LLM_API_KEY',
      },
    },
    models: [
      { provider: 'opencode', model: 'deepseek-v4.1-flash', contextWindow: 1000000, maxTokens: 262144, thinkingLevel: 'low' },
      { provider: 'opencode', model: 'minimax-m3.1-flash', contextWindow: 1000000, maxTokens: 524288, thinkingLevel: 'low' },
    ],
  };
}

async function tempRoot() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'reasonframe-llm-config-'));
  const root = path.join(base, 'ai-service');
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function writeConfig(root: string, value: unknown) {
  const deploy = path.join(path.dirname(root), 'deploy');
  await fs.mkdir(deploy, { recursive: true });
  await fs.writeFile(path.join(deploy, 'llm_config.json'), JSON.stringify(value));
}

function cleanupRoot(root: string) {
  return fs.rm(path.dirname(root), { recursive: true, force: true });
}

test('loads ordered typed profiles from deploy/llm_config.json', async () => {
  const root = await tempRoot();
  try {
    await writeConfig(root, baseConfig());
    const config = await loadConfig({ root, env: { LLM_API_KEY: 'file-secret' } });
    assert.equal(config.llmProfiles.length, 2);
    assert.deepEqual(config.llmProfiles.map(profile => ({
      provider: profile.provider, model: profile.model, endpoint: profile.endpoint, url: profile.url,
      contextWindow: profile.contextWindow, maxTokens: profile.maxTokens, thinkingLevel: profile.thinkingLevel,
    })), [
      { provider: 'opencode', model: 'deepseek-v4.1-flash', endpoint: 'completions', url: 'https://opencode.ai/inference/go/openai/v1', contextWindow: 1000000, maxTokens: 262144, thinkingLevel: 'low' },
      { provider: 'opencode', model: 'minimax-m3.1-flash', endpoint: 'completions', url: 'https://opencode.ai/inference/go/openai/v1', contextWindow: 1000000, maxTokens: 524288, thinkingLevel: 'low' },
    ]);
    assert.equal(config.llm?.model, 'deepseek-v4.1-flash');
    assert.equal(config.llm?.apiKey, 'file-secret');
    const visible = publicConfig(config);
    assert.equal(visible.models.length, 2);
    assert.equal(visible.models[1]?.model, 'minimax-m3.1-flash');
    assert(!JSON.stringify(visible).includes('file-secret'));
  } finally { await cleanupRoot(root); }
});

test('the repository deploy/llm_config.json contains the expected profiles', async () => {
  const config = await loadConfig({ root: PROJECT_ROOT, env: { LLM_API_KEY: 'test-key' } });
  assert.deepEqual(config.llmProfiles.map(profile => profile.model), ['longcat-2.5-preview-free', 'beam-free', 'minimax-m3.1-flash']);
  assert.equal(config.llmProfiles[0]?.contextWindow, 1000000);
  assert.equal(config.llmProfiles[0]?.maxTokens, 131072);
  assert.equal(config.llmProfiles[0]?.thinkingLevel, 'xhigh');
  assert.equal(config.llmProfiles[1]?.contextWindow, 1048576);
  assert.equal(config.llmProfiles[1]?.maxTokens, 131072);
  assert.equal(config.llmProfiles[2]?.contextWindow, 1000000);
});

test('LLM_CONFIG_PATH overrides the default file', async () => {
  const root = await tempRoot();
  try {
    await writeConfig(root, baseConfig());
    await fs.mkdir(path.join(root, 'config'), { recursive: true });
    await fs.writeFile(path.join(root, 'config', 'alt.json'), JSON.stringify({
      providers: { alt: { endpoint: 'messages', url: 'https://alt.example/v1', apiKeyEnv: 'ALT_KEY' } },
      models: [{ provider: 'alt', model: 'alt-model', contextWindow: 200000, maxTokens: 8192, thinkingLevel: 'high' }],
    }));
    const config = await loadConfig({ root, env: { LLM_API_KEY: 'file-secret', ALT_KEY: 'alt-secret', LLM_CONFIG_PATH: 'config/alt.json' } });
    assert.equal(config.llmProfiles.length, 1);
    assert.equal(config.llm?.provider, 'alt');
    assert.equal(config.llm?.model, 'alt-model');
    assert.equal(config.llm?.endpoint, 'messages');
    assert.equal(config.llm?.url, 'https://alt.example');
    assert.equal(config.llm?.apiKey, 'alt-secret');
    assert.equal(config.llm?.thinkingLevel, 'high');
  } finally { await cleanupRoot(root); }
});

test('legacy env-only LLM configuration applies only when no file exists', async () => {
  const root = await tempRoot();
  try {
    const env = {
      LLM_ENDPOINT: 'messages', LLM_URL: 'https://legacy.example/v1', LLM_API_KEY: 'legacy-secret',
      LLM_MODEL: 'legacy-model', LLM_CONTEXT_WINDOW: '64000', LLM_MAX_TOKENS: '4096', LLM_THINKING_LEVEL: 'high',
    };
    const legacy = await loadConfig({ root, env });
    assert.equal(legacy.llmProfiles.length, 1);
    assert.equal(legacy.llmProfiles[0]?.provider, 'env');
    assert.equal(legacy.llm?.model, 'legacy-model');
    assert.equal(legacy.llm?.endpoint, 'messages');
    assert.equal(legacy.llm?.contextWindow, 64000);
    assert.equal(legacy.llm?.maxTokens, 4096);
    assert.equal(legacy.llm?.thinkingLevel, 'high');

    await writeConfig(root, baseConfig());
    const file = await loadConfig({ root, env: {
      ...env, LLM_CONTEXT_WINDOW: '8192', LLM_MAX_TOKENS: '8192', LLM_THINKING_LEVEL: 'xhigh',
    } });
    assert.equal(file.llm?.endpoint, 'completions');
    assert.equal(file.llm?.url, 'https://opencode.ai/inference/go/openai/v1');
    assert.equal(file.llm?.model, 'legacy-model');
    assert.equal(file.llm?.contextWindow, 1000000);
    assert.equal(file.llm?.maxTokens, 262144);
    assert.equal(file.llm?.thinkingLevel, 'low');
  } finally { await cleanupRoot(root); }
});

test('LLM_MODEL debug override selects or renames the primary profile', async () => {
  const root = await tempRoot();
  try {
    await writeConfig(root, baseConfig());
    const selected = await loadConfig({ root, env: { LLM_API_KEY: 'file-secret', LLM_MODEL: 'minimax-m3.1-flash' } });
    assert.deepEqual(selected.llmProfiles.map(profile => profile.model), ['minimax-m3.1-flash', 'deepseek-v4.1-flash']);
    const renamed = await loadConfig({ root, env: { LLM_API_KEY: 'file-secret', LLM_MODEL: 'debug-model' } });
    assert.deepEqual(renamed.llmProfiles.map(profile => profile.model), ['debug-model', 'minimax-m3.1-flash']);
    assert.equal(renamed.llm?.provider, 'opencode');
    assert.equal(renamed.llm?.url, 'https://opencode.ai/inference/go/openai/v1');
    assert.equal(renamed.llm?.contextWindow, 1000000);
  } finally { await cleanupRoot(root); }
});

test('profile secrets come from apiKeyEnv and missing keys leave profiles unavailable', async () => {
  const root = await tempRoot();
  try {
    const document = baseConfig();
    document.providers.opencode.apiKeyEnv = 'OPENCODE_KEY';
    await writeConfig(root, document);
    const custom = await loadConfig({ root, env: { LLM_API_KEY: 'wrong-key', OPENCODE_KEY: 'custom-secret' } });
    assert.equal(custom.llm?.apiKey, 'custom-secret');
    const missing = await loadConfig({ root, env: {} });
    assert.equal(missing.llm, null);
    assert.deepEqual(missing.llmProfiles, []);
  } finally { await cleanupRoot(root); }
});

test('attempt selection uses order, cycles, and handles empty and invalid attempts', async () => {
  const root = await tempRoot();
  try {
    await writeConfig(root, baseConfig());
    const config = await loadConfig({ root, env: { LLM_API_KEY: 'file-secret' } });
    const profiles = config.llmProfiles;
    assert.equal(profileForAttempt(profiles, 0)?.model, 'deepseek-v4.1-flash');
    assert.equal(profileForAttempt(profiles, 1)?.model, 'minimax-m3.1-flash');
    assert.equal(profileForAttempt(profiles, 2)?.model, 'deepseek-v4.1-flash');
    assert.equal(profileForAttempt(profiles, 5)?.model, 'minimax-m3.1-flash');
    assert.equal(profileForAttempt(profiles, -1)?.model, 'deepseek-v4.1-flash');
    assert.equal(profileForAttempt(profiles, 1.9)?.model, 'minimax-m3.1-flash');
    assert.equal(profileForAttempt(profiles, Number.NaN)?.model, 'deepseek-v4.1-flash');
    assert.equal(profileForAttempt([], 0), null);
    assert.equal(profileForAttempt([profiles[0]], 9)?.model, 'deepseek-v4.1-flash');
    assert.equal(llmProfileForAttempt(config, 1)?.model, 'minimax-m3.1-flash');
  } finally { await cleanupRoot(root); }
});

test('invalid llm_config files fail startup', async () => {
  const root = await tempRoot();
  try {
    const cases: [unknown, RegExp][] = [
      [{ ...baseConfig(), models: [{ ...baseConfig().models[0], provider: 'missing' }] }, /unknown provider/],
      [{ ...baseConfig(), models: [] }, /Invalid LLM config/],
      [{ ...baseConfig(), extra: true }, /Invalid LLM config/],
      [{ ...baseConfig(), models: [...baseConfig().models, baseConfig().models[0]] }, /duplicate model/],
      [{ ...baseConfig(), providers: { opencode: { ...baseConfig().providers.opencode, endpoint: 'chat' } } }, /LLM_ENDPOINT/],
      [{ ...baseConfig(), providers: { opencode: { ...baseConfig().providers.opencode, url: 'https://user:pass@example.com/v1' } } }, /credentials/],
      [{ ...baseConfig(), models: [{ ...baseConfig().models[0], contextWindow: 100000, maxTokens: 100000 }] }, /less than contextWindow/],
      [{ ...baseConfig(), providers: { opencode: { ...baseConfig().providers.opencode, apiKeyEnv: 'NOT-VALID' } } }, /Invalid LLM config/],
    ];
    for (const [document, error] of cases) {
      await writeConfig(root, document);
      await assert.rejects(loadConfig({ root, env: { LLM_API_KEY: 'file-secret' } }), error);
    }
    await fs.writeFile(path.join(path.dirname(root), 'deploy', 'llm_config.json'), '{bad');
    await assert.rejects(loadConfig({ root, env: { LLM_API_KEY: 'file-secret' } }), /Invalid LLM config/);
    await assert.rejects(loadConfig({ root, env: { LLM_CONFIG_PATH: 'missing.json' } }), /not found/);
  } finally { await cleanupRoot(root); }
});
