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
import { LessonSchema, ReviewSchema, type JobRecord, type Lesson, type Review } from '../shared/schema.js';
import type { Config } from './config.js';
import { atomicWrite, readJson, safeFile, sha256, sourceDigest, writeJson } from './files.js';
import { validateWorkspace } from './verification.js';
import { compile } from './compiler.js';
import type { Timeline } from './alignment.js';
import { inspectVisuals, checkHyperFrames } from './quality.js';
import { synthesize } from './audio.js';
import { checkAbort, PipelineError } from './process.js';
import { loadAgentPrompt, type PromptSubject } from './prompts.js';

export type Progress = (type: string, data: unknown) => Promise<void>;
type ProviderInput = Parameters<ModelRegistry['registerProvider']>[1];
export interface RuntimeOverrides { streamSimple?: ProviderInput['streamSimple']; }
const editable = ['lesson.json', 'src/visual.js', 'src/style.css'];
const readable = [...editable, 'AUTHORING.md', 'schema.json', 'request.json', 'reports/structure.json', 'reports/math.json', 'reports/visual.json', 'reports/hyperframes.json', 'reports/preview.json'];
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });
const lessonParameters = Type.Unsafe<Lesson>(z.toJSONSchema(LessonSchema, { target: 'draft-7', io: 'input' }));
const reviewParameters = Type.Object({
  approved: Type.Boolean(),
  checks: Type.Object({ textClean: Type.Boolean(), problemFaithful: Type.Boolean(), mathSound: Type.Boolean(), reasoningClear: Type.Boolean(), notationConsistent: Type.Boolean(), scopeRespected: Type.Boolean(), visualsConsistent: Type.Boolean(), narrationComplete: Type.Boolean(), layoutClean: Type.Boolean() }),
  answer: Type.String(), issues: Type.Array(Type.String()),
});

async function saveLesson(workspace: string, value: unknown) {
  const lesson = LessonSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(lesson, null, 2) + '\n') > 1_000_000) throw new Error('Lesson exceeds 1 MB');
  await writeJson(await safeFile(workspace, 'lesson.json'), lesson);
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

function toolsFor(workspace: string, fps: number, config: Config, onReview?: (review: Review) => void): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    defineTool({ name: 'list_files', label: 'List workspace files', description: 'List existing readable files, editable paths, and files that have not been created yet.', parameters: Type.Object({}),
      async execute() {
        const existing = (await Promise.all(readable.map(async file => {
          try { return (await fs.stat(await safeFile(workspace, file))).isFile() ? file : undefined; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
        }))).filter((file): file is string => file !== undefined);
        return result({ readable: existing, editable: onReview ? [] : editable, notCreated: readable.filter(file => !existing.includes(file)) });
      } }),
    defineTool({ name: 'read_file', label: 'Read workspace file', description: 'Read one complete authoring/schema/report file. Paths are relative to this job.', parameters: Type.Object({ path: Type.String() }),
      async execute(_id, params) {
        if (!readable.includes(params.path)) throw new Error('File is outside the readable allowlist');
        try { return result({ path: params.path, content: await fs.readFile(await safeFile(workspace, params.path), 'utf8') }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return result({ path: params.path, exists: false, content: null,
            nextStep: !onReview && editable.includes(params.path)
              ? params.path === 'lesson.json'
                ? 'This lesson has not been created yet. Use write_lesson to create it (write_file is a legacy alternative); do not retry other paths.'
                : 'This file has not been created yet. Use write_file with this exact relative path to create it; do not retry other paths.'
              : 'This report has not been generated yet. Only read files listed as readable by list_files; validate_lesson creates structure and math reports.' });
        }
      } }),
    defineTool({ name: 'list_frames', label: 'List rendered frames', description: 'List PNG screenshots under reports/frames, including native and encoded comparison frames. Use after validate_preview or a completed check; inspect actual pixels before approval.', parameters: Type.Object({}),
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
    defineTool({ name: 'read_lesson', label: 'Read structured lesson', description: 'Read lesson.json as parsed fields, avoiding nested JSON text escaping. Use this for reading the lesson.', parameters: Type.Object({}),
      async execute() {
        try { return result({ lesson: await readJson(await safeFile(workspace, 'lesson.json')) }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return result({ exists: false, lesson: null, nextStep: 'Use write_lesson to create the complete lesson.' });
        }
      } }),
    defineTool({ name: 'validate_lesson', label: 'Validate lesson', description: 'Run deterministic schema, anchor, formula and numeric model checks. This does not prove the logical solution.', parameters: Type.Object({}),
      async execute() { const r = await validateWorkspace(workspace, fps); return result('lesson' in r ? { ...r, lesson: undefined } : r); } }),
    defineTool({ name: 'validate_preview', label: 'Validate browser preview', description: 'When complete audio already exists, rebuild the preview and run real browser/highlight/layout and HyperFrames checks. Refreshes reports for visual repairs without synthesizing audio or exporting a video. Returns unavailable before audio or if narration changed; that absence is not a source-review failure.', parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        const verified = await validateWorkspace(workspace, fps);
        if (!verified.passed || !('lesson' in verified)) return result({ available: false, reason: 'Fix lesson validation errors first', validation: verified });
        let timeline: Timeline;
        try { timeline = await readJson<Timeline>(path.join(workspace, 'timeline.json')); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return result({ available: false, reason: 'No complete audio yet. Finish the source review first; the pipeline will synthesize and check visuals afterwards.' });
        }
        try { await compile(workspace, verified.lesson, timeline); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as Error).message === 'Narration changed after audio alignment') {
            return result({ available: false, reason: 'Complete audio for this narration is unavailable. Finish source review; the pipeline will regenerate whole-script audio and run browser checks.' });
          }
          throw error;
        }
        const bounded = AbortSignal.any([AbortSignal.timeout(240000), ...(signal ? [signal] : [])]);
        const checks = await Promise.allSettled([
          inspectVisuals(config, workspace, timeline, bounded), checkHyperFrames(config, workspace, randomUUID(), bounded),
        ]);
        checkAbort(bounded);
        const report = { passed: checks.every(check => check.status === 'fulfilled'), sourceSha256: await sourceDigest(workspace),
          checkedAt: new Date().toISOString(), errors: checks.flatMap(check => check.status === 'rejected' ? [String(check.reason?.message ?? check.reason)] : []),
          reports: ['reports/visual.json', 'reports/hyperframes.json'] };
        await writeJson(path.join(workspace, 'reports/preview.json'), report);
        return result({ available: true, ...report });
      } }),
  ];
  if (onReview) {
    tools.push(defineTool({ name: 'submit_review', label: 'Submit independent review', description: 'Submit a structured independent review. Approve only if every check passes and no unresolved issue remains.', parameters: reviewParameters,
      async execute(_id, params) { const review = ReviewSchema.parse(params); onReview(review); return result({ accepted: true }); } }));
  } else {
    tools.push(
      defineTool({ name: 'synthesize_narration', label: 'Generate narration audio', description: 'Generate the complete voiceover for the current lesson with the configured TTS provider and write narration.mp3, words.json and timeline.json. Call only after narration is final and validate_lesson passes; call again only if the narration changed. This is one whole-script request and may take a minute.', parameters: Type.Object({}),
        async execute(_id, _params, signal) {
          checkAbort(signal);
          const verified = await validateWorkspace(workspace, fps);
          if (!verified.passed || !('lesson' in verified)) return result({ generated: false, reason: 'Fix lesson validation errors first', validation: verified });
          if (!config.tts) return result({ generated: false, reason: 'TTS is not configured; use audio.provided or configure TTS_PROVIDER' });
          const timeline = await synthesize(config, workspace, verified.lesson, signal ?? AbortSignal.timeout(300000));
          return result({ generated: true, source: timeline.speech.source, duration: timeline.audioDuration, words: timeline.words.length,
            audioSha256: timeline.speech.audioSha256, nextStep: 'Call validate_preview to refresh browser checks; the completed pipeline will reuse this audio if the script hash is unchanged.' });
        } }),
      defineTool({ name: 'write_lesson', label: 'Write structured lesson', description: 'Create or replace the complete lesson as structured JSON. Pass field values directly; arrays must be JSON arrays, not objects with an item property. The service validates and serializes lesson.json atomically.', parameters: Type.Object({ lesson: lessonParameters }),
        async execute(_id, params) { await saveLesson(workspace, params.lesson); return result({ written: 'lesson.json' }); } }),
      defineTool({ name: 'update_lesson', label: 'Update lesson fields', description: 'Atomically update lesson fields using JSON Pointers. Each change supplies exactly one typed value: text, number, boolean, numbers (number array), strings (string array), or json (a serialized JSON fragment for complex objects/arrays). Use text for LaTeX without extra JSON encoding. Parents and array indices must exist. The complete batch must pass the lesson schema before saving.',
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
          await saveLesson(workspace, lesson); return result({ updated: 'lesson.json', pointers: params.changes.map(change => change.pointer) });
        } }),
      defineTool({ name: 'write_file', label: 'Write authoring file', description: 'Replace one complete source file. Only lesson.json, src/visual.js, src/style.css are writable.', parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        async execute(_id, params) {
          if (!editable.includes(params.path)) throw new Error('File is outside the writable allowlist');
          if (Buffer.byteLength(params.content) > 1_000_000) throw new Error('Source file exceeds 1 MB');
          await atomicWrite(await safeFile(workspace, params.path), params.content); return result({ written: params.path });
        } }),
      defineTool({ name: 'edit_file', label: 'Edit authoring file', description: 'Replace a unique exact substring in an allowed source file.', parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
        async execute(_id, params) {
          if (params.path === 'lesson.json') throw new Error('Use read_lesson and update_lesson for lesson fields; the service handles JSON and LaTeX escaping.');
          if (!editable.includes(params.path) || !params.oldText) throw new Error('Invalid edit target');
          const file = await safeFile(workspace, params.path), text = await fs.readFile(file, 'utf8');
          if (!text.includes(params.oldText) || text.indexOf(params.oldText) !== text.lastIndexOf(params.oldText)) throw new Error('oldText must match exactly once');
          const next = text.replace(params.oldText, params.newText);
          if (Buffer.byteLength(next) > 1_000_000) throw new Error('Source file exceeds 1 MB');
          await atomicWrite(file, next); return result({ edited: params.path });
        } }),
    );
  }
  return tools;
}


export class PiEngine {
  constructor(private config: Config, private overrides: RuntimeOverrides = {}) {}
  get configured() { return Boolean(this.config.llm); }

  async session(workspace: string, role: 'author' | 'reviewer', fps: number, signal: AbortSignal, progress: Progress, review?: (value: Review) => void, subject: PromptSubject = 'math') {
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
    const customTools = toolsFor(workspace, fps, this.config, role === 'reviewer' ? review : undefined).map((tool): ToolDefinition => ({
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

  async authorAndReview(workspace: string, job: JobRecord, signal: AbortSignal, progress: Progress, stage: (stage: 'authoring' | 'verifying' | 'reviewing') => Promise<void>) {
    const timeout = AbortSignal.timeout(this.config.agentTimeoutMs), bounded = AbortSignal.any([signal, timeout]);
    const images = await Promise.all(job.input.images.map(async image => ({ type: 'image' as const, mimeType: image.mimeType,
      data: (await fs.readFile(path.join(workspace, image.file))).toString('base64') })));
    const request = JSON.stringify({ ...job.input, images: job.input.images.map(i => ({ mimeType: i.mimeType })) });
    const author = await this.session(workspace, 'author', job.input.options.fps, bounded, progress, undefined, job.input.scope.subject);
    try {
      let feedback = '';
      for (let attempt = 0; attempt <= this.config.maxRepairAttempts; attempt++) {
        await stage('authoring');
        const initialFeedback = job.error ? `\n上一次流水线失败：${JSON.stringify(job.error)}。读取相应报告并修复原因，保留正确的讲稿、数学模型和推理。若必须改稿，旧音频会自动失效；不要通过隐藏内容绕过检查。` : '';
        await author.prompt(attempt === 0 ? `请为以下输入生成完整项目。不要询问是否开始。先读工作区约定。已有文件时先读取并修正。\n<request>${request}</request>${initialFeedback}` : `修复以下检查问题，保留已经正确的内容，再完整校验：\n${feedback}`, attempt === 0 ? images : undefined);
        await stage('verifying'); const verified = await validateWorkspace(workspace, job.input.options.fps);
        if (!verified.passed || !('lesson' in verified)) { feedback = JSON.stringify(verified); continue; }
        await stage('reviewing'); let submitted: Review | undefined;
        const reviewer = await this.session(workspace, 'reviewer', job.input.options.fps, bounded, progress, value => { submitted = value; }, job.input.scope.subject);
        try { await reviewer.prompt(`独立审核此输入和已生成的项目。必须读取完整文件并提交结构化审核。\n<request>${request}</request>`, images); }
        finally { reviewer.dispose(); }
        if (!submitted) throw new PipelineError('REVIEW_MISSING', 'Independent reviewer did not submit a review');
        const digest = await sourceDigest(workspace);
        const reviewRecord = { ...submitted, sourceSha256: digest, subject: job.input.scope.subject,
          promptSha256: sha256(await loadAgentPrompt('reviewer', job.input.scope.subject)),
          mode: this.overrides.streamSimple ? 'fixture' : 'live-model' };
        await writeJson(path.join(workspace, `reports/review-${attempt + 1}.json`), reviewRecord);
        await writeJson(path.join(workspace, 'reports/review.json'), reviewRecord);
        if (submitted.approved) return { lesson: verified.lesson, sourceSha256: digest };
        feedback = JSON.stringify(submitted);
      }
      throw new PipelineError('QUALITY_GATE_FAILED', `Authoring/review did not pass after ${this.config.maxRepairAttempts + 1} attempts: ${feedback.slice(0, 4000)}`);
    } catch (error) {
      if (timeout.aborted && !signal.aborted) throw new PipelineError('AGENT_TIMEOUT', 'Authoring/review exceeded ' + this.config.agentTimeoutMs + ' ms');
      throw error;
    } finally { author.dispose(); }
  }
}
