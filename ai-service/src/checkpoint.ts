import { PipelineError } from '../core/process.js';
import type { ArtifactRecord, AuxiliaryFile, Checkpoint, PhaseName, PhaseStatus, RepairRequest, ReviewBinding } from './types.js';

const phaseNames: PhaseName[] = ['author', 'prepare', 'render', 'ingest_audio'];
const phaseStatuses: PhaseStatus[] = ['pending', 'running', 'completed', 'awaiting_audio', 'failed', 'retryable', 'cancelled'];

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(raw: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function numberValue(raw: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function normalizeStatus(value: unknown): PhaseStatus {
  return typeof value === 'string' && (phaseStatuses as string[]).includes(value) ? value as PhaseStatus : 'pending';
}

function normalizeArtifact(name: string, value: unknown): ArtifactRecord | undefined {
  if (typeof value === 'string') return { name, object_key: value, mime_type: 'application/octet-stream', size_bytes: 0, sha256: '' };
  const raw = objectValue(value);
  if (!raw) return undefined;
  const objectKey = stringValue(raw, 'object_key', 'objectKey', 'key');
  if (!objectKey) return undefined;
  return {
    name: stringValue(raw, 'name') ?? name,
    object_key: objectKey,
    work_key: stringValue(raw, 'work_key', 'workKey'),
    mime_type: stringValue(raw, 'mime_type', 'mimeType') ?? 'application/octet-stream',
    size_bytes: numberValue(raw, 'size_bytes', 'sizeBytes') ?? 0,
    sha256: stringValue(raw, 'sha256') ?? '',
  };
}

function normalizeArtifacts(value: unknown): ArtifactRecord[] {
  const artifacts: ArtifactRecord[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const raw = objectValue(item);
      const name = raw ? stringValue(raw, 'name') : undefined;
      if (!raw || !name) continue;
      const artifact = normalizeArtifact(name, raw);
      if (artifact) artifacts.push(artifact);
    }
  } else {
    const raw = objectValue(value);
    if (raw) for (const [name, item] of Object.entries(raw)) {
      const artifact = normalizeArtifact(name, item);
      if (artifact) artifacts.push(artifact);
    }
  }
  return artifacts;
}

function normalizeAuxiliary(value: unknown): AuxiliaryFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const raw = objectValue(item);
    if (!raw) return [];
    const objectKey = stringValue(raw, 'object_key', 'objectKey');
    const filePath = stringValue(raw, 'path');
    const sha256 = stringValue(raw, 'sha256') ?? '';
    if (!objectKey || !filePath) return [];
    return [{ object_key: objectKey, path: filePath, sha256, size_bytes: numberValue(raw, 'size_bytes', 'sizeBytes') }];
  });
}

function normalizeReview(value: unknown): ReviewBinding | undefined {
  const raw = objectValue(value);
  if (!raw) return undefined;
  const kind = stringValue(raw, 'kind');
  return {
    object_key: stringValue(raw, 'object_key', 'objectKey'),
    sha256: stringValue(raw, 'sha256'),
    approved: raw.approved === true,
    kind: kind === 'answer' || kind === 'video' ? kind : undefined,
    prompt_sha256: stringValue(raw, 'prompt_sha256', 'promptSha256'),
    source_sha256: stringValue(raw, 'source_sha256', 'sourceSha256'),
    answer_sha256: stringValue(raw, 'answer_sha256', 'answerSha256'),
    script_sha256: stringValue(raw, 'script_sha256', 'scriptSha256'),
  };
}

function normalizeRepair(value: unknown): RepairRequest | undefined {
  const raw = objectValue(value);
  if (!raw) return undefined;
  return {
    requested: raw.requested === true || raw.requested === 'true',
    failed_phase: stringValue(raw, 'failed_phase', 'failedPhase'),
    reason: stringValue(raw, 'reason', 'code'),
    message: stringValue(raw, 'message'),
  };
}

function normalizePhaseStatus(value: unknown): Record<string, PhaseStatus> {
  const raw = objectValue(value);
  if (!raw) return {};
  const status: Record<string, PhaseStatus> = {};
  for (const [key, item] of Object.entries(raw)) status[key] = normalizeStatus(item);
  return status;
}

export function emptyCheckpoint(jobId: string): Checkpoint {
  return {
    schema_version: 1,
    job_id: jobId,
    phase: 'author',
    phase_status: { author: 'pending', prepare: 'pending', render: 'pending', ingest_audio: 'pending' },
    artifacts: [],
    auxiliary: [],
    updated_at: new Date().toISOString(),
  };
}

export function parseCheckpoint(bytes: Uint8Array | Buffer | undefined, jobId: string): Checkpoint {
  const text = bytes ? Buffer.from(bytes).toString('utf8') : '';
  if (!text.trim()) return emptyCheckpoint(jobId);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { throw new PipelineError('INVALID_CHECKPOINT', `checkpoint_json is not valid JSON: ${(error as Error).message}`); }
  const raw = objectValue(parsed);
  if (!raw) throw new PipelineError('INVALID_CHECKPOINT', 'checkpoint_json must be a JSON object');
  const storedJobId = stringValue(raw, 'job_id', 'jobId');
  if (storedJobId && storedJobId !== jobId) throw new PipelineError('INVALID_CHECKPOINT', `checkpoint job_id ${storedJobId} does not match request job_id ${jobId}`);
  const phase = stringValue(raw, 'phase');
  const phaseStatus = normalizePhaseStatus(raw.phase_status ?? raw.phaseStatus);
  const hashes = {
    source_sha256: stringValue(raw, 'source_sha256', 'sourceSha256'),
    script_sha256: stringValue(raw, 'script_sha256', 'scriptSha256'),
    answer_sha256: stringValue(raw, 'answer_sha256', 'answerSha256'),
    audio_sha256: stringValue(raw, 'audio_sha256', 'audioSha256'),
    timeline_sha256: stringValue(raw, 'timeline_sha256', 'timelineSha256'),
    video_sha256: stringValue(raw, 'video_sha256', 'videoSha256'),
    build_sha256: stringValue(raw, 'build_sha256', 'buildSha256'),
  };
  const cache = objectValue(raw.cache);
  const checkpoint: Checkpoint = {
    schema_version: numberValue(raw, 'schema_version', 'schemaVersion') ?? 1,
    job_id: jobId,
    phase: phase === 'done' ? 'done' : phaseNames.includes(phase as PhaseName) ? phase as PhaseName : inferPhase(phaseStatus),
    phase_status: { ...emptyCheckpoint(jobId).phase_status, ...phaseStatus },
    artifacts: normalizeArtifacts(raw.artifacts ?? raw.artifact_refs ?? raw.artifactRefs),
    auxiliary: normalizeAuxiliary(raw.auxiliary ?? raw.auxiliary_files ?? raw.auxiliaryFiles),
    review: normalizeReview(raw.review),
    answer_review: normalizeReview(raw.answer_review ?? raw.answerReview),
    video_review: normalizeReview(raw.video_review ?? raw.videoReview),
    error: undefined,
    repair: normalizeRepair(raw.repair),
    cache: cache ? {
      tts_key: stringValue(cache, 'tts_key', 'ttsKey'),
      render_key: stringValue(cache, 'render_key', 'renderKey'),
    } : undefined,
    image_sha256: stringArray(raw.image_sha256 ?? raw.imageSha256),
    updated_at: stringValue(raw, 'updated_at', 'updatedAt') ?? new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(hashes)) if (value) (checkpoint as unknown as Record<string, unknown>)[key] = value;
  const error = objectValue(raw.error);
  if (error) checkpoint.error = { code: stringValue(error, 'code') ?? 'UNKNOWN', message: stringValue(error, 'message') ?? 'Unknown error' };
  return checkpoint;
}

function inferPhase(status: Record<string, PhaseStatus>): PhaseName | 'done' {
  if (status.render === 'completed') return 'done';
  if (status.render === 'running') return 'render';
  if (status.prepare === 'running' || status.prepare === 'awaiting_audio') return 'prepare';
  if (status.ingest_audio === 'running') return 'ingest_audio';
  return 'author';
}

export function mergeCheckpoint(base: Checkpoint, patch: Partial<Checkpoint>): Checkpoint {
  const merged: Checkpoint = {
    ...base,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<Checkpoint>,
    phase_status: { ...base.phase_status, ...(patch.phase_status ?? {}) },
    artifacts: [],
    auxiliary: patch.auxiliary ?? base.auxiliary,
    updated_at: patch.updated_at ?? new Date().toISOString(),
  };
  const artifacts = new Map(base.artifacts.map(artifact => [artifact.name, artifact]));
  for (const artifact of patch.artifacts ?? []) artifacts.set(artifact.name, artifact);
  merged.artifacts = [...artifacts.values()];
  const auxiliary = new Map(base.auxiliary.map(file => [file.path, file]));
  for (const file of patch.auxiliary ?? []) auxiliary.set(file.path, file);
  merged.auxiliary = [...auxiliary.values()];
  return merged;
}

export function addArtifact(checkpoint: Checkpoint, artifact: ArtifactRecord) {
  checkpoint.artifacts = [...checkpoint.artifacts.filter(item => item.name !== artifact.name), artifact];
  checkpoint.updated_at = new Date().toISOString();
}

export function artifactByName(checkpoint: Checkpoint, name: string) {
  return checkpoint.artifacts.find(artifact => artifact.name === name);
}

export function setPhaseStatus(checkpoint: Checkpoint, phase: PhaseName | 'done', status: PhaseStatus | 'completed') {
  if (phase !== 'done') checkpoint.phase_status[phase] = status as PhaseStatus;
  checkpoint.phase = phase;
  checkpoint.updated_at = new Date().toISOString();
}

const answerArtifacts = new Set(['answer', 'answer_review', 'answer_check', 'answer_math', 'narration']);

export function clearDownstream(checkpoint: Checkpoint) {
  checkpoint.audio_sha256 = undefined;
  checkpoint.timeline_sha256 = undefined;
  checkpoint.video_sha256 = undefined;
  checkpoint.build_sha256 = undefined;
  checkpoint.phase_status.prepare = 'pending';
  checkpoint.phase_status.render = 'pending';
  checkpoint.phase_status.ingest_audio = 'pending';
  checkpoint.artifacts = checkpoint.artifacts.filter(artifact => answerArtifacts.has(artifact.name));
  checkpoint.auxiliary = [];
  checkpoint.video_review = undefined;
  checkpoint.review = undefined;
}

export function invalidateVisualAndVideo(checkpoint: Checkpoint) {
  checkpoint.build_sha256 = undefined;
  checkpoint.video_sha256 = undefined;
  checkpoint.phase_status.prepare = 'pending';
  checkpoint.phase_status.render = 'pending';
  const stale = new Set(['visual_check', 'hyperframes_check', 'preview_check', 'video_check', 'quality', 'video']);
  checkpoint.artifacts = checkpoint.artifacts.filter(artifact => !stale.has(artifact.name));
  checkpoint.auxiliary = checkpoint.auxiliary.filter(file => !file.path.startsWith('reports/frames/'));
  checkpoint.updated_at = new Date().toISOString();
}

export function invalidateVideoSource(checkpoint: Checkpoint) {
  checkpoint.build_sha256 = undefined;
  checkpoint.video_sha256 = undefined;
  checkpoint.phase_status.prepare = 'pending';
  checkpoint.phase_status.render = 'pending';
  const stale = new Set([
    'lesson', 'visual_source', 'style_source', 'review', 'video_review', 'visual_check', 'hyperframes_check',
    'preview_check', 'video_check', 'quality', 'video',
  ]);
  checkpoint.artifacts = checkpoint.artifacts.filter(artifact => !stale.has(artifact.name));
  checkpoint.auxiliary = checkpoint.auxiliary.filter(file => answerArtifacts.has(file.path) || file.path === 'answer.json' || file.path.startsWith('reports/answer-'));
  checkpoint.video_review = undefined;
  checkpoint.review = undefined;
  checkpoint.updated_at = new Date().toISOString();
}

export function invalidateVideo(checkpoint: Checkpoint) {
  checkpoint.video_sha256 = undefined;
  checkpoint.phase_status.render = 'pending';
  const stale = new Set(['video_check', 'quality', 'video']);
  checkpoint.artifacts = checkpoint.artifacts.filter(artifact => !stale.has(artifact.name));
  checkpoint.updated_at = new Date().toISOString();
}
