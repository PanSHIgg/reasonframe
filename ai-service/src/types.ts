import { z } from 'zod';
import { JobInputSchema, WordTableSchema } from '../shared/schema.js';
import { PipelineError } from '../core/process.js';

export type TaskTypeName = 'AUTHOR' | 'PREPARE' | 'RENDER' | 'INGEST_AUDIO';
export type PhaseName = 'author' | 'prepare' | 'render' | 'ingest_audio';
export type ResultStatus = 'completed' | 'awaiting_audio' | 'failed' | 'retryable';
export type PhaseStatus = 'pending' | 'running' | 'completed' | 'awaiting_audio' | 'failed' | 'retryable' | 'cancelled';

export interface ArtifactRecord {
  name: string;
  object_key: string;
  work_key?: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
}

export interface ReviewBinding {
  object_key?: string;
  sha256?: string;
  approved: boolean;
  kind?: 'answer' | 'video';
  prompt_sha256?: string;
  source_sha256?: string;
  answer_sha256?: string;
  script_sha256?: string;
}

export interface AuxiliaryFile {
  object_key: string;
  path: string;
  sha256: string;
  size_bytes?: number;
}

export interface RepairRequest {
  requested: boolean;
  failed_phase?: string;
  reason?: string;
  message?: string;
}

export interface Checkpoint {
  schema_version: number;
  job_id: string;
  phase: PhaseName | 'done';
  phase_status: Record<string, PhaseStatus>;
  source_sha256?: string;
  script_sha256?: string;
  answer_sha256?: string;
  audio_sha256?: string;
  timeline_sha256?: string;
  video_sha256?: string;
  build_sha256?: string;
  image_sha256?: string[];
  review?: ReviewBinding;
  answer_review?: ReviewBinding;
  video_review?: ReviewBinding;
  artifacts: ArtifactRecord[];
  auxiliary: AuxiliaryFile[];
  error?: { code: string; message: string };
  repair?: RepairRequest;
  cache?: { tts_key?: string; render_key?: string };
  updated_at: string;
}

export interface UsageTotals {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  audio_chars: number;
  render_seconds: number;
  cost_micros: number;
}

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

export interface ImageRef {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  objectKey?: string;
  sha256?: string;
  sizeBytes?: number;
  base64?: string;
  path?: string;
  fileName?: string;
}

export interface BinaryRef {
  objectKey?: string;
  sha256?: string;
  sizeBytes?: number;
  mimeType?: string;
  base64?: string;
  path?: string;
}

export interface TaskSpec {
  schemaVersion: number;
  jobId: string;
  input?: z.infer<typeof JobInputSchema>;
  imageRefs: ImageRef[];
  inputObjectKey?: string;
  audio?: BinaryRef;
  words?: BinaryRef | z.infer<typeof WordTableSchema>;
  artifactVersion?: string;
  repair?: boolean;
  raw: Record<string, unknown>;
}

export interface RunTaskRequestParsed {
  taskId: string;
  jobId: string;
  type: TaskTypeName;
  attempt: number;
  autoRepairs: number;
  spec: TaskSpec;
  checkpoint: Checkpoint;
  trace: Record<string, unknown>;
  deadlineUnixMs: number;
}

export interface PhaseResult {
  status: ResultStatus;
  checkpoint: Checkpoint;
  errorCode?: string;
  errorMessage?: string;
  repairable: boolean;
  artifacts: ArtifactRecord[];
  usage: UsageTotals;
}

export interface TaskFailure {
  code: string;
  message: string;
  repairable: boolean;
  retryable: boolean;
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const imageRefSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  objectKey: z.string().min(1).optional(),
  object_key: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  sha256: sha256Schema.optional(),
  sizeBytes: z.number().int().positive().optional(),
  size_bytes: z.number().int().positive().optional(),
  base64: z.string().optional(),
  path: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  file_name: z.string().min(1).optional(),
}).passthrough();

const binaryRefSchema = z.object({
  objectKey: z.string().min(1).optional(),
  object_key: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  sha256: sha256Schema.optional(),
  sizeBytes: z.number().int().positive().optional(),
  size_bytes: z.number().int().positive().optional(),
  mimeType: z.string().optional(),
  mime_type: z.string().optional(),
  base64: z.string().optional(),
  path: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
}).passthrough();

const inputCoreSchema = JobInputSchema.omit({ images: true });
const specInputSchema = inputCoreSchema.extend({
  images: z.array(imageRefSchema).max(4).default([]),
});

const specSchema = z.object({
  schemaVersion: z.number().int().positive().optional(),
  schema_version: z.number().int().positive().optional(),
  jobId: z.string().min(1).optional(),
  job_id: z.string().min(1).optional(),
  input: z.unknown().optional(),
  inputObjectKey: z.string().min(1).optional(),
  input_object_key: z.string().min(1).optional(),
  audio: z.unknown().optional(),
  words: z.unknown().optional(),
  audioObjectKey: z.string().min(1).optional(),
  audio_object_key: z.string().min(1).optional(),
  wordsObjectKey: z.string().min(1).optional(),
  words_object_key: z.string().min(1).optional(),
  artifactVersion: z.string().min(1).optional(),
  artifact_version: z.string().min(1).optional(),
  repair: z.boolean().optional(),
}).passthrough();

const mimeExtension = (mimeType: string) => mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1] ?? 'bin';

function optionalString(raw: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function optionalNumber(raw: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function normalizeBinaryRef(value: unknown): BinaryRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (/^[a-f0-9]{64}$/.test(value)) return { sha256: value };
    return { objectKey: value };
  }
  const parsed = binaryRefSchema.safeParse(value);
  if (!parsed.success) throw new PipelineError('INVALID_SPEC', `Invalid binary reference: ${parsed.error.message}`);
  const raw = parsed.data;
  const ref = {
    objectKey: raw.objectKey ?? raw.object_key ?? raw.key,
    sha256: raw.sha256,
    sizeBytes: raw.sizeBytes ?? raw.size_bytes,
    mimeType: raw.mimeType ?? raw.mime_type,
    base64: raw.base64,
    path: raw.path ?? raw.file,
  };
  return ref.objectKey || ref.sha256 || ref.base64 || ref.path ? ref : undefined;
}

function normalizeAudioPair(value: unknown): { audio?: BinaryRef; words?: BinaryRef } {
  if (value === undefined || value === null) return {};
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!raw) return { audio: normalizeBinaryRef(value) };
  return {
    audio: normalizeBinaryRef(raw.audio)
      ?? normalizeBinaryRef(raw.audioObjectKey ?? raw.audio_object_key)
      ?? normalizeBinaryRef(raw.objectKey ?? raw.object_key ?? raw.key),
    words: normalizeBinaryRef(raw.words)
      ?? normalizeBinaryRef(raw.wordsObjectKey ?? raw.words_object_key),
  };
}

function normalizeImages(raw: z.infer<typeof imageRefSchema>[], jobId: string): ImageRef[] {
  return raw.map((image, index) => {
    const objectKey = image.objectKey ?? image.object_key ?? image.key;
    const fileName = image.fileName ?? image.file_name;
    const fallbackKey = objectKey ?? (!image.base64 && !image.path && !image.file
      ? `jobs/${jobId}/input/${fileName ?? `problem-${index + 1}.${mimeExtension(image.mimeType)}`}`
      : undefined);
    return {
      mimeType: image.mimeType,
      objectKey: fallbackKey,
      sha256: image.sha256,
      sizeBytes: image.sizeBytes ?? image.size_bytes,
      base64: image.base64,
      path: image.path,
      fileName,
    };
  });
}

export function parseTaskSpec(bytes: Uint8Array | Buffer | undefined, jobId: string): TaskSpec {
  const text = bytes ? Buffer.from(bytes).toString('utf8') : '';
  if (!text.trim()) throw new PipelineError('INVALID_SPEC', 'spec_json is required');
  if (Buffer.byteLength(text) > 64_000_000) throw new PipelineError('INVALID_SPEC', 'spec_json exceeds 64 MB');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) { throw new PipelineError('INVALID_SPEC', `spec_json is not valid JSON: ${(error as Error).message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PipelineError('INVALID_SPEC', 'spec_json must be a JSON object');
  let parsed: z.infer<typeof specSchema>;
  try { parsed = specSchema.parse(raw); }
  catch (error) { throw new PipelineError('INVALID_SPEC', `Invalid spec_json: ${(error as Error).message}`); }
  if (parsed.jobId && parsed.jobId !== jobId) throw new PipelineError('INVALID_SPEC', `spec jobId ${parsed.jobId} does not match request job_id ${jobId}`);
  const rawInput = parsed.input ?? (Object.hasOwn(raw as object, 'problem') ? raw : undefined);
  let input: z.infer<typeof JobInputSchema> | undefined;
  let nestedAudio: unknown;
  let nestedWords: unknown;
  if (rawInput !== undefined) {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      throw new PipelineError('INVALID_SPEC', 'input must be a JSON object');
    }
    const { audio, words, ...inputOnly } = rawInput as Record<string, unknown>;
    nestedAudio = audio;
    nestedWords = words;
    const candidate = specInputSchema.safeParse(inputOnly);
    if (!candidate.success) throw new PipelineError('INVALID_SPEC', `Invalid canonical input: ${candidate.error.message}`);
    const { images, ...core } = candidate.data;
    input = { ...inputCoreSchema.parse(core), images: [] };
    const nested = normalizeAudioPair(nestedAudio);
    return {
      schemaVersion: parsed.schemaVersion ?? parsed.schema_version ?? 1,
      jobId,
      input,
      imageRefs: normalizeImages(images, jobId),
      inputObjectKey: parsed.inputObjectKey ?? parsed.input_object_key,
      audio: normalizeBinaryRef(parsed.audio) ?? normalizeBinaryRef(parsed.audioObjectKey ?? parsed.audio_object_key) ?? nested.audio,
      words: normalizeSpecWords(parsed.words) ?? normalizeSpecWords(parsed.wordsObjectKey ?? parsed.words_object_key)
        ?? normalizeSpecWords(nestedWords) ?? nested.words,
      artifactVersion: parsed.artifactVersion ?? parsed.artifact_version,
      repair: parsed.repair,
      raw: raw as Record<string, unknown>,
    };
  }
  return {
    schemaVersion: parsed.schemaVersion ?? parsed.schema_version ?? 1,
    jobId,
    imageRefs: [],
    inputObjectKey: parsed.inputObjectKey ?? parsed.input_object_key,
    audio: normalizeBinaryRef(parsed.audio) ?? normalizeBinaryRef(parsed.audioObjectKey ?? parsed.audio_object_key),
    words: normalizeSpecWords(parsed.words) ?? normalizeSpecWords(parsed.wordsObjectKey ?? parsed.words_object_key),
    artifactVersion: parsed.artifactVersion ?? parsed.artifact_version,
    repair: parsed.repair,
    raw: raw as Record<string, unknown>,
  };
}

function normalizeSpecWords(value: unknown): BinaryRef | z.infer<typeof WordTableSchema> | undefined {
  if (value === undefined || value === null) return undefined;
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (candidate && Array.isArray(candidate.words)) {
    const table = WordTableSchema.safeParse(value);
    if (!table.success) throw new PipelineError('WORD_TABLE_INVALID', `Invalid inline word table: ${table.error.message}`);
    return table.data;
  }
  const table = WordTableSchema.safeParse(value);
  if (table.success) return table.data;
  return normalizeBinaryRef(value);
}

export function normalizeTaskType(value: unknown): TaskTypeName {
  const names: Record<string, TaskTypeName> = { AUTHOR: 'AUTHOR', PREPARE: 'PREPARE', RENDER: 'RENDER', INGEST_AUDIO: 'INGEST_AUDIO' };
  if (typeof value === 'string' && names[value]) return names[value];
  const numbers: Record<number, TaskTypeName> = { 1: 'AUTHOR', 2: 'PREPARE', 3: 'RENDER', 4: 'INGEST_AUDIO' };
  if (typeof value === 'number' && numbers[value]) return numbers[value];
  throw new PipelineError('INVALID_TASK_TYPE', `Unsupported task type: ${String(value)}`);
}

export function phaseForTask(type: TaskTypeName): PhaseName {
  return { AUTHOR: 'author', PREPARE: 'prepare', RENDER: 'render', INGEST_AUDIO: 'ingest_audio' }[type] as PhaseName;
}

export function timestampNow() { return new Date().toISOString(); }

export function isRetryableCode(code: string): boolean {
  return new Set([
    'TASK_TIMEOUT', 'DEADLINE_EXCEEDED', 'TIMEOUT', 'COMMAND_FAILED', 'TTS_FAILED',
    'TTS_RESPONSE_TOO_LARGE', 'STORAGE_ERROR', 'STORAGE_INTEGRITY', 'NETWORK_ERROR',
    'RENDER_FAILED', 'VIDEO_CHECK_FAILED', 'SCRATCH_QUOTA_EXCEEDED', 'MODEL_UNAVAILABLE',
  ]).has(code);
}

export function isRepairableCode(code: string): boolean {
  return ['VISUAL_CHECK_FAILED', 'HYPERFRAMES_CHECK_FAILED', 'INVALID_AUDIO', 'WORD_TABLE_INVALID', 'STALE_AUDIO',
    'VIDEO_QUALITY_GATE_FAILED', 'ANSWER_REVISION_REQUIRED'].includes(code);
}

export function isModelUnavailable(message: string): boolean {
  return /(?:http(?: status)?\s*|status\s*|error\s*|code\s*|failed:\s*)(?:402|403|429|500|502|503|504)\b|\b(?:402|403|429|500|502|503|504)\s+(?:upstream|request|response|error|status|too many|service|bad gateway)/i.test(message)
    || /endpoint is unavailable|upstream request failed|rate.?limit|too many requests|overloaded|model[^\n]{0,80}(?:not found|not available|unavailable)|not available in your country|regionerror|insufficient (?:balance|quota)|quota exceeded|connection (?:error|refused|reset|closed|timed out)|fetch failed|network error|socket hang up|temporarily unavailable|service unavailable/i.test(message);
}

export function classifyFailure(error: unknown): TaskFailure {
  if (error instanceof PipelineError) {
    const message = error.message.slice(0, 10_000);
    const modelUnavailable = error.code !== 'MODEL_UNAVAILABLE' && isModelUnavailable(message);
    const code = modelUnavailable ? 'MODEL_UNAVAILABLE' : error.code;
    return { code, message, repairable: isRepairableCode(code), retryable: isRetryableCode(code) };
  }
  if (error instanceof Error) {
    const candidate = error as Error & { code?: string; status?: number; statusCode?: number; $metadata?: { httpStatusCode?: number } };
    const message = error.message.slice(0, 10_000);
    const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
    const network = Boolean(candidate.code && ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND'].includes(candidate.code));
    const storage = Boolean((candidate.$metadata?.httpStatusCode ?? 0) >= 500 || /^(S3|Networking|Timeout)/i.test(error.name));
    const modelUnavailable = isModelUnavailable(message) || [candidate.status, candidate.statusCode, candidate.$metadata?.httpStatusCode].some(status => status === 402 || status === 403 || status === 429 || (typeof status === 'number' && status >= 500));
    const code = modelUnavailable ? 'MODEL_UNAVAILABLE' : timeout ? 'TASK_TIMEOUT' : network || storage ? 'STORAGE_ERROR' : 'INTERNAL';
    const retryable = code === 'MODEL_UNAVAILABLE' || timeout || network || storage;
    return { code, message: timeout ? 'Task timed out or was aborted' : message, repairable: false, retryable };
  }
  return { code: 'INTERNAL', message: String(error).slice(0, 10_000), repairable: false, retryable: false };
}
