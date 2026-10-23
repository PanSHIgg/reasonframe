import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSchema } from '../shared/schema.js';

const checks = {
  textClean: true, problemFaithful: true, mathSound: true, reasoningClear: true, notationConsistent: true,
  scopeRespected: true, visualsConsistent: true, narrationComplete: true, layoutClean: true,
};
const review = { approved: true, checks, answer: 'B、D', issues: [] };

test('review approval requires the text and reasoning gates', () => {
  assert.equal(ReviewSchema.safeParse(review).success, true);
  for (const key of ['textClean', 'reasoningClear', 'notationConsistent', 'layoutClean'] as const) {
    const result = ReviewSchema.safeParse({ ...review, checks: { ...checks, [key]: false } });
    assert.equal(result.success, false, `${key}=false must block approval`);
  }
});

test('review issues must be empty for approval', () => {
  assert.equal(ReviewSchema.safeParse({ ...review, issues: ['[文字] 标题：错字'] }).success, false);
  assert.equal(ReviewSchema.safeParse({ ...review, approved: false, checks: { ...checks, textClean: false }, issues: ['[文字] 标题：错字'] }).success, true);
});

test('answer review approval requires answer, narration and text gates', async () => {
  const { AnswerReviewSchema } = await import('../shared/schema.js');
  const checks = { textClean: true, problemFaithful: true, mathSound: true, reasoningClear: true, notationConsistent: true, scopeRespected: true, narrationComplete: true, answerComplete: true };
  assert.equal(AnswerReviewSchema.safeParse({ approved: true, checks, answer: 'B、D', issues: [] }).success, true);
  for (const key of ['textClean', 'reasoningClear', 'narrationComplete', 'answerComplete'] as const) {
    assert.equal(AnswerReviewSchema.safeParse({ approved: true, checks: { ...checks, [key]: false }, answer: 'B、D', issues: [] }).success, false, `${key}=false must block answer approval`);
  }
  assert.equal(AnswerReviewSchema.safeParse({ approved: true, checks, answer: 'B、D', issues: ['[文字] 标题：错字'] }).success, false);
});
