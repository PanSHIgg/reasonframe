import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { align, narration, normalized, type Timeline } from '../core/alignment.js';
import { readJson, sha256 } from '../core/files.js';
import type { WordTable } from '../shared/schema.js';
import { exampleLesson, exampleRoot } from './helpers.js';

test('new alignment reproduces all 500 words, 93 captions and 72 object cues from the verified video', async () => {
  const [lesson, words, golden, audio] = await Promise.all([exampleLesson(), readJson<WordTable>(path.join(exampleRoot, 'words.json')), readJson<Timeline>(path.join(exampleRoot, 'reference-timeline.json')), fs.readFile(path.join(exampleRoot, 'narration.mp3'))]);
  const actual = align(lesson, words, golden.audioDuration, sha256(audio));
  assert.equal(sha256(narration(lesson)), golden.speech.scriptSha256);
  assert.deepEqual(actual.words, golden.words); assert.deepEqual(actual.scenes, golden.scenes); assert.deepEqual(actual.captions, golden.captions);
  assert.equal(actual.duration, golden.duration); assert.equal(actual.alignment.coverage, 1);
  const milliseconds = { ...words, timeUnit: 'milliseconds' as const, words: words.words.map(w => ({ text: w.text, start: w.start * 1000, end: w.end! * 1000 })) };
  assert.deepEqual(align(lesson, milliseconds, golden.audioDuration, sha256(audio)).scenes, actual.scenes);
});
test('changed transcript, missing timestamps, overlap and stale script hashes block export', async () => {
  const [lesson, words, golden] = await Promise.all([exampleLesson(), readJson<WordTable>(path.join(exampleRoot, 'words.json')), readJson<Timeline>(path.join(exampleRoot, 'reference-timeline.json'))]);
  const run = (value: WordTable) => align(lesson, value, golden.audioDuration, '0'.repeat(64));
  const mismatch = structuredClone(words); mismatch.words[0].text = '错误'; assert.throws(() => run(mismatch), /mismatch/);
  const missing = structuredClone(words); missing.words.pop(); assert.throws(() => run(missing), /coverage/);
  const overlap = structuredClone(words); overlap.words[1].start = overlap.words[0].start; assert.throws(() => run(overlap), /Overlapping/);
  assert.throws(() => run({ ...words, scriptSha256: '0'.repeat(64) }), /scriptSha256/);
  const ambiguous = structuredClone(lesson); ambiguous.scenes[0].cues[0].anchor = '不存在的锚点';
  assert.throws(() => align(ambiguous, words, golden.audioDuration, '0'.repeat(64)), /anchor/);
  assert.notEqual(normalized('一+一'), normalized('一-一'));
});
