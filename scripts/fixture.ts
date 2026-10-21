/** Deterministic provider for offline SDK/pipeline verification. Never exposed as a service model option. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { AssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Api } from '@mariozechner/pi-ai';
import { MODEL_DEFAULTS, type Config } from '../core/config.js';
import { PiEngine, type RuntimeOverrides } from '../core/pi.js';
import { PROJECT_ROOT } from '../core/paths.js';

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
export async function exampleEngine(config: Config, options: { rejectReview?: boolean } = {}) {
  const example = path.join(PROJECT_ROOT, 'examples/solid-geometry');
  const [lesson, visual, style] = await Promise.all(['lesson.json', 'src/visual.js', 'src/style.css'].map(f => fs.readFile(path.join(example, f), 'utf8')));
  const author: PlannedTool[] = [
    { name: 'read_file', arguments: { path: 'AUTHORING.md' } }, { name: 'read_file', arguments: { path: 'schema.json' } },
    ...[['lesson.json', lesson], ['src/visual.js', visual], ['src/style.css', style]].map(([file, content]) => ({ name: 'write_file', arguments: { path: file, content } })),
    { name: 'validate_lesson', arguments: {} },
  ];
  const reviewer: PlannedTool[] = ['lesson.json', 'src/visual.js', 'src/style.css', 'reports/math.json', 'reports/structure.json'].map(file => ({ name: 'read_file', arguments: { path: file } }));
  reviewer.push({ name: 'submit_review', arguments: { approved: !options.rejectReview,
    checks: { textClean: !options.rejectReview, problemFaithful: !options.rejectReview, mathSound: true, reasoningClear: true, notationConsistent: true, scopeRespected: true, visualsConsistent: true, narrationComplete: true, layoutClean: true },
    answer: 'AO=1，R=√3，cos θ=√2/3', issues: options.rejectReview ? ['Offline fixture intentionally rejected the lesson'] : [] } });
  const fixtureConfig: Config = { ...config, llm: { ...MODEL_DEFAULTS, endpoint: 'responses', url: 'https://fixture.invalid/v1', apiKey: 'fixture-not-a-real-key', model: 'offline-fixture' } };
  return new PiEngine(fixtureConfig, { streamSimple: plannedProvider(context => {
    const lastUser = context.messages.findLastIndex(m => m.role === 'user');
    const done = context.messages.slice(lastUser + 1).filter(m => m.role === 'toolResult').length;
    return (context.tools?.some(t => t.name === 'submit_review') ? reviewer : author)[done];
  }) });
}
