import test from 'node:test';
import assert from 'node:assert/strict';
import { PipelineError } from '../core/process.js';
import { classifyFailure, isModelUnavailable } from '../src/types.js';

test('upstream model failures are retryable and select the next profile', () => {
  const failure = classifyFailure(new PipelineError('AGENT_RESPONSE_FAILED', '402 Upstream request failed: Endpoint is unavailable.'));
  assert.equal(failure.code, 'MODEL_UNAVAILABLE');
  assert.equal(failure.retryable, true);
  assert.equal(failure.repairable, false);
});

test('transport failures during a model stream are treated as model outages', () => {
  const failure = classifyFailure(new PipelineError('AGENT_RESPONSE_FAILED', 'Connection error.'));
  assert.equal(failure.code, 'MODEL_UNAVAILABLE');
  assert.equal(failure.retryable, true);
});

test('model detection covers rate limits, server errors and missing models without matching arbitrary numbers', () => {
  for (const message of [
    '429 Too Many Requests',
    '503 Service Unavailable',
    'rate limit exceeded',
    'model minimax-m3.1-flash-free was not found',
    '403 This model is not available in your country',
  ]) assert.equal(isModelUnavailable(message), true, message);
  for (const message of ['lesson has 500 blocks', 'invalid answer at line 402', 'visual check failed']) {
    assert.equal(isModelUnavailable(message), false, message);
  }
});

test('content and render failures are not misclassified as model outages', () => {
  assert.equal(classifyFailure(new PipelineError('VIDEO_CHECK_FAILED', 'frame mismatch')).code, 'VIDEO_CHECK_FAILED');
  assert.equal(classifyFailure(new PipelineError('VISUAL_CHECK_FAILED', 'label collision')).code, 'VISUAL_CHECK_FAILED');
});
