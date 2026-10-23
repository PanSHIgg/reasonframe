import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { z } from 'zod';
import {
  AuthStorage, ModelRegistry, SessionManager, SettingsManager, DefaultResourceLoader,
  createAgentSession, defineTool, type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { unregisterApiProviders, type ImageContent } from '@mariozechner/pi-ai';
import {
  AnswerReviewSchema, AnswerSchema, LessonSchema, ReviewSchema,
  type Answer, type AnswerReview, type JobRecord, type Lesson, type Review,
} from '../shared/schema.js';
import type { Config } from './config.js';
import { atomicWrite, readJson, safeFile, sha256, sourceDigest, writeJson } from './files.js';
import { validateWorkspace } from './verification.js';
import { compile } from './compiler.js';
import { inspectVisuals, checkHyperFrames } from './quality.js';
import { checkAbort, PipelineError } from './process.js';
import { loadAgentPrompt, normalizePromptRole, type AgentRole, type PromptSubject } from './prompts.js';
import { alignLessonAudio, answerDigest, answerNarration, storyboardIssues, validateAnswerWorkspace } from './answer.js';

export type Progress = (type: string, data: unknown) => Promise<void>;
type ProviderInput = Parameters<ModelRegistry['registerProvider']>[1];
export interface PreviewResult {
  available: boolean;
  passed: boolean;
  reason?: string;
  errors?: string[];
  report?: unknown;
  samples?: { scene?: string; time?: number; file: string }[];
}
export type PreviewOverride = (workspace: string, fps: number, signal: AbortSignal) => Promise<PreviewResult>;
export interface RuntimeOverrides {
  streamSimple?: ProviderInput['streamSimple'];
  preview?: PreviewOverride;
}

const commonFiles = ['AUTHORING.md', 'schema.json', 'request.json'];
const answerFiles = ['answer.json'];
const videoEditable = ['lesson.json', 'src/visual.js', 'src/style.css'];
const answerReports = ['reports/answer-check.json', 'reports/answer-math.json'];
const videoReports = [
  'reports/structure.json', 'reports/math.json', 'reports/visual.json', 'reports/hyperframes.json',
  'reports/preview.json', 'reports/answer-binding.json', 'reports/answer-check.json', 'reports/answer-math.json',
  'reports/answer-review.json', 'reports/video-review.json',
];
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });
const answerParameters = Type.Unsafe<Answer>(z.toJSONSchema(AnswerSchema, { target: 'draft-7', io: 'input' }));
const lessonParameters = Type.Unsafe<Lesson>(z.toJSONSchema(LessonSchema, { target: 'draft-7', io: 'input' }));
const answerReviewParameters = Type.Object({
  approved: Type.Boolean(),
  checks: Type.Object({
    textClean: Type.Boolean(), problemFaithful: Type.Boolean(), mathSound: Type.Boolean(), reasoningClear: Type.Boolean(),
    notationConsistent: Type.Boolean(), scopeRespected: Type.Boolean(), narrationComplete: Type.Boolean(), answerComplete: Type.Boolean(),
  }),
  answer: Type.String(), issues: Type.Array(Type.String()),
});
const videoReviewParameters = Type.Object({
  approved: Type.Boolean(),
  checks: Type.Object({
    textClean: Type.Boolean(), problemFaithful: Type.Boolean(), mathSound: Type.Boolean(), reasoningClear: Type.Boolean(),
    notationConsistent: Type.Boolean(), scopeRespected: Type.Boolean(), visualsConsistent: Type.Boolean(),
    narrationComplete: Type.Boolean(), layoutClean: Type.Boolean(),
  }),
  answer: Type.String(), issues: Type.Array(Type.String()),
});

function readableFor(role: ReturnType<typeof normalizePromptRole>) {
  if (role === 'answer-author') return [...answerFiles, ...commonFiles, ...answerReports, 'reports/answer-review.json'];
  if (role === 'answer-reviewer') return [...answerFiles, ...commonFiles, ...answerReports];
  if (role === 'video-author') return [...answerFiles, ...videoEditable, ...commonFiles, ...videoReports];
  return [...answerFiles, ...videoEditable, ...commonFiles, ...videoReports.filter(file => !file.endsWith('answer-review.json') && !file.endsWith('video-review.json'))];
}

function editableFor(role: ReturnType<typeof normalizePromptRole>) {
  if (role === 'answer-author') return [...answerFiles];
  if (role === 'video-author') return [...videoEditable];
  return [];
}

async function saveAnswer(workspace: string, value: unknown) {
  const answer = AnswerSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(answer, null, 2) + '\n') > 1_000_000) throw new Error('Answer exceeds 1 MB');
  await writeJson(await safeFile(workspace, 'answer.json'), answer);
  return answer;
}

async function saveVideoLesson(workspace: string, value: unknown) {
  const lesson = LessonSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(lesson, null, 2) + '\n') > 1_000_000) throw new Error('Lesson exceeds 1 MB');
  let answer: Answer;
  try { answer = AnswerSchema.parse(await readJson(await safeFile(workspace, 'answer.json'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Approved answer.json is missing; the video lesson cannot be created before answer approval');
    throw error;
  }
  const issues = storyboardIssues(answer, lesson);
  if (issues.length) throw new Error('Lesson contradicts the approved answer: ' + issues.slice(0, 12).join('; '));
  await writeJson(await safeFile(workspace, 'lesson.json'), lesson);
  return lesson;
}

function updatePointer(document: unknown, pointer: string, value: unknown) {
  if (!pointer.startsWith('/') || /~(?:[^01]|$)/.test(pointer)) throw new Error('Expected a valid non-root JSON Pointer');
  const parts = pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Unsafe JSON Pointer segment');
  let parent = document;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    if (parent === null || typeof parent !== 'object') throw new Error('JSON Pointer parent must exist');
    if (Array.isArray(parent) && (!/^(0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(Number(key)) || Number(key) >= parent.length)) {
      throw new Error('JSON Pointer array index must exist');
    }
    const object = parent as Record<string, unknown>;
    if (i === parts.length - 1) object[key] = value;
    else {
      if (!Object.hasOwn(object, key)) throw new Error('JSON Pointer parent must exist');
      parent = object[key];
    }
  }
}

function missingNextStep(role: ReturnType<typeof normalizePromptRole>, file: string) {
  const editable = editableFor(role);
  if (editable.includes(file)) {
    if (file === 'answer.json') return 'This answer has not been created yet. Use write_answer to create it; do not retry other paths.';
    if (file === 'lesson.json') return 'This lesson has not been created yet. Use write_lesson to create it from the approved answer; do not retry other paths.';
    return 'This file has not been created yet. Use write_file with this exact relative path to create it; do not retry other paths.';
  }
  if (file === 'answer.json') return 'The answer has not been approved yet. Finish the answer stage before reading video files.';
  return 'This report has not been generated yet. Only read files listed as readable by list_files; validate_answer or validate_preview creates the relevant reports.';
}

async function validateVideoWorkspace(workspace: string, fps: number) {
  const validation = await validateWorkspace(workspace, fps);
  let answer: Answer | undefined;
  try { answer = AnswerSchema.parse(await readJson(await safeFile(workspace, 'answer.json'))); }
  catch { /* reported below */ }
  const issues = answer && 'lesson' in validation ? storyboardIssues(answer, validation.lesson) : [];
  if (!answer) issues.push('Approved answer.json is missing or invalid');
  const binding = { passed: issues.length === 0, issues };
  await writeJson(path.join(workspace, 'reports/answer-binding.json'), binding);
  const passed = validation.passed && binding.passed;
  return { ...validation, passed, answer, binding };
}

function toolsFor(
  workspace: string,
  fps: number,
  config: Config,
  role: ReturnType<typeof normalizePromptRole>,
  runPreview: (signal?: AbortSignal) => Promise<PreviewResult>,
  onAnswerReview?: (review: AnswerReview) => void,
  onVideoReview?: (review: Review) => void,
): ToolDefinition[] {
  const readable = readableFor(role), editable = editableFor(role);
  const isVideo = role === 'video-author' || role === 'video-reviewer';
  const tools: ToolDefinition[] = [
    defineTool({ name: 'list_files', label: 'List workspace files', description: 'List existing readable files, editable paths, and files that have not been created yet.', parameters: Type.Object({}),
      async execute() {
        const existing = (await Promise.all(readable.map(async file => {
          try { return (await fs.stat(await safeFile(workspace, file))).isFile() ? file : undefined; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
        }))).filter((file): file is string => file !== undefined);
        return result({ readable: existing, editable, notCreated: readable.filter(file => !existing.includes(file)) });
      } }),
    defineTool({ name: 'read_file', label: 'Read workspace file', description: 'Read one complete authoring/schema/report file. Paths are relative to this job.', parameters: Type.Object({ path: Type.String() }),
      async execute(_id, params) {
        if (!readable.includes(params.path)) throw new Error('File is outside the readable allowlist');
        try { return result({ path: params.path, content: await fs.readFile(await safeFile(workspace, params.path), 'utf8') }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return result({ path: params.path, exists: false, content: null, nextStep: missingNextStep(role, params.path) });
        }
      } }),
    defineTool({ name: 'read_answer', label: 'Read approved answer', description: 'Read answer.json as parsed fields, avoiding nested JSON text escaping.', parameters: Type.Object({}),
      async execute() {
        try { return result({ answer: await readJson(await safeFile(workspace, 'answer.json')) }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return result({ exists: false, answer: null, nextStep: 'The answer has not been approved yet.' });
        }
      } }),
    defineTool({ name: 'validate_answer', label: 'Validate answer', description: 'Run deterministic schema, scene, formula and numeric claim checks. This does not prove the logical solution.', parameters: Type.Object({}),
      async execute() { const r = await validateAnswerForTool(workspace, fps); return result(r); } }),
  ];
  if (isVideo) {
    tools.push(
      defineTool({ name: 'list_frames', label: 'List rendered frames', description: 'List PNG screenshots under reports/frames, including native comparison frames. Use after validate_preview; inspect actual pixels before approval.', parameters: Type.Object({}),
        async execute() {
          try {
            const root = path.join(workspace, 'reports/frames');
            const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
            const frames = entries.filter(entry => entry.isFile() && entry.name.endsWith('.png'))
              .map(entry => path.relative(workspace, path.join(entry.parentPath, entry.name))).sort();
            return result({ frames: frames.slice(0, 120), total: frames.length, nextStep: frames.length ? 'Use read_frames with 1-4 paths to inspect the pixels.' : 'No frames yet; run validate_preview when audio exists.' });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return result({ frames: [], total: 0, nextStep: 'No frames yet; run validate_preview when audio exists.' });
          }
        } }),
      defineTool({ name: 'read_frames', label: 'Inspect rendered frames', description: 'Return up to four rendered PNG frames as images so overlap, clipping, label collisions and garbled text can be checked visually.', parameters: Type.Object({ files: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 4 }) }),
        async execute(_id, params) {
          const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [];
          const images: { type: 'image'; data: string; mimeType: string }[] = [];
          for (const file of params.files) {
            if (!file.startsWith('reports/frames/') || file.includes('..') || !file.endsWith('.png')) throw new Error('Frames must be PNG paths under reports/frames/');
            const bytes = await fs.readFile(await safeFile(workspace, file));
            if (bytes.length > 4_000_000) throw new Error(`Frame is too large to inspect: ${file}`);
            images.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' });
          }
          content.push(...images);
          content.push({ type: 'text', text: JSON.stringify({ files: params.files }) });
          return { content, details: { files: params.files } };
        } }),
      defineTool({ name: 'read_lesson', label: 'Read structured lesson', description: 'Read lesson.json as parsed fields, avoiding nested JSON text escaping.', parameters: Type.Object({}),
        async execute() {
          try { return result({ lesson: await readJson(await safeFile(workspace, 'lesson.json')) }); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return result({ exists: false, lesson: null, nextStep: 'Use write_lesson to create the complete lesson.' });
          }
        } }),
      defineTool({ name: 'validate_lesson', label: 'Validate lesson', description: 'Run deterministic schema, anchor, formula, numeric model and approved-answer binding checks, then return the browser preview status when audio exists.', parameters: Type.Object({}),
        async execute(_id, _params, signal) {
          const verified = await validateVideoWorkspace(workspace, fps);
          if (!signal) return result('lesson' in verified ? { ...verified, lesson: undefined } : verified);
          let previewResult: PreviewResult;
          try { previewResult = await runPreview(signal); } catch (error) { previewResult = { available: false, passed: false, reason: (error as Error).message }; }
          return result({ ...('lesson' in verified ? { ...verified, lesson: undefined } : verified), preview: previewResult });
        } }),
      defineTool({ name: 'validate_preview', label: 'Validate browser preview', description: 'Rebuild the video preview from the current lesson and existing whole-script audio, refresh real browser/highlight/layout and HyperFrames reports, and return actual frames. Does not synthesize audio or export a video.', parameters: Type.Object({}),
        async execute(_id, _params, signal) {
          try { return result(await runPreview(signal)); }
          catch (error) { if (error instanceof PipelineError) throw error; throw error; }
        } }),
    );
  }
  if (role === 'answer-author') {
    tools.push(
      defineTool({ name: 'write_answer', label: 'Write structured answer', description: 'Create or replace the complete answer as structured JSON. Pass field values directly; arrays must be JSON arrays, not objects with an item property. The service validates and serializes answer.json atomically.', parameters: Type.Object({ answer: answerParameters }),
        async execute(_id, params) { await saveAnswer(workspace, params.answer); return result({ written: 'answer.json' }); } }),
      defineTool({ name: 'update_answer', label: 'Update answer fields', description: 'Atomically update answer fields using JSON Pointers. Each change supplies exactly one typed value: text, number, boolean, numbers (number array), strings (string array), or json (a serialized JSON fragment for complex objects/arrays). Use text for LaTeX without extra JSON encoding. Parents and array indices must exist. The complete batch must pass the answer schema before saving.',
        parameters: Type.Object({ changes: Type.Array(Type.Object({ pointer: Type.String({ minLength: 1, maxLength: 512 }),
          text: Type.Optional(Type.String()), number: Type.Optional(Type.Number()), boolean: Type.Optional(Type.Boolean()),
          numbers: Type.Optional(Type.Array(Type.Number())), strings: Type.Optional(Type.Array(Type.String())), json: Type.Optional(Type.String()),
        }), { minItems: 1, maxItems: 128 }) }),
        async execute(_id, params) {
          const answer = await readJson(await safeFile(workspace, 'answer.json'));
          for (const change of params.changes) {
            const keys = (['text', 'number', 'boolean', 'numbers', 'strings', 'json'] as const).filter(key => Object.hasOwn(change, key));
            if (keys.length !== 1) throw new Error('Each change needs exactly one of text, number, boolean, numbers, strings, json');
            const value = keys[0] === 'json' ? JSON.parse(change.json!) : change[keys[0]];
            updatePointer(answer, change.pointer, value);
          }
          await saveAnswer(workspace, answer); return result({ updated: 'answer.json', pointers: params.changes.map(change => change.pointer) });
        } }),
    );
  }
  if (role === 'video-author') {
    tools.push(
      defineTool({ name: 'write_lesson', label: 'Write structured lesson', description: 'Create or replace the complete lesson as structured JSON. Approved title, narration, model symbols and claims must be copied exactly from answer.json. Pass field values directly; arrays must be JSON arrays, not objects with an item property. The service validates and serializes lesson.json atomically.', parameters: Type.Object({ lesson: lessonParameters }),
        async execute(_id, params) { await saveVideoLesson(workspace, params.lesson); return result({ written: 'lesson.json' }); } }),
      defineTool({ name: 'update_lesson', label: 'Update lesson fields', description: 'Atomically update visual lesson fields using JSON Pointers. Each change supplies exactly one typed value: text, number, boolean, numbers (number array), strings (string array), or json (a serialized JSON fragment for complex objects/arrays). Approved answer fields and narration cannot be changed. Parents and array indices must exist. The complete batch must pass schema and answer binding before saving.',
        parameters: Type.Object({ changes: Type.Array(Type.Object({ pointer: Type.String({ minLength: 1, maxLength: 512 }),
          text: Type.Optional(Type.String()), number: Type.Optional(Type.Number()), boolean: Type.Optional(Type.Boolean()),
          numbers: Type.Optional(Type.Array(Type.Number())), strings: Type.Optional(Type.Array(Type.String())), json: Type.Optional(Type.String()),
        }), { minItems: 1, maxItems: 128 }) }),
        async execute(_id, params) {
          const lesson = await readJson(await safeFile(workspace, 'lesson.json'));
          for (const change of params.changes) {
            const keys = (['text', 'number', 'boolean', 'numbers', 'strings', 'json'] as const).filter(key => Object.hasOwn(change, key));
            if (keys.length !== 1) throw new Error('Each change needs exactly one of text, number, boolean, numbers, strings, json');
            const value = keys[0] === 'json' ? JSON.parse(change.json!) : change[keys[0]];
            updatePointer(lesson, change.pointer, value);
          }
          await saveVideoLesson(workspace, lesson); return result({ updated: 'lesson.json', pointers: params.changes.map(change => change.pointer) });
        } }),
      defineTool({ name: 'write_file', label: 'Write visual source file', description: 'Replace one complete visual source file. Only src/visual.js and src/style.css are writable; lesson.json must use write_lesson.', parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        async execute(_id, params) {
          if (!videoEditable.includes(params.path) || params.path === 'lesson.json') throw new Error('File is outside the writable allowlist');
          if (Buffer.byteLength(params.content) > 1_000_000) throw new Error('Source file exceeds 1 MB');
          await atomicWrite(await safeFile(workspace, params.path), params.content); return result({ written: params.path });
        } }),
      defineTool({ name: 'edit_file', label: 'Edit visual source file', description: 'Replace a unique exact substring in src/visual.js or src/style.css.', parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
        async execute(_id, params) {
          if (params.path === 'lesson.json') throw new Error('Use read_lesson and update_lesson for lesson fields; the service handles JSON and LaTeX escaping.');
          if (!videoEditable.includes(params.path) || !params.oldText) throw new Error('Invalid edit target');
          const file = await safeFile(workspace, params.path), text = await fs.readFile(file, 'utf8');
          if (!text.includes(params.oldText) || text.indexOf(params.oldText) !== text.lastIndexOf(params.oldText)) throw new Error('oldText must match exactly once');
          const next = text.replace(params.oldText, params.newText);
          if (Buffer.byteLength(next) > 1_000_000) throw new Error('Source file exceeds 1 MB');
          await atomicWrite(file, next); return result({ edited: params.path });
        } }),
    );
  }
  if (role === 'answer-reviewer' && onAnswerReview) {
    tools.push(defineTool({ name: 'submit_answer_review', label: 'Submit independent answer review', description: 'Submit a structured independent answer review. Approve only if every check passes and no unresolved issue remains. Do not perform or claim pixel-level visual review at this stage.', parameters: answerReviewParameters,
      async execute(_id, params) { const review = AnswerReviewSchema.parse(params); onAnswerReview(review); return result({ accepted: true }); } }));
  }
  if (role === 'video-reviewer' && onVideoReview) {
    tools.push(defineTool({ name: 'submit_video_review', label: 'Submit independent video review', description: 'Submit a structured independent review of the rendered preview, lesson and approved narration. Approve only if every check passes and no unresolved issue remains.', parameters: videoReviewParameters,
      async execute(_id, params) { const review = ReviewSchema.parse(params); onVideoReview(review); return result({ accepted: true }); } }));
  }
  return tools;
}

async function validateAnswerForTool(workspace: string, fps: number) {
  const r = await (await import('./answer.js')).validateAnswerWorkspace(workspace, fps);
  return 'answer' in r ? { ...r, answer: undefined } : r;
}

export class PiEngine {
  constructor(private config: Config, private overrides: RuntimeOverrides = {}) {}
  get configured() { return Boolean(this.config.llm); }

  async preview(workspace: string, fps: number, signal: AbortSignal): Promise<PreviewResult> {
    if (this.overrides.preview) return this.overrides.preview(workspace, fps, signal);
    const verified = await validateVideoWorkspace(workspace, fps);
    if (!verified.passed || !('lesson' in verified)) return { available: false, passed: false, reason: 'Fix lesson/answer binding errors first', report: verified };
    let timeline;
    try { timeline = await readJson<import('./alignment.js').Timeline>(path.join(workspace, 'timeline.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { available: false, passed: false, reason: 'No complete audio yet. Finish ingestion/synthesis before the video preview.' };
      throw error;
    }
    try {
      timeline = await alignLessonAudio(workspace, verified.lesson, signal, timeline.speech?.source);
      await compile(workspace, verified.lesson, timeline);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as Error).message === 'Narration changed after audio alignment') {
        return { available: false, passed: false, reason: 'Complete audio for this narration is unavailable; regenerate whole-script audio first.' };
      }
      const report = { passed: false, sourceSha256: await sourceDigest(workspace), checkedAt: new Date().toISOString(), errors: [(error as Error).message], reports: [] };
      await writeJson(path.join(workspace, 'reports/preview.json'), report);
      return { available: true, passed: false, errors: report.errors, report };
    }
    const bounded = AbortSignal.any([AbortSignal.timeout(240000), signal]);
    const checks = await Promise.allSettled([
      inspectVisuals(this.config, workspace, timeline, bounded), checkHyperFrames(this.config, workspace, randomUUID(), bounded),
    ]);
    checkAbort(bounded);
    const errors = checks.flatMap(check => check.status === 'rejected' ? [String(check.reason?.message ?? check.reason)] : []);
    const samples = checks[0]?.status === 'fulfilled' ? checks[0].value : [];
    const report = {
      passed: checks.every(check => check.status === 'fulfilled') && samples.length > 0,
      sourceSha256: await sourceDigest(workspace), scriptSha256: sha256(answerNarration(verified.answer!)),
      checkedAt: new Date().toISOString(), errors, samples, reports: ['reports/visual.json', 'reports/hyperframes.json'],
    };
    await writeJson(path.join(workspace, 'reports/preview.json'), report);
    return { available: true, passed: report.passed, errors, report, samples: samples as PreviewResult['samples'] };
  }

  async session(workspace: string, roleInput: AgentRole, fps: number, signal: AbortSignal, progress: Progress, onReview?: (value: AnswerReview | Review) => void, subject: PromptSubject = 'math') {
    const role = normalizePromptRole(roleInput);
    const config = this.config.llm;
    if (!config) throw new PipelineError('MODEL_NOT_CONFIGURED', 'Configure LLM_ENDPOINT, LLM_URL, LLM_API_KEY and LLM_MODEL');
    const agentDir = path.join(workspace, 'sessions', role);
    await fs.mkdir(agentDir, { recursive: true });
    const sessionManager = SessionManager.create(workspace, agentDir);
    const providerHeaders = new URL(config.url).hostname === 'opencode.ai'
      ? { 'User-Agent': 'reasonframe/0.1.0', 'x-opencode-session': sessionManager.getSessionId() }
      : undefined;
    const api = { responses: 'openai-responses', completions: 'openai-completions', messages: 'anthropic-messages' }[config.endpoint] as 'openai-responses' | 'openai-completions' | 'anthropic-messages';
    // SDK API registrations are process-global. Fixtures must not replace a live protocol or another session.
    const providerName = this.overrides.streamSimple ? 'reasonframe-fixture-' + randomUUID() : 'reasonframe';
    const authStorage = AuthStorage.inMemory(); authStorage.setRuntimeApiKey(providerName, config.apiKey);
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    modelRegistry.registerProvider(providerName, {
      baseUrl: config.url, api: this.overrides.streamSimple ? providerName : api, apiKey: '__REASONFRAME_RUNTIME_KEY__', streamSimple: this.overrides.streamSimple, headers: providerHeaders,
      models: [{ id: config.model, name: config.model, reasoning: config.thinkingLevel !== 'off', input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: config.contextWindow, maxTokens: config.maxTokens,
        ...(api === 'openai-completions' ? { compat: { supportsStore: false } } : {}),
      }],
    });
    const model = modelRegistry.find(providerName, config.model);
    if (!model) throw new Error('Configured model could not be registered with Pi');
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: {
      enabled: config.maxAttempts > 1, maxRetries: config.maxAttempts - 1, baseDelayMs: config.retryDelayMs,
      // Pi owns the retry budget; disable the provider SDK's additional retry layer.
      provider: { timeoutMs: config.requestTimeoutMs, maxRetries: 0 },
    } });
    const systemPrompt = await loadAgentPrompt(role, subject);
    const resourceLoader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager, systemPrompt,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const runtimeConfig = this.config;
    let calls = 0, executedCalls = 0, turns = 0, eventFailure: Error | undefined, terminalFailure: PipelineError | undefined, pending = Promise.resolve();
    const enqueue = (type: string, data: unknown) => { pending = pending.then(() => progress(type, data)).catch(e => { eventFailure = e; }); };
    const answerReview = role === 'answer-reviewer' ? (value: AnswerReview | Review) => onReview?.(value as AnswerReview) : undefined;
    const videoReview = role === 'video-reviewer' ? (value: AnswerReview | Review) => onReview?.(value as Review) : undefined;
    const customTools = toolsFor(workspace, fps, this.config, role, previewSignal => this.preview(workspace, fps, previewSignal ?? signal), answerReview, videoReview).map((tool): ToolDefinition => ({
      ...tool,
      async execute(...args) {
        checkAbort(signal);
        if (executedCalls >= runtimeConfig.agentMaxToolCalls) {
          terminalFailure = new PipelineError('AGENT_TOOL_LIMIT', 'Pi exceeded the ' + runtimeConfig.agentMaxToolCalls + '-tool-call budget');
          void session.abort(); throw terminalFailure;
        }
        executedCalls++; return tool.execute(...args);
      },
    }));
    const { session } = await createAgentSession({ cwd: workspace, agentDir, model, authStorage, modelRegistry, settingsManager,
      resourceLoader, sessionManager, thinkingLevel: config.thinkingLevel, tools: customTools.map(t => t.name), customTools });
    const sdkStream = session.agent.streamFn;
    session.agent.streamFn = (currentModel, context, options) => {
      checkAbort(signal);
      if (turns >= runtimeConfig.agentMaxTurns) {
        terminalFailure = new PipelineError('AGENT_TURN_LIMIT', 'Pi exceeded the ' + runtimeConfig.agentMaxTurns + '-model-call budget');
        throw terminalFailure;
      }
      turns++; enqueue('agent.request', { role, call: turns });
      return sdkStream(currentModel, context, { ...options, maxTokens: config.maxTokens,
        ...(config.temperature === undefined ? {} : { temperature: config.temperature }) });
    };
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'tool_execution_start') {
        calls++; enqueue('agent.tool', { role, tool: event.toolName, call: calls });
      }
      if (event.type === 'tool_execution_end') enqueue('agent.tool_result', { role, tool: event.toolName, isError: event.isError });
      if (event.type === 'message_end' && event.message.role === 'assistant') enqueue('agent.usage', { role, usage: event.message.usage, stopReason: event.message.stopReason });
      if (event.type === 'auto_retry_start') enqueue('agent.retry', { role, attempt: event.attempt + 1, maxAttempts: config.maxAttempts, delayMs: event.delayMs });
    });
    const abort = () => { void session.abort(); }; signal.addEventListener('abort', abort, { once: true });
    return {
      role,
      async prompt(text: string, images?: ImageContent[]) {
        checkAbort(signal); await session.prompt(text, { images, expandPromptTemplates: false }); await pending;
        if (terminalFailure) throw terminalFailure;
        checkAbort(signal);
        if (eventFailure) throw eventFailure;
        const last = session.messages.filter(m => m.role === 'assistant').at(-1);
        if (last?.role === 'assistant' && ['error', 'aborted', 'length'].includes(last.stopReason)) throw new PipelineError('AGENT_RESPONSE_FAILED', last.errorMessage || `Pi ended with ${last.stopReason}`);
      },
      dispose() {
        unsubscribe(); signal.removeEventListener('abort', abort); session.dispose();
        if (providerName !== 'reasonframe') unregisterApiProviders('provider:' + providerName);
      },
    };
  }

  private async loadImages(workspace: string, job: JobRecord) {
    return Promise.all(job.input.images.map(async image => ({ type: 'image' as const, mimeType: image.mimeType,
      data: (await fs.readFile(path.join(workspace, image.file))).toString('base64') })));
  }

  async answerAndReview(workspace: string, job: JobRecord, signal: AbortSignal, progress: Progress, stage: (stage: 'answering' | 'verifying' | 'answer_reviewing') => Promise<void>) {
    const timeout = AbortSignal.timeout(this.config.agentTimeoutMs), bounded = AbortSignal.any([signal, timeout]);
    const images = await this.loadImages(workspace, job);
    const request = JSON.stringify({ ...job.input, images: job.input.images.map(i => ({ mimeType: i.mimeType })) });
    const subject = job.input.scope.subject;
    const author = await this.session(workspace, 'answer-author', job.input.options.fps, bounded, progress, undefined, subject);
    try {
      let feedback = '';
      for (let attempt = 0; attempt <= this.config.maxRepairAttempts; attempt++) {
        await stage('answering');
        const initialFeedback = job.error
          ? `\n上一次流水线失败：${JSON.stringify(job.error)}。先读现有 answer.json 和答案审核反馈，修复答案、claims 或讲稿；不要通过删除断言、隐藏条件或改写审核规则来通过检查。`
          : '';
        await author.prompt(attempt === 0
          ? `请先独立求解以下题目，再生成完整 answer.json。不要询问是否开始。先读工作区约定和已有 answer.json（如有），只写答案与讲稿，不要创建画面源码。\n<request>${request}</request>${initialFeedback}`
          : `修复以下答案审核问题，保留已经正确的解题和讲稿，再完整校验并重新提交审核：\n${feedback}`,
        attempt === 0 ? images : undefined);
        await stage('verifying');
        const verified = await validateAnswerWorkspace(workspace, job.input.options.fps);
        if (!verified.passed || !('answer' in verified)) { feedback = JSON.stringify(verified); continue; }
        await stage('answer_reviewing');
        let submitted: AnswerReview | undefined;
        const reviewer = await this.session(workspace, 'answer-reviewer', job.input.options.fps, bounded, progress, value => { submitted = value as AnswerReview; }, subject);
        try {
          await reviewer.prompt(`独立审核此题目和已生成的答案与讲稿。先独立求解，再读完整 answer.json 和检查报告；必须调用 submit_answer_review 提交结构化审核。\n<request>${request}</request>`, images);
          if (!submitted) {
            await reviewer.prompt('你还没有调用 submit_answer_review。现在必须调用 submit_answer_review 提交结构化审核；不要只输出分析文字。若证据不足，也应如实填写检查项和 issues。');
          }
        } finally { reviewer.dispose(); }
        if (!submitted) throw new PipelineError('REVIEW_MISSING', 'Answer reviewer did not submit a review');
        const answer = verified.answer;
        const scriptSha256 = sha256(answerNarration(answer));
        const answerSha256 = answerDigest(answer, scriptSha256);
        const record = { ...submitted, answerSha256, sourceSha256: answerSha256, scriptSha256, subject,
          promptSha256: sha256(await loadAgentPrompt('answer-reviewer', subject)),
          mode: this.overrides.streamSimple ? 'fixture' : 'live-model' };
        await writeJson(path.join(workspace, `reports/answer-review-${attempt + 1}.json`), record);
        await writeJson(path.join(workspace, 'reports/answer-review.json'), record);
        if (submitted.approved) return { answer, answerSha256, scriptSha256 };
        feedback = JSON.stringify(submitted);
      }
      throw new PipelineError('QUALITY_GATE_FAILED', `Answer/review did not pass after ${this.config.maxRepairAttempts + 1} attempts: ${feedback.slice(0, 4000)}`);
    } catch (error) {
      if (timeout.aborted && !signal.aborted) throw new PipelineError('AGENT_TIMEOUT', 'Answer/review exceeded ' + this.config.agentTimeoutMs + ' ms');
      throw error;
    } finally { author.dispose(); }
  }

  async videoAndReview(workspace: string, job: JobRecord, signal: AbortSignal, progress: Progress, stage: (stage: 'video_authoring' | 'verifying' | 'video_reviewing') => Promise<void>, onDraft?: () => Promise<void>) {
    const timeout = AbortSignal.timeout(this.config.agentTimeoutMs), bounded = AbortSignal.any([signal, timeout]);
    const images = await this.loadImages(workspace, job);
    const request = JSON.stringify({ ...job.input, images: job.input.images.map(i => ({ mimeType: i.mimeType })) });
    const subject = job.input.scope.subject;
    const author = await this.session(workspace, 'video-author', job.input.options.fps, bounded, progress, undefined, subject);
    const saveDraft = async () => { try { await onDraft?.(); } catch { /* draft recovery is best effort */ } };
    let lastFeedback = '', lastReview: Review | undefined;
    try {
      for (let attempt = 0; attempt <= this.config.maxRepairAttempts; attempt++) {
        await stage('video_authoring');
        const initialFeedback = job.error
          ? `\n上一次流水线失败：${JSON.stringify(job.error)}。先读 answer.json、现有 lesson 和视频审核反馈，修复画面、cue 或版式；已批准的答案、claims、model 中已有符号和旁白不能改写。`
          : '';
        await author.prompt(attempt === 0
          ? `请把已批准的 answer.json 制作成完整、可渲染的视觉课程。不要询问是否开始。先读工作区约定、answer.json 和现有 lesson。写 lesson.json、src/visual.js、src/style.css；旁白必须逐字保留。完成后校验并检查实际截图。\n<request>${request}</request>${initialFeedback}`
          : `修复以下视频审核或预览问题，保留已经正确的画面，再完整校验并重新提交审核：\n${lastFeedback}`,
        attempt === 0 ? images : undefined);
        await saveDraft();
        await stage('verifying');
        const verified = await validateVideoWorkspace(workspace, job.input.options.fps);
        if (!verified.passed || !('lesson' in verified)) { lastFeedback = JSON.stringify({ binding: verified.binding, structure: 'structure' in verified ? verified.structure : undefined }); continue; }
        let preview: PreviewResult;
        try { preview = await this.preview(workspace, job.input.options.fps, bounded); }
        catch (error) { lastFeedback = JSON.stringify({ previewError: (error as Error).message }); continue; }
        if (!preview.available) { lastFeedback = JSON.stringify({ preview }); continue; }
        await saveDraft();
        await stage('video_reviewing');
        let submitted: Review | undefined;
        const reviewer = await this.session(workspace, 'video-reviewer', job.input.options.fps, bounded, progress, value => { submitted = value as Review; }, subject);
        try {
          await reviewer.prompt(`独立审核此视频课程：核对已批准答案与讲稿，查看实际预览帧、源码和检查报告，然后必须调用 submit_video_review。\n<request>${request}</request>`, images);
          if (!submitted) {
            await reviewer.prompt('你还没有调用 submit_video_review。现在必须调用 submit_video_review 提交结构化审核；不要只输出分析文字。若证据不足，也应如实填写检查项和 issues。');
          }
        } finally { reviewer.dispose(); }
        if (!submitted) throw new PipelineError('REVIEW_MISSING', 'Video reviewer did not submit a review');
        lastReview = submitted;
        const sourceSha256 = await sourceDigest(workspace);
        const scriptSha256 = sha256(answerNarration(verified.answer!));
        const answerSha256 = answerDigest(verified.answer!, scriptSha256);
        const record = { ...submitted, sourceSha256, answerSha256, scriptSha256, subject,
          promptSha256: sha256(await loadAgentPrompt('video-reviewer', subject)),
          mode: this.overrides.streamSimple ? 'fixture' : 'live-model' };
        await writeJson(path.join(workspace, `reports/video-review-${attempt + 1}.json`), record);
        await writeJson(path.join(workspace, 'reports/video-review.json'), record);
        await writeJson(path.join(workspace, 'reports/review.json'), record);
        await saveDraft();
        if (submitted.approved && preview.passed) return { lesson: verified.lesson, answer: verified.answer!, sourceSha256, review: submitted, preview };
        lastFeedback = JSON.stringify({ review: submitted, preview: { passed: preview.passed, errors: preview.errors, reason: preview.reason } });
      }
      const answerLevel = Boolean(lastReview && (!lastReview.checks.mathSound || !lastReview.checks.reasoningClear || !lastReview.checks.problemFaithful || !lastReview.checks.narrationComplete));
      throw new PipelineError(answerLevel ? 'ANSWER_REVISION_REQUIRED' : 'VIDEO_QUALITY_GATE_FAILED',
        `Video review did not pass after ${this.config.maxRepairAttempts + 1} attempts: ${lastFeedback.slice(0, 4000)}`);
    } catch (error) {
      if (timeout.aborted && !signal.aborted) throw new PipelineError('AGENT_TIMEOUT', 'Video authoring/review exceeded ' + this.config.agentTimeoutMs + ' ms');
      throw error;
    } finally { author.dispose(); }
  }
}
