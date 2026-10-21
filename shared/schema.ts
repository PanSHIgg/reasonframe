import { z } from 'zod';

export const ImageSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  base64: z.string().min(16).max(12_000_000),
}).strict();
export const JobInputSchema = z.object({
  problem: z.string().trim().min(3).max(24_000),
  images: z.array(ImageSchema).max(4).default([]),
  scope: z.object({
    subject: z.enum(['math', 'physics', 'chemistry']), grade: z.string().trim().min(1).max(80),
    topics: z.array(z.string().max(120)).max(40).default([]),
    allowedMethods: z.array(z.string().max(160)).max(30).default([]),
    forbiddenMethods: z.array(z.string().max(160)).max(30).default([]),
  }).strict(),
  supplements: z.string().max(12_000).default(''),
  options: z.object({
    template: z.enum(['auto', 'solid-geometry', 'blank']).default('auto'),
    fps: z.union([z.literal(24), z.literal(30)]).default(24),
    quality: z.enum(['draft', 'looks', 'delivery']).default('looks'),
    audio: z.enum(['auto', 'provided']).default('auto'),
  }).strict().default({ template: 'auto', fps: 24, quality: 'looks', audio: 'auto' }),
}).strict();
export type JobInput = z.infer<typeof JobInputSchema>;
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const vector = z.array(z.number().finite()).min(1).max(32);
const modelValue = z.union([z.number().finite(), vector, z.array(vector).min(1).max(32)]);
const anchor = z.object({ beat: z.number().int().min(0), anchor: z.string().min(1).max(200), occurrence: z.number().int().min(1).max(20).optional() });
export const ClaimSchema = z.object({
  id, description: z.string().min(3).max(400), kind: z.enum(['given', 'derivation', 'answer']),
  left: z.string().min(1).max(800), right: z.string().min(1).max(800),
  relation: z.enum(['eq', 'lt', 'lte', 'gt', 'gte']).default('eq'),
  tolerance: z.number().positive().max(0.00001).default(1e-9),
  absoluteTolerance: z.number().nonnegative().max(0.00001).default(0),
}).strict();
export const LessonSchema = z.object({
  schemaVersion: z.literal(1), title: z.string().min(2).max(60), subtitle: z.string().min(2).max(120),
  width: z.literal(1920), height: z.literal(1080), fps: z.union([z.literal(24), z.literal(30)]),
  expectedAnswer: z.string().min(2).max(2000), assumptions: z.array(z.string().min(1).max(400)).max(30),
  chapters: z.array(z.string().min(1).max(30)).min(1).max(8),
  model: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), modelValue),
  entities: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9:_-]*$/), z.object({
    label: z.string().min(1).max(120), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), vertices: z.array(z.string()).max(16).optional(),
  }).strict()),
  claims: z.array(ClaimSchema).min(3).max(120),
  scenes: z.array(z.object({
    id, title: z.string().min(2).max(60), chapter: z.number().int().min(0), stage: id,
    note: z.string().max(240), claimIds: z.array(id).min(1).max(30),
    blocks: z.array(z.object({
      label: z.string().max(180).optional(), math: z.string().max(1500).optional(), text: z.string().max(240).optional(),
      beat: z.number().int().min(0), accent: z.boolean().optional(), answer: z.boolean().optional(), compact: z.boolean().optional(), small: z.boolean().optional(),
    }).strict().refine(b => Boolean(b.math) !== Boolean(b.text), 'A block needs exactly one of math/text')).min(1).max(8),
    beats: z.array(z.object({ say: z.string().trim().min(2).max(1200), caption: z.string().max(300).optional() }).strict()).min(1).max(12),
    cues: z.array(anchor.extend({ objects: z.array(z.string()).min(1).max(12), label: z.string().max(160).optional() }).strict()).min(1).max(60),
    reveals: z.array(anchor.strict()).min(1).max(8),
  }).strict()).min(1).max(32),
}).strict();
export type Lesson = z.infer<typeof LessonSchema>;
export const WordTableSchema = z.object({
  schemaVersion: z.literal(1), timeUnit: z.enum(['seconds', 'milliseconds', '100ns']),
  scriptSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  words: z.array(z.object({
    text: z.string().max(300), start: z.number().finite().nonnegative(), end: z.number().finite().positive().optional(), duration: z.number().finite().positive().optional(),
  }).passthrough().refine(w => w.end !== undefined || w.duration !== undefined, 'end or duration is required')).min(1).max(50_000),
}).passthrough();
export type WordTable = z.infer<typeof WordTableSchema>;
export const AudioInputSchema = z.object({
  scriptSha256: z.string().regex(/^[a-f0-9]{64}$/), audioBase64: z.string().min(100).max(60_000_000), words: WordTableSchema,
}).strict();
export type AudioInput = z.infer<typeof AudioInputSchema>;
export const ReviewSchema = z.object({
  approved: z.boolean(),
  checks: z.object({ textClean: z.boolean(), problemFaithful: z.boolean(), mathSound: z.boolean(), reasoningClear: z.boolean(), notationConsistent: z.boolean(), scopeRespected: z.boolean(), visualsConsistent: z.boolean(), narrationComplete: z.boolean(), layoutClean: z.boolean() }).strict(),
  answer: z.string().min(1).max(2000), issues: z.array(z.string().min(1).max(1000)).max(40),
}).strict().refine(r => !r.approved || (Object.values(r.checks).every(Boolean) && r.issues.length === 0), 'Approval requires all checks and no issues');
export type Review = z.infer<typeof ReviewSchema>;
export type JobStatus = 'queued' | 'running' | 'awaiting_audio' | 'completed' | 'failed' | 'cancelled';
export type Stage = 'queued' | 'authoring' | 'verifying' | 'reviewing' | 'synthesizing' | 'awaiting_audio' | 'aligning' | 'building' | 'checking' | 'rendering' | 'validating' | 'completed' | 'failed' | 'cancelled';
export interface Artifact { name: string; file: string; mimeType: string; }
export interface JobRecord {
  id: string; status: JobStatus; stage: Stage; createdAt: string; updatedAt: string;
  input: Omit<JobInput, 'images'> & { images: { mimeType: string; file: string }[] };
  attempt: number; autoRepairs?: number; eventSequence: number; artifacts: Artifact[]; scriptSha256?: string; sourceSha256?: string;
  error?: { code: string; message: string };
}
export interface JobEvent { id: number; jobId: string; time: string; type: string; data: unknown; }
