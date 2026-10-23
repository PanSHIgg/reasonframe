import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context } from '@mariozechner/pi-ai';
import { setup, exampleAnswer, exampleInput } from '../helpers.js';
import { exampleEngine } from '../../scripts/fixture.js';
import { MODEL_DEFAULTS } from '../../core/config.js';
import { answerDigest, answerNarration } from '../../core/answer.js';
import { readJson, sha256, sourceDigest, writeJson } from '../../core/files.js';
import { AnswerSchema, ReviewSchema, type JobRecord } from '../../shared/schema.js';
import type { PreviewOverride } from '../../core/pi.js';

const answerRejection = 'Offline fixture intentionally rejected the answer';
const videoRejection = 'Offline fixture intentionally rejected the video';

async function jobRecord(): Promise<JobRecord> {
  const input = await exampleInput();
  const now = new Date().toISOString();
  return { id: randomUUID(), status: 'queued', stage: 'queued', createdAt: now, updatedAt: now,
    input: { ...input, images: [] }, attempt: 0, eventSequence: 0, artifacts: [] };
}

const passedPreview: PreviewOverride = async workspace => {
  await fs.mkdir(path.join(workspace, 'reports/frames'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'reports/frames/fake.png'), 'fake png');
  return { available: true, passed: true, samples: [{ file: 'reports/frames/fake.png' }], report: { passed: true } };
};

function contains(messages: Context['messages'], text: string) {
  return JSON.stringify(messages).includes(text);
}

test('answer loop preserves the author session while each reviewer round starts fresh', async () => {
  const s = await setup();
  try {
    const observed: { kind: string; messages: Context['messages'] }[] = [];
    const engine = await exampleEngine(s.config, { rejectAnswerRounds: 1, observe: (kind, context) => observed.push({ kind, messages: structuredClone(context.messages) }) });
    const job = await jobRecord();
    const result = await engine.answerAndReview(s.temp, job, new AbortController().signal, async () => {}, async () => {});
    const onDisk = AnswerSchema.parse(await readJson(path.join(s.temp, 'answer.json')));
    assert.equal(result.scriptSha256, sha256(answerNarration(onDisk)));
    assert.equal(result.answerSha256, answerDigest(onDisk, result.scriptSha256));

    const author = observed.filter(item => item.kind === 'answer-author');
    const reviewer = observed.filter(item => item.kind === 'answer-reviewer');
    assert.ok(author.length >= 2);
    assert.ok(reviewer.length >= 2);
    const lastAuthor = observed.findLastIndex(item => item.kind === 'answer-author');
    assert.ok(author.some(item => contains(item.messages, answerRejection)), 'author should receive reviewer feedback in its preserved session');
    assert.ok(author.some(item => item.messages.some(message => message.role === 'toolResult' && message.toolName === 'write_answer')), 'author session should retain its earlier tool results');
    const laterReviewers = observed.slice(lastAuthor + 1).filter(item => item.kind === 'answer-reviewer');
    assert.ok(laterReviewers.length > 0);
    assert.ok(laterReviewers.every(item => !contains(item.messages, answerRejection)), 'a fresh reviewer must not see the previous reviewer dialogue');
    assert.ok(reviewer.every(item => !item.messages.some(message => message.role === 'toolResult' && message.toolName === 'write_answer')), 'reviewers must not share the author tool history');
  } finally { await s.cleanup(); }
});

test('video loop preserves the video author session while each reviewer round starts fresh', async () => {
  const s = await setup();
  try {
    await writeJson(path.join(s.temp, 'answer.json'), await exampleAnswer());
    const observed: { kind: string; messages: Context['messages'] }[] = [];
    const engine = await exampleEngine(s.config, { rejectVideoRounds: 1, preview: passedPreview,
      observe: (kind, context) => observed.push({ kind, messages: structuredClone(context.messages) }) });
    const job = await jobRecord();
    const result = await engine.videoAndReview(s.temp, job, new AbortController().signal, async () => {}, async () => {});
    assert.equal(result.review.approved, true);
    assert.equal(result.sourceSha256, await sourceDigest(s.temp));
    assert.equal(ReviewSchema.safeParse(result.review).success, true);

    const author = observed.filter(item => item.kind === 'video-author');
    const reviewer = observed.filter(item => item.kind === 'video-reviewer');
    assert.ok(author.length >= 2);
    assert.ok(reviewer.length >= 2);
    const lastAuthor = observed.findLastIndex(item => item.kind === 'video-author');
    assert.ok(author.some(item => contains(item.messages, videoRejection)), 'video author should receive reviewer feedback in its preserved session');
    assert.ok(author.some(item => item.messages.some(message => message.role === 'toolResult' && message.toolName === 'write_lesson')), 'video author session should retain its earlier lesson writes');
    const laterReviewers = observed.slice(lastAuthor + 1).filter(item => item.kind === 'video-reviewer');
    assert.ok(laterReviewers.length > 0);
    assert.ok(laterReviewers.every(item => !contains(item.messages, videoRejection)), 'a fresh video reviewer must not see the previous reviewer dialogue');
    assert.ok(reviewer.every(item => !item.messages.some(message => message.role === 'toolResult' && ['write_lesson', 'write_file'].includes(message.toolName))), 'video reviewers must not share the author tool history');
  } finally { await s.cleanup(); }
});

test('the video author cannot rewrite approved narration', async () => {
  const s = await setup();
  try {
    const answer = await exampleAnswer();
    await writeJson(path.join(s.temp, 'answer.json'), answer);
    const { plannedProvider } = await import('../../scripts/fixture.js');
    const { exampleLesson } = await import('../helpers.js');
    const { PiEngine } = await import('../../core/pi.js');
    const lesson = await exampleLesson();
    lesson.scenes[0].beats[0].say = '这是未经答案审核的新旁白。';
    const fixtureConfig = { ...s.config, llm: { ...MODEL_DEFAULTS, endpoint: 'responses' as const, url: 'https://fixture.invalid/v1', apiKey: 'fixture-not-a-real-key', model: 'offline-fixture' } };
    const engine = new PiEngine(fixtureConfig, { streamSimple: plannedProvider(() => ({ name: 'write_lesson', arguments: { lesson } })) });
    const session = await engine.session(s.temp, 'video-author', 24, AbortSignal.timeout(3000), async () => {});
    try {
      await assert.rejects(session.prompt('Write the lesson.'), { code: 'AGENT_RESPONSE_FAILED' });
      await assert.rejects(fs.access(path.join(s.temp, 'lesson.json')), { code: 'ENOENT' });
    } finally { session.dispose(); }
  } finally { await s.cleanup(); }
});
