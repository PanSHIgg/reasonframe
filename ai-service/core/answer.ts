import fs from 'node:fs/promises';
import path from 'node:path';
import { AnswerSchema, WordTableSchema, type Answer, type Lesson } from '../shared/schema.js';
import { align, narration, type Timeline } from './alignment.js';
import { readJson, sha256, writeJson } from './files.js';
import { PipelineError } from './process.js';
import { verifyClaims } from './verification.js';

export const answerNarration = (answer: Answer) => answer.scenes.map(scene => scene.beats.map(beat => beat.say).join('\n')).join('\n\n');

export function answerDigest(answer: Answer, scriptSha256 = sha256(answerNarration(answer))) {
  return sha256(JSON.stringify({ answer, scriptSha256 }));
}

export function narrationLesson(answer: Answer, fps: number): Lesson {
  // The alignment/TTS code only reads fps and scene beats. A full lesson is
  // synthesized by the video agent after the answer is approved.
  return {
    schemaVersion: 1, title: answer.title, subtitle: answer.subtitle, width: 1920, height: 1080, fps,
    expectedAnswer: answer.expectedAnswer, assumptions: answer.assumptions, chapters: answer.chapters,
    model: answer.model, entities: {}, claims: answer.claims,
    scenes: answer.scenes.map(scene => ({
      id: scene.id, title: scene.title, chapter: scene.chapter, stage: scene.id, note: '',
      claimIds: [], blocks: [], beats: scene.beats, cues: [], reveals: [],
    })),
  } as unknown as Lesson;
}

export function validateAnswerStructure(answer: Answer, fps?: number) {
  const issues: string[] = [];
  if (new Set(answer.claims.map(claim => claim.id)).size !== answer.claims.length) issues.push('Claim ids must be unique');
  if (!answer.claims.some(claim => claim.kind === 'given') || !answer.claims.some(claim => claim.kind === 'answer')) issues.push('Need at least one given claim and one answer claim');
  if (new Set(answer.scenes.map(scene => scene.id)).size !== answer.scenes.length) issues.push('Scene ids must be unique');
  if (fps !== undefined && ![24, 30].includes(fps)) issues.push(`Unsupported fps ${fps}`);
  for (const scene of answer.scenes) {
    if (scene.chapter >= answer.chapters.length) issues.push(`${scene.id}: unknown chapter`);
    if (!scene.beats.length) issues.push(`${scene.id}: at least one narration beat is required`);
    for (const [index, beat] of scene.beats.entries()) {
      if (/\uFFFD|锟斤拷/.test(beat.say)) issues.push(`${scene.id}/${index}: narration contains mojibake`);
      if (/https?:\/\//i.test(beat.say)) issues.push(`${scene.id}/${index}: narration must not contain URLs`);
    }
  }
  if (!answer.expectedAnswer.trim()) issues.push('expectedAnswer must not be empty');
  return { passed: issues.length === 0, issues };
}

export async function validateAnswerWorkspace(workspace: string, fps?: number) {
  let answer: Answer;
  try {
    answer = AnswerSchema.parse(await readJson(path.join(workspace, 'answer.json')));
  } catch (error) {
    const report = { passed: false as const, error: (error as Error).message };
    await writeJson(path.join(workspace, 'reports/answer-check.json'), report);
    return report;
  }
  const structure = validateAnswerStructure(answer, fps);
  const math = verifyClaims(answer.model, answer.claims);
  await Promise.all([
    writeJson(path.join(workspace, 'reports/answer-check.json'), structure),
    writeJson(path.join(workspace, 'reports/answer-math.json'), math),
  ]);
  return { passed: structure.passed && math.passed, answer, structure, math };
}

export function storyboardIssues(answer: Answer, lesson: Lesson) {
  const issues: string[] = [];
  const same = (label: string, left: unknown, right: unknown) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) issues.push(`Lesson ${label} does not match the approved answer`);
  };
  same('title', lesson.title, answer.title);
  same('subtitle', lesson.subtitle, answer.subtitle);
  same('expectedAnswer', lesson.expectedAnswer, answer.expectedAnswer);
  same('assumptions', lesson.assumptions, answer.assumptions);
  same('chapters', lesson.chapters, answer.chapters);
  same('claims', lesson.claims, answer.claims);
  for (const [key, value] of Object.entries(answer.model)) {
    if (!Object.hasOwn(lesson.model, key)) issues.push(`Lesson model is missing approved symbol ${key}`);
    else same(`model/${key}`, lesson.model[key], value);
  }
  if (lesson.scenes.length !== answer.scenes.length) {
    issues.push(`Lesson has ${lesson.scenes.length} scenes but the approved answer has ${answer.scenes.length}`);
    return issues;
  }
  for (const [index, approved] of answer.scenes.entries()) {
    const scene = lesson.scenes[index];
    if (scene.id !== approved.id) issues.push(`Scene ${index} id changed from ${approved.id} to ${scene.id}`);
    if (scene.title !== approved.title) issues.push(`${approved.id}: scene title changed after answer approval`);
    if (scene.chapter !== approved.chapter) issues.push(`${approved.id}: scene chapter changed after answer approval`);
    if (JSON.stringify(scene.beats.map(beat => ({ say: beat.say, caption: beat.caption }))) !== JSON.stringify(approved.beats.map(beat => ({ say: beat.say, caption: beat.caption })))) {
      issues.push(`${approved.id}: narration changed after answer approval`);
    }
  }
  return issues;
}

export function assertStoryboard(answer: Answer, lesson: Lesson) {
  const issues = storyboardIssues(answer, lesson);
  if (issues.length) throw new PipelineError('ANSWER_CHANGED', issues.slice(0, 20).join('; '));
}

export async function alignLessonAudio(workspace: string, lesson: Lesson, signal: AbortSignal, source?: string) {
  const timelinePath = path.join(workspace, 'timeline.json');
  let previous: Timeline;
  try { previous = await readJson<Timeline>(timelinePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PipelineError('STALE_AUDIO', 'No aligned audio is available for the video agent yet');
    throw error;
  }
  const [audio, wordTable] = await Promise.all([
    fs.readFile(path.join(workspace, 'render/assets/audio/narration.mp3')),
    readJson(path.join(workspace, 'words.json')),
  ]);
  signal.throwIfAborted();
  const audioSha256 = sha256(audio);
  if (previous.speech?.audioSha256 && previous.speech.audioSha256 !== audioSha256) throw new PipelineError('STALE_AUDIO', 'Timeline audio digest differs from the narration file');
  const words = WordTableSchema.parse(wordTable);
  const timeline = align(lesson, words, previous.audioDuration, audioSha256, source ?? previous.speech?.source ?? 'external-import');
  if (sha256(narration(lesson)) !== timeline.speech.scriptSha256) throw new PipelineError('STALE_AUDIO', 'Lesson narration differs from the approved script');
  await Promise.all([
    writeJson(timelinePath, timeline),
    writeJson(path.join(workspace, 'reports/alignment.json'), { passed: true, ...timeline.alignment, ...timeline.speech }),
  ]);
  return timeline;
}
