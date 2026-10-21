import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PROJECT_ROOT } from './paths.js';
export type Endpoint = 'responses' | 'completions' | 'messages';
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ThinkingLevel = typeof thinkingLevels[number];
export const MODEL_DEFAULTS = {
  contextWindow: 128000, maxTokens: 8192, requestTimeoutMs: 120000,
  maxAttempts: 3, retryDelayMs: 1000, thinkingLevel: 'off' as ThinkingLevel,
};
export interface ModelConfig {
  endpoint: Endpoint; url: string; apiKey: string; model: string;
  contextWindow: number; maxTokens: number; requestTimeoutMs: number;
  maxAttempts: number; retryDelayMs: number; thinkingLevel: ThinkingLevel; temperature?: number;
}
export interface Config {
  root: string; stateDir: string; host: string; port: number; serviceApiKey: string;
  llm: ModelConfig | null; tts: { provider: 'edge' | 'http'; url: string; apiKey: string; voice: string; python: string } | null;
  concurrency: number; renderWorkers: number; renderBitrate: string; browserPath?: string;
  agentTimeoutMs: number; agentMaxToolCalls: number; agentMaxTurns: number;
  renderTimeoutMs: number; maxRepairAttempts: number; maxVisualRepairAttempts: number;
}
const fileSchema = z.object({
  llm: z.object({
    endpoint: z.string(), url: z.string(), apiKey: z.string(), model: z.string(),
    contextWindow: z.number(), maxTokens: z.number(), requestTimeoutMs: z.number(),
    maxAttempts: z.number(), retryDelayMs: z.number(), thinkingLevel: z.enum(thinkingLevels), temperature: z.number(),
  }).partial().strict().optional(),
  agent: z.object({ timeoutMs: z.number(), maxAttempts: z.number(), maxToolCalls: z.number(), maxTurns: z.number(), visualMaxRepairAttempts: z.number() }).partial().strict().optional(),
  render: z.object({ timeoutMs: z.number(), workers: z.number(), bitrate: z.string() }).partial().strict().optional(),
  tts: z.object({ provider: z.enum(['edge', 'http']), url: z.string(), apiKey: z.string(), voice: z.string(), python: z.string() }).partial().strict().optional(),
  server: z.object({ host: z.string(), port: z.number(), apiKey: z.string(), concurrency: z.number() }).partial().strict().optional(),
}).strict();
export function endpointType(value: string): Endpoint {
  const mapping: Record<string, Endpoint> = { responses: 'responses', 'openai-responses': 'responses', completions: 'completions', 'openai-completions': 'completions', messages: 'messages', 'anthropic-messages': 'messages' };
  if (!mapping[value]) throw new Error('LLM_ENDPOINT must be responses, completions, or messages'); return mapping[value];
}
export function normalizeModelUrl(endpoint: Endpoint, value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('LLM_URL must be an http(s) base URL or standard endpoint URL without credentials, query or fragment');
  let p = url.pathname.replace(/\/+$/, '');
  if (endpoint === 'responses') p = p.replace(/\/responses$/, '');
  if (endpoint === 'completions') {
    if (/\/completions$/.test(p) && !/\/chat\/completions$/.test(p)) throw new Error('completions uses /chat/completions, not the legacy /completions API');
    p = p.replace(/\/chat\/completions$/, '');
  }
  if (endpoint === 'messages') p = p.replace(/\/v1\/messages$/, '').replace(/\/v1$/, '');
  url.pathname = p || '/'; return url.toString().replace(/\/$/, '');
}
function number(value: unknown, fallback: number, min: number, max: number, name: string) {
  const n = value === undefined || typeof value === 'string' && !value.trim() ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`); return n;
}
function temperature(value: unknown): number | undefined {
  if (value === undefined || typeof value === 'string' && !value.trim()) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error('LLM_TEMPERATURE must be a number in 0..2, or empty to use the model default');
  return n;
}
export async function loadConfig(options: { root?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Config> {
  const root = options.root ?? PROJECT_ROOT, env = options.env ?? process.env, file = path.resolve(root, env.REASONFRAME_CONFIG || 'reasonframe.config.json');
  let settings: z.infer<typeof fileSchema> = {};
  try { settings = fileSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || env.REASONFRAME_CONFIG) throw e; }
  const get = (name: string, fallback?: string) => env[name] ?? fallback ?? '';
  const fields = { endpoint: get('LLM_ENDPOINT', settings.llm?.endpoint), url: get('LLM_URL', settings.llm?.url), apiKey: get('LLM_API_KEY', settings.llm?.apiKey), model: get('LLM_MODEL', settings.llm?.model) };
  // Validate budgets even before credentials are supplied, so a bad setting fails at startup.
  const contextWindow = number(env.LLM_CONTEXT_WINDOW ?? settings.llm?.contextWindow, MODEL_DEFAULTS.contextWindow, 8192, 2_000_000, 'LLM_CONTEXT_WINDOW');
  const maxTokens = number(env.LLM_MAX_TOKENS ?? settings.llm?.maxTokens, MODEL_DEFAULTS.maxTokens, 1024, 524288, 'LLM_MAX_TOKENS');
  if (maxTokens >= contextWindow) throw new Error('LLM_MAX_TOKENS must be less than LLM_CONTEXT_WINDOW');
  const requestTimeoutMs = number(env.LLM_REQUEST_TIMEOUT_MS ?? settings.llm?.requestTimeoutMs, MODEL_DEFAULTS.requestTimeoutMs, 100, 3600000, 'LLM_REQUEST_TIMEOUT_MS');
  const maxAttempts = number(env.LLM_MAX_ATTEMPTS ?? settings.llm?.maxAttempts, MODEL_DEFAULTS.maxAttempts, 1, 10, 'LLM_MAX_ATTEMPTS');
  const retryDelayMs = number(env.LLM_RETRY_DELAY_MS ?? settings.llm?.retryDelayMs, MODEL_DEFAULTS.retryDelayMs, 0, 60000, 'LLM_RETRY_DELAY_MS');
  const thinkingLevel = get('LLM_THINKING_LEVEL', settings.llm?.thinkingLevel || MODEL_DEFAULTS.thinkingLevel);
  if (!thinkingLevels.includes(thinkingLevel as ThinkingLevel)) throw new Error('LLM_THINKING_LEVEL must be off, minimal, low, medium, high, or xhigh');
  const sampling = temperature(env.LLM_TEMPERATURE ?? settings.llm?.temperature);
  let llm: ModelConfig | null = null;
  if (fields.apiKey && fields.model && fields.url && fields.endpoint) {
    const endpoint = endpointType(fields.endpoint);
    if (endpoint === 'messages' && sampling !== undefined && sampling > 1) throw new Error('LLM_TEMPERATURE must be in 0..1 for Anthropic Messages');
    llm = { ...fields, endpoint, url: normalizeModelUrl(endpoint, fields.url), contextWindow, maxTokens,
      requestTimeoutMs, maxAttempts, retryDelayMs, thinkingLevel: thinkingLevel as ThinkingLevel, ...(sampling === undefined ? {} : { temperature: sampling }) };
  } else if (fields.model && fields.apiKey) throw new Error('Set all four LLM_ENDPOINT, LLM_URL, LLM_API_KEY, LLM_MODEL fields');
  const ttsUrl = get('TTS_URL', settings.tts?.url);
  if (ttsUrl && !['http:', 'https:'].includes(new URL(ttsUrl).protocol)) throw new Error('TTS_URL must use http(s)');
  const ttsProviderRaw = get('TTS_PROVIDER', settings.tts?.provider || (ttsUrl ? 'http' : ''));
  if (ttsProviderRaw && ttsProviderRaw !== 'edge' && ttsProviderRaw !== 'http') throw new Error('TTS_PROVIDER must be edge or http');
  const ttsVoice = get('TTS_VOICE', settings.tts?.voice || 'zh-CN-XiaoxiaoNeural');
  const ttsPython = get('TTS_PYTHON', settings.tts?.python || path.join(root, '.venv/bin/python'));
  const ttsConfigured = Boolean(ttsUrl || ttsProviderRaw || env.TTS_PROVIDER || settings.tts?.provider || env.TTS_VOICE || settings.tts?.voice);
  if (ttsConfigured && ttsProviderRaw === 'http' && !ttsUrl) throw new Error('TTS_URL is required when TTS_PROVIDER=http');
  const renderBitrate = get('REASONFRAME_RENDER_BITRATE', settings.render?.bitrate || '8M');
  if (!/^\d+(?:\.\d+)?[kKmM]$/.test(renderBitrate) || !(Number.parseFloat(renderBitrate) > 0)) throw new Error('REASONFRAME_RENDER_BITRATE must be a positive bitrate such as 8M or 8000k');
  return {
    root, stateDir: path.resolve(root, get('REASONFRAME_STATE_DIR', 'workspaces')), host: get('HOST', settings.server?.host || '127.0.0.1'),
    port: number(env.PORT ?? settings.server?.port, 4310, 0, 65535, 'PORT'), serviceApiKey: get('SERVICE_API_KEY', settings.server?.apiKey), llm,
    tts: ttsConfigured ? { provider: (ttsProviderRaw || 'edge') as 'edge' | 'http', url: ttsUrl, apiKey: get('TTS_API_KEY', settings.tts?.apiKey), voice: ttsVoice, python: ttsPython } : null,
    concurrency: number(env.REASONFRAME_CONCURRENCY ?? settings.server?.concurrency, 1, 1, 8, 'REASONFRAME_CONCURRENCY'),
    renderWorkers: number(env.REASONFRAME_RENDER_WORKERS ?? settings.render?.workers, 2, 1, 8, 'REASONFRAME_RENDER_WORKERS'), renderBitrate, browserPath: env.HYPERFRAMES_BROWSER_PATH || undefined,
    agentTimeoutMs: number(env.REASONFRAME_AGENT_TIMEOUT_MS ?? settings.agent?.timeoutMs, 600000, 1000, 3600000, 'REASONFRAME_AGENT_TIMEOUT_MS'),
    agentMaxToolCalls: number(env.REASONFRAME_AGENT_MAX_TOOL_CALLS ?? settings.agent?.maxToolCalls, 80, 1, 1000, 'REASONFRAME_AGENT_MAX_TOOL_CALLS'),
    agentMaxTurns: number(env.REASONFRAME_AGENT_MAX_TURNS ?? settings.agent?.maxTurns, 40, 1, 1000, 'REASONFRAME_AGENT_MAX_TURNS'),
    maxRepairAttempts: number(env.REASONFRAME_AGENT_MAX_ATTEMPTS ?? settings.agent?.maxAttempts, 3, 1, 10, 'REASONFRAME_AGENT_MAX_ATTEMPTS') - 1,
    maxVisualRepairAttempts: number(env.REASONFRAME_VISUAL_MAX_REPAIR_ATTEMPTS ?? settings.agent?.visualMaxRepairAttempts, 1, 0, 10, 'REASONFRAME_VISUAL_MAX_REPAIR_ATTEMPTS'),
    renderTimeoutMs: number(env.REASONFRAME_RENDER_TIMEOUT_MS ?? settings.render?.timeoutMs, 1800000, 1000, 7200000, 'REASONFRAME_RENDER_TIMEOUT_MS'),
  };
}
export function publicConfig(c: Config) {
  return {
    model: c.llm ? {
      endpoint: c.llm.endpoint, url: c.llm.url, model: c.llm.model, contextWindow: c.llm.contextWindow, maxTokens: c.llm.maxTokens,
      requestTimeoutMs: c.llm.requestTimeoutMs, maxAttempts: c.llm.maxAttempts, retryDelayMs: c.llm.retryDelayMs,
      thinkingLevel: c.llm.thinkingLevel, ...(c.llm.temperature === undefined ? {} : { temperature: c.llm.temperature }),
    } : null,
    agent: { timeoutMs: c.agentTimeoutMs, maxAttempts: c.maxRepairAttempts + 1, maxToolCalls: c.agentMaxToolCalls, maxTurns: c.agentMaxTurns, visualMaxRepairAttempts: c.maxVisualRepairAttempts },
    render: { workers: c.renderWorkers, timeoutMs: c.renderTimeoutMs, bitrate: c.renderBitrate },
    ttsConfigured: Boolean(c.tts), concurrency: c.concurrency, resolution: [1920, 1080], endpointTypes: ['responses', 'completions', 'messages'],
  };
}
