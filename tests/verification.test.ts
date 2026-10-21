import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMath, validateStructure } from '../core/verification.js';
import { exampleLesson } from './helpers.js';
import { ClaimSchema } from '../shared/schema.js';

test('checks use the rendered coordinates and independently recover the sphere center', async () => {
  const lesson = await exampleLesson();
  assert.equal(validateStructure(lesson).passed, true); assert.equal(verifyMath(lesson).passed, true);
  assert(verifyMath(lesson).results.some(r => r.id === 'independent_center' && r.passed));
  const wrongPoint = structuredClone(lesson); (wrongPoint.model.C as number[])[0] += 0.2;
  const result = verifyMath(wrongPoint); assert.equal(result.passed, false);
  assert(result.results.some(r => r.id === 'length_BC' && !r.passed));
  const wrongCenter = structuredClone(lesson); wrongCenter.model.O = [1.1, 0, 0];
  assert(verifyMath(wrongCenter).results.some(r => r.id === 'independent_center' && !r.passed));
  const tiny = structuredClone(lesson); tiny.model.charge = 1.6e-19;
  tiny.claims[0] = ClaimSchema.parse({ id: 'charge_zero', description: '微小非零电荷不能误判为零', kind: 'given', left: 'charge', right: '0' });
  assert.equal(verifyMath(tiny).results[0].passed, false);
});
test('unsafe expressions, self comparisons and unbound visual/cue references are rejected', async () => {
  const lesson = await exampleLesson();
  for (const expression of ['import("node:fs")', 'P[1]', '2^1000000', 'x=3']) {
    const modified = structuredClone(lesson); modified.claims[0].left = expression;
    assert.equal(verifyMath(modified).passed, false, expression);
  }
  const self = structuredClone(lesson); self.claims[0].left = '3'; self.claims[0].right = '3'; assert.equal(verifyMath(self).passed, false);
  const cue = structuredClone(lesson); cue.scenes[0].cues[0].objects = ['plane:missing']; assert.equal(validateStructure(cue).passed, false);
  const missing = structuredClone(lesson); missing.scenes[0].reveals.pop(); assert.equal(validateStructure(missing).passed, false);
});
