import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAgentPrompt, promptFiles } from '../core/prompts.js';

test('author and reviewer prompts combine the base role with the selected subject', async () => {
  const author = await loadAgentPrompt('author', 'math');
  const reviewer = await loadAgentPrompt('reviewer', 'physics');
  const chemistry = await loadAgentPrompt('author', 'chemistry');

  assert.match(author, /^# 基础作者提示词/);
  assert.match(author, /数学科目参考/);
  assert.match(author, /定义域/);
  assert.match(reviewer, /^# 基础审核者提示词/);
  assert.match(reviewer, /文字审计/);
  assert.match(reviewer, /物理科目参考/);
  assert.match(reviewer, /单位|量纲/);
  assert.match(chemistry, /化学科目参考/);
  assert.match(chemistry, /配平|守恒/);
  assert.notEqual(author, chemistry);
});

test('prompt files are resolved under prompts/base and prompts/subjects', () => {
  const files = promptFiles('reviewer', 'chemistry');
  assert.match(files.base, /prompts\/base\/reviewer\.md$/);
  assert.match(files.subject, /prompts\/subjects\/chemistry\.md$/);
});
