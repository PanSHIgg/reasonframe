import path from 'node:path';
import { loadConfig, type Config as CoreConfig } from '../core/config.js';
import { PROJECT_ROOT } from '../core/paths.js';
import type { PhaseName } from './types.js';

export type StorageSettings =
  | { kind: 's3'; endpoint: string; bucket: string; accessKey: string; secretKey: string; region: string; useSSL: boolean }
  | { kind: 'local'; root: string };

export interface AiConfig {
  root: string;
  core: CoreConfig;
  grpcAddress: string;
  scratchDir: string;
  localInputDir: string;
  maxTasks: number;
  capabilities: Set<PhaseName>;
  timeouts: Record<PhaseName, number>;
  storage: StorageSettings;
  internalToken: string;
  keepScratch: boolean;
  maxScratchBytes: number;
}

interface LoadOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string) {
  if (value === undefined || !value.trim()) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return number;
}

function booleanValue(value: string | undefined, fallback: boolean, name: string) {
  if (value === undefined || !value.trim()) return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function capabilities(value: string | undefined): Set<PhaseName> {
  const all: PhaseName[] = ['author', 'prepare', 'render', 'ingest_audio'];
  if (!value || !value.trim()) return new Set(all);
  const aliases: Record<string, PhaseName> = {
    author: 'author', prepare: 'prepare', render: 'render', ingest_audio: 'ingest_audio',
    ingest: 'ingest_audio', 'ingest-audio': 'ingest_audio', audio: 'ingest_audio',
  };
  const selected = new Set<PhaseName>();
  for (const part of value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)) {
    const phase = aliases[part];
    if (!phase) throw new Error(`AI_CAPABILITIES contains unknown capability: ${part}`);
    selected.add(phase);
  }
  if (!selected.size) throw new Error('AI_CAPABILITIES must contain at least one capability');
  return selected;
}

function storageSettings(env: NodeJS.ProcessEnv, scratchDir: string): StorageSettings {
  const mode = (env.AI_OBJECT_STORE || '').trim().toLowerCase();
  const endpoint = (env.S3_ENDPOINT || '').trim().replace(/\/+$/, '');
  const bucket = (env.S3_BUCKET || '').trim();
  const accessKey = (env.S3_ACCESS_KEY || '').trim();
  const secretKey = (env.S3_SECRET_KEY || '').trim();
  const s3Configured = Boolean(endpoint && bucket && accessKey && secretKey);
  const partialS3 = Boolean(endpoint || bucket || accessKey || secretKey);
  if (mode !== 'local' && partialS3 && !s3Configured) throw new Error('S3 storage configuration is incomplete; set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY');
  if (mode === 'local' || (!s3Configured && mode !== 's3')) {
    return { kind: 'local', root: path.resolve(PROJECT_ROOT, env.LOCAL_OBJECT_STORE || path.join('.reasonframe', 'ai-objects')) };
  }
  if (!s3Configured) throw new Error('S3 storage requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY');
  const useSSL = booleanValue(env.S3_USE_SSL, !/^http:\/\//i.test(endpoint), 'S3_USE_SSL');
  return {
    kind: 's3',
    endpoint: /^https?:\/\//i.test(endpoint) ? endpoint : `${useSSL ? 'https' : 'http'}://${endpoint}`,
    bucket,
    accessKey,
    secretKey,
    region: env.S3_REGION || 'us-east-1',
    useSSL,
  };
}

export async function loadAiConfig(options: LoadOptions = {}): Promise<AiConfig> {
  const root = options.root ?? PROJECT_ROOT;
  const env = options.env ?? process.env;
  const core = await loadConfig({ root, env });
  const scratchDir = path.resolve(root, env.SCRATCH_DIR || path.join('.reasonframe', 'ai-scratch'));
  const localInputDir = path.resolve(root, env.LOCAL_INPUT_DIR || core.stateDir);
  const capabilitiesValue = capabilities(env.AI_CAPABILITIES);
  const timeouts: Record<PhaseName, number> = {
    author: integer(env.TASK_TIMEOUT_AUTHOR_MS, 20 * 60_000, 1000, 24 * 3600_000, 'TASK_TIMEOUT_AUTHOR_MS'),
    prepare: integer(env.TASK_TIMEOUT_PREPARE_MS, 15 * 60_000, 1000, 24 * 3600_000, 'TASK_TIMEOUT_PREPARE_MS'),
    render: integer(env.TASK_TIMEOUT_RENDER_MS, 45 * 60_000, 1000, 24 * 3600_000, 'TASK_TIMEOUT_RENDER_MS'),
    ingest_audio: integer(env.TASK_TIMEOUT_INGEST_AUDIO_MS, 5 * 60_000, 1000, 24 * 3600_000, 'TASK_TIMEOUT_INGEST_AUDIO_MS'),
  };
  return {
    root,
    core,
    grpcAddress: env.GRPC_LISTEN_ADDR || '127.0.0.1:50051',
    scratchDir,
    localInputDir,
    maxTasks: integer(env.AI_MAX_TASKS, 2, 1, 64, 'AI_MAX_TASKS'),
    capabilities: capabilitiesValue,
    timeouts,
    storage: storageSettings(env, scratchDir),
    internalToken: env.AI_INTERNAL_TOKEN || '',
    keepScratch: booleanValue(env.AI_KEEP_SCRATCH, false, 'AI_KEEP_SCRATCH'),
    maxScratchBytes: integer(env.MAX_SCRATCH_BYTES, 4_000_000_000, 1_000_000, 1_000_000_000_000, 'MAX_SCRATCH_BYTES'),
  };
}

export function publicAiConfig(config: AiConfig) {
  return {
    grpcAddress: config.grpcAddress,
    scratchDir: config.scratchDir,
    maxTasks: config.maxTasks,
    capabilities: [...config.capabilities],
    storage: config.storage.kind === 's3'
      ? { kind: 's3', endpoint: config.storage.endpoint, bucket: config.storage.bucket, region: config.storage.region, useSSL: config.storage.useSSL }
      : { kind: 'local', root: config.storage.root },
    modelConfigured: Boolean(config.core.llm),
    ttsConfigured: Boolean(config.core.tts),
  };
}
