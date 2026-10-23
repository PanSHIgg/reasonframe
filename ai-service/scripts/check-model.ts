/** Explicit, opt-in live model check. Uses .env; never prints or persists credentials. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../core/config.js';
import { PiEngine } from '../core/pi.js';
import { prepareWorkspace } from '../core/compiler.js';
import { readJson, sha256, writeJson } from '../core/files.js';
import { validateWorkspace } from '../core/verification.js';
import { answerDigest, answerNarration } from '../core/answer.js';
import { loadAgentPrompt } from '../core/prompts.js';
import { AnswerReviewSchema, AnswerSchema, JobInputSchema, type Review } from '../shared/schema.js';

const config = await loadConfig();
if (!config.llm) throw new Error('Configure LLM_ENDPOINT, LLM_URL, LLM_API_KEY and LLM_MODEL before running this live check.');
const workspace = path.join(config.root, '.reasonframe', 'model-check-' + Date.now());
const reportFile = path.join(workspace, 'report.json');
const report: Record<string, any> = { startedAt: new Date().toISOString(), mode: 'live-model', model: config.llm.model,
  endpoint: config.llm.endpoint, url: config.llm.url, contextWindow: config.llm.contextWindow, maxTokens: config.llm.maxTokens,
  passed: false, httpStatuses: [], events: [],
  scope: 'Existing verified geometry sample: real file editing, validation, and isolated read-only review.' };
const start = Date.now(), engine = new PiEngine(config);
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(config.agentTimeoutMs, 300000))]);
const onInterrupt = () => controller.abort(); process.once('SIGINT', onInterrupt);
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const response = await originalFetch(input, init);
  const url = input instanceof Request ? input.url : String(input);
  if (new URL(url).origin === new URL(config.llm!.url).origin) report.httpStatuses.push(response.status);
  return response;
}) as typeof fetch;
const progress = async (type: string, data: unknown) => {
  const event = { time: new Date().toISOString(), type, data }; report.events.push(event);
  if (['agent.request', 'agent.tool', 'agent.retry'].includes(type)) console.log(JSON.stringify(event));
};
let author: Awaited<ReturnType<PiEngine['session']>> | undefined;
let reviewer: Awaited<ReturnType<PiEngine['session']>> | undefined;
try {
  const example = path.join(config.root, 'examples/solid-geometry');
  const input = JobInputSchema.parse(await readJson(path.join(example, 'request.json')));
  input.images = []; input.options.audio = 'provided';
  report.subject = input.scope.subject;
  await prepareWorkspace(workspace, input);
  const files = ['lesson.json', 'src/visual.js', 'src/style.css'];
  await Promise.all(files.map(file => fs.copyFile(path.join(example, file), path.join(workspace, file))));
  const lesson = JSON.parse(await fs.readFile(path.join(example, 'lesson.json'), 'utf8'));
  const answer = AnswerSchema.parse({
    schemaVersion: 1, title: lesson.title, subtitle: lesson.subtitle, expectedAnswer: lesson.expectedAnswer,
    assumptions: lesson.assumptions, chapters: lesson.chapters, model: lesson.model, claims: lesson.claims,
    solution: `完整解答：${lesson.expectedAnswer}`,
    scenes: lesson.scenes.map((scene: any) => ({ id: scene.id, title: scene.title, chapter: scene.chapter, beats: scene.beats })),
  });
  const scriptSha256 = sha256(answerNarration(answer)), answerSha256 = answerDigest(answer, scriptSha256);
  await writeJson(path.join(workspace, 'answer.json'), answer);
  await writeJson(path.join(workspace, 'reports/answer-review.json'), {
    approved: true, checks: { textClean: true, problemFaithful: true, mathSound: true, reasoningClear: true, notationConsistent: true, scopeRespected: true, narrationComplete: true, answerComplete: true },
    answer: answer.expectedAnswer, issues: [], answerSha256, sourceSha256: answerSha256, scriptSha256, promptSha256: sha256(await loadAgentPrompt('answer-reviewer', input.scope.subject)),
  });
  const before = new Map(await Promise.all(files.map(async file => [file, await fs.readFile(path.join(workspace, file), 'utf8')] as const)));
  const marker = '/* ReasonFrame live model check: ' + randomUUID() + ' */';
  author = await engine.session(workspace, 'video-author', input.options.fps, signal, progress, undefined, input.scope.subject);
  await author.prompt('这是一次真实 API 与代码编辑工具自检，工作区已放入已批准答案和完整讲解项目。先读 AUTHORING.md、schema.json、answer.json，再读 src/style.css。只在样式文件末尾追加以下注释，完整保留原有样式正文，使用 edit_file 或 write_file 工具；不要修改 lesson.json 和 src/visual.js，也不要改写已批准答案或旁白。然后调用 validate_lesson，检查通过后结束，不要扩展项目。\n' + marker);
  author.dispose(); author = undefined;
  const style = await fs.readFile(path.join(workspace, 'src/style.css'), 'utf8');
  assert(style.includes(marker), 'The real model did not write the requested marker through file tools');
  assert.equal(style.replace(marker, '').trim(), before.get('src/style.css')!.trim(), 'The check must preserve the existing CSS');
  for (const file of files.slice(0, 2)) assert.equal(sha256(await fs.readFile(path.join(workspace, file))), sha256(before.get(file)!), file + ' changed during a CSS-only test');
  assert(report.events.some((e: any) => e.type === 'agent.tool' && ['write_file', 'edit_file'].includes(e.data.tool)), 'No real file-editing tool was called');
  assert(report.events.some((e: any) => e.type === 'agent.tool' && e.data.tool === 'validate_lesson'), 'The model did not call validate_lesson');
  const verified = await validateWorkspace(workspace, input.options.fps);
  assert(verified.passed, 'The edited project did not pass deterministic validation');
  report.author = { passed: true, fileEdited: 'src/style.css', deterministicValidation: true };
  console.log(JSON.stringify({ stage: 'author-passed', elapsedMs: Date.now() - start }));
  let submitted: Review | undefined;
  reviewer = await engine.session(workspace, 'video-reviewer', input.options.fps, signal, progress, value => { submitted = value; }, input.scope.subject);
  await reviewer.prompt('对原题、已批准答案与工作区讲解进行实质性的独立只读审核。先独立解题，再读完整 answer.json、lesson.json、src/visual.js、src/style.css 及检查和预览报告，最后必须调用 submit_video_review。没有音频/帧时不要假装做过像素级检查，也不能仅因后续阶段尚无报告而拒绝；不要因为这是连通性测试而自动批准，发现内容问题应如实拒绝。\n<request>' + JSON.stringify(input) + '</request>');
  reviewer.dispose(); reviewer = undefined;
  assert(submitted, 'The real model did not submit a structured independent review');
  report.review = submitted;
  // An honest rejection also demonstrates a working review protocol; content approval is recorded separately.
  report.passed = true;
} catch (error) {
  const e = error as Error & { code?: string };
  const message = String(e.message || e).split(config.llm.apiKey).join('[REDACTED]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
  report.error = { code: e.code || (signal.aborted ? 'CHECK_TIMEOUT' : 'MODEL_CHECK_FAILED'), message };
  process.exitCode = 1;
} finally {
  author?.dispose(); reviewer?.dispose(); globalThis.fetch = originalFetch;
  process.removeListener('SIGINT', onInterrupt);
  report.elapsedMs = Date.now() - start; report.finishedAt = new Date().toISOString();
  await writeJson(reportFile, report);
  console.log(JSON.stringify({ passed: report.passed, model: report.model, httpStatuses: report.httpStatuses,
    author: report.author, reviewSubmitted: Boolean(report.review), reviewApproved: report.review?.approved,
    error: report.error, elapsedMs: report.elapsedMs, report: reportFile }, null, 2));
}
