import type { ArtifactRecord, UsageLike, UsageTotals } from './types.js';

export interface OutboundEvent {
  seq: number;
  type: string;
  stage: string;
  data: unknown;
  at_unix_ms: number;
}

export function redactText(value: string, secrets: string[]) {
  let result = value;
  for (const secret of secrets.filter(secret => secret && secret.length >= 6)) result = result.split(secret).join('[REDACTED]');
  return result.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').slice(0, 10_000);
}

export class TaskEventSink {
  private sequence = 0;
  private stageName = 'starting';
  readonly usage: UsageTotals;
  constructor(
    private readonly write: (event: OutboundEvent) => void,
    private readonly secrets: string[] = [],
    provider = '',
    model = '',
  ) {
    this.usage = { provider, model, input_tokens: 0, output_tokens: 0, audio_chars: 0, render_seconds: 0, cost_micros: 0 };
  }
  get seq() { return this.sequence; }
  get stage() { return this.stageName; }
  emit(type: string, data?: unknown) {
    const event: OutboundEvent = {
      seq: ++this.sequence,
      type,
      stage: this.stageName,
      data: data === undefined ? {} : data,
      at_unix_ms: Date.now(),
    };
    try { this.write(event); } catch { /* the gRPC stream may already be closed */ }
    return event;
  }
  stageEvent(stage: string, data: Record<string, unknown> = {}) {
    this.stageName = stage;
    return this.emit('stage', { stage, ...data });
  }
  progress(kind: string, data: Record<string, unknown> = {}) {
    return this.emit('progress', { kind, ...data });
  }
  artifact(artifact: ArtifactRecord) {
    return this.emit('artifact', { artifact });
  }
  snapshotUsage() { return { ...this.usage }; }
  recordUsage() {
    const usage = this.snapshotUsage();
    this.emit('usage', usage);
    return usage;
  }
  addAudioCharacters(characters: number) { this.usage.audio_chars += Math.max(0, Math.round(characters)); }
  addRenderSeconds(seconds: number) { this.usage.render_seconds += Math.max(0, seconds); }
  observeAgentEvent(type: string, data: unknown) {
    if (type !== 'agent.usage') return;
    const usage = (data as { usage?: UsageLike } | undefined)?.usage;
    if (!usage) return;
    this.usage.input_tokens += Number(usage.input ?? 0) || 0;
    this.usage.output_tokens += Number(usage.output ?? 0) || 0;
    const cost = Number(usage.cost?.total ?? 0);
    if (Number.isFinite(cost) && cost > 0) this.usage.cost_micros += Math.round(cost * 1_000_000);
  }
  redact(value: string) { return redactText(value, this.secrets); }
}
