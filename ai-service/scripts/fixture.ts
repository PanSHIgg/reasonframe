/** Deterministic provider for offline SDK/pipeline verification. Never exposed as a service model option. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { AssistantMessageEventStream, type AssistantMessage, type Context } from '@mariozechner/pi-ai';
import { MODEL_DEFAULTS, type Config } from '../core/config.js';
import { PiEngine, type RuntimeOverrides } from '../core/pi.js';
import { PROJECT_ROOT } from '../core/paths.js';
import type { Answer } from '../shared/schema.js';

export interface PlannedTool { name: string; arguments: Record<string, unknown>; }
export function plannedProvider(plan: (context: Context) => PlannedTool | undefined): NonNullable<RuntimeOverrides['streamSimple']> {
  let serial = 0;
  return (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => {
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [], stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      try {
        if (options?.signal?.aborted) throw new Error('Fixture aborted');
        const previous = context.messages.at(-1);
        if (previous?.role === 'toolResult' && previous.isError) throw new Error(`Fixture tool failed: ${JSON.stringify(previous.content)}`);
        const step = plan(context);
        if (step) { message.content = [{ type: 'toolCall', id: `fixture_${++serial}`, name: step.name, arguments: step.arguments }]; message.stopReason = 'toolUse'; }
        else message.content = [{ type: 'text', text: 'Offline fixture completed; no remote model inference was performed.' }];
        stream.push({ type: 'start', partial: message });
        if (step) {
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: message.content[0] as any, partial: message });
        }
        stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); stream.end(message);
      } catch (e) {
        message.stopReason = 'error'; message.errorMessage = (e as Error).message;
        stream.push({ type: 'error', reason: 'error', error: message }); stream.end(message);
      }
    });
    return stream;
  };
}

export interface ExampleEngineOptions {
  rejectReview?: boolean;
  rejectAnswerRounds?: number;
  rejectVideoRounds?: number;
  preview?: RuntimeOverrides['preview'];
  observe?: (kind: 'answer-author' | 'answer-reviewer' | 'video-author' | 'video-reviewer', context: Context) => void;
}

export async function exampleEngine(config: Config, options: ExampleEngineOptions = {}) {
  const example = path.join(PROJECT_ROOT, 'examples/solid-geometry');
  const [lesson, visual, style] = await Promise.all(['lesson.json', 'src/visual.js', 'src/style.css'].map(f => fs.readFile(path.join(example, f), 'utf8')));
  const parsedLesson = JSON.parse(lesson) as { title: string; subtitle: string; expectedAnswer: string; assumptions: string[]; chapters: string[]; model: Record<string, unknown>; claims: unknown[]; scenes: { id: string; title: string; chapter: number; beats: { say: string; caption?: string }[] }[] };
  const answer: Answer = {
    schemaVersion: 1, title: parsedLesson.title, subtitle: parsedLesson.subtitle,
    expectedAnswer: parsedLesson.expectedAnswer, assumptions: parsedLesson.assumptions,
    chapters: parsedLesson.chapters, model: parsedLesson.model as Answer['model'], claims: parsedLesson.claims as Answer['claims'],
    solution: `完整解答：${parsedLesson.expectedAnswer}`,
    scenes: parsedLesson.scenes.map(scene => ({ id: scene.id, title: scene.title, chapter: scene.chapter, beats: scene.beats })),
  };
  const answerAuthor: PlannedTool[] = [
    { name: 'read_file', arguments: { path: 'AUTHORING.md' } }, { name: 'read_file', arguments: { path: 'schema.json' } },
    { name: 'read_answer', arguments: {} },
    { name: 'write_answer', arguments: { answer } },
    { name: 'validate_answer', arguments: {} },
  ];
  const answerReads = ['answer.json', 'reports/answer-check.json', 'reports/answer-math.json'];
  const videoAuthor: PlannedTool[] = [
    { name: 'read_file', arguments: { path: 'AUTHORING.md' } }, { name: 'read_file', arguments: { path: 'schema.json' } },
    { name: 'read_answer', arguments: {} },
    { name: 'read_file', arguments: { path: 'answer.json' } },
    { name: 'write_lesson', arguments: { lesson: JSON.parse(lesson) } },
    { name: 'write_file', arguments: { path: 'src/visual.js', content: visual } },
    { name: 'write_file', arguments: { path: 'src/style.css', content: style } },
  ];
  const videoReads = ['answer.json', 'answer.json', 'lesson.json', 'src/visual.js', 'src/style.css', 'reports/math.json', 'reports/structure.json'];
  let answerReviewRound = 0, videoReviewRound = 0;
  const rejectAnswerAfter = options.rejectReview ? Number.POSITIVE_INFINITY : (options.rejectAnswerRounds ?? 0);
  const rejectVideoAfter = options.rejectVideoRounds ?? 0;
  const fixtureConfig: Config = { ...config, llm: { ...MODEL_DEFAULTS, endpoint: 'responses', url: 'https://fixture.invalid/v1', apiKey: 'fixture-not-a-real-key', model: 'offline-fixture' } };
  const provider = plannedProvider(context => {
    const tools = new Set(context.tools?.map(tool => tool.name));
    const lastUser = context.messages.findLastIndex(m => m.role === 'user');
    const done = context.messages.slice(lastUser + 1).filter(m => m.role === 'toolResult').length;
    if (tools.has('submit_answer_review')) {
      if (done < answerReads.length) return { name: 'read_file', arguments: { path: answerReads[done] } };
      if (done > answerReads.length) return undefined;
      const reject = answerReviewRound++ < rejectAnswerAfter;
      return { name: 'submit_answer_review', arguments: {
        approved: !reject,
        checks: { textClean: !reject, problemFaithful: !reject, mathSound: true, reasoningClear: true, notationConsistent: true, scopeRespected: true, narrationComplete: true, answerComplete: true },
        answer: parsedLesson.expectedAnswer, issues: reject ? ['Offline fixture intentionally rejected the answer'] : [],
      } };
    }
    if (tools.has('submit_video_review')) {
      if (done < videoReads.length) return { name: 'read_file', arguments: { path: videoReads[done] } };
      if (done > videoReads.length) return undefined;
      const reject = videoReviewRound++ < rejectVideoAfter;
      return { name: 'submit_video_review', arguments: {
        approved: !reject,
        checks: { textClean: !reject, problemFaithful: !reject, mathSound: true, reasoningClear: true, notationConsistent: true, scopeRespected: true,
          visualsConsistent: true, narrationComplete: true, layoutClean: !reject },
        answer: parsedLesson.expectedAnswer, issues: reject ? ['Offline fixture intentionally rejected the video'] : [],
      } };
    }
    const plan = tools.has('write_answer') ? answerAuthor : videoAuthor;
    return plan[done];
  });
  return new PiEngine(fixtureConfig, { preview: options.preview, streamSimple: (model, context, streamOptions) => {
    const tools = new Set(context.tools?.map(tool => tool.name));
    const kind = tools.has('submit_answer_review') ? 'answer-reviewer'
      : tools.has('submit_video_review') ? 'video-reviewer'
        : tools.has('write_answer') ? 'answer-author' : 'video-author';
    options.observe?.(kind, context);
    return provider(model, context, streamOptions);
  } });
}
