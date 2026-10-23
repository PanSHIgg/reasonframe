import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAgentPrompt, promptFiles } from '../core/prompts.js';

test('answer and video prompts combine each base role with the selected subject', async () => {
  const answerAuthor = await loadAgentPrompt('answer-author', 'math');
  const answerReviewer = await loadAgentPrompt('answer-reviewer', 'physics');
  const videoAuthor = await loadAgentPrompt('video-author', 'chemistry');
  const videoReviewer = await loadAgentPrompt('video-reviewer', 'math');

  assert.match(answerAuthor, /^# 基础答案作者提示词/);
  assert.match(answerAuthor, /数学科目参考/);
  assert.match(answerAuthor, /定义域/);
  assert.match(answerAuthor, /answer\.json/);
  assert.match(answerReviewer, /^# 基础答案审核者提示词/);
  assert.match(answerReviewer, /文字审计/);
  assert.match(answerReviewer, /物理科目参考/);
  assert.match(answerReviewer, /submit_answer_review/);
  assert.match(videoAuthor, /^# 基础视频作者提示词/);
  assert.match(videoAuthor, /化学科目参考/);
  assert.match(videoAuthor, /配平|守恒/);
  assert.match(videoAuthor, /不能改写/);
  assert.match(videoReviewer, /^# 基础视频审核者提示词/);
  assert.match(videoReviewer, /预览帧|实际截图/);
  assert.match(videoReviewer, /submit_video_review/);
  assert.notEqual(answerAuthor, videoAuthor);
});

test('prompt files are resolved under prompts/base and prompts/subjects', () => {
  const files = promptFiles('video-reviewer', 'chemistry');
  assert.match(files.base, /prompts\/base\/video-reviewer\.md$/);
  assert.match(files.subject, /prompts\/subjects\/chemistry\.md$/);
});
