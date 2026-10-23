import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { PROJECT_ROOT } from '../core/paths.js';
import { readJson } from '../core/files.js';
import { AnswerSchema, JobInputSchema, LessonSchema, type Answer, type Lesson } from '../shared/schema.js';

export const exampleRoot = path.join(PROJECT_ROOT, 'examples/solid-geometry');
export async function setup() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'reasonframe-test-'));
  const config = await loadConfig({ env: { REASONFRAME_STATE_DIR: temp }, root: PROJECT_ROOT });
  return { temp, config, cleanup: () => fs.rm(temp, { recursive: true, force: true }) };
}
export const exampleLesson = async () => LessonSchema.parse(await readJson(path.join(exampleRoot, 'lesson.json')));
export const exampleAnswer = async (): Promise<Answer> => {
  const lesson: Lesson = await exampleLesson();
  return AnswerSchema.parse({
    schemaVersion: 1, title: lesson.title, subtitle: lesson.subtitle,
    expectedAnswer: lesson.expectedAnswer, assumptions: lesson.assumptions,
    chapters: lesson.chapters, model: lesson.model, claims: lesson.claims,
    solution: `完整解答：${lesson.expectedAnswer}`,
    scenes: lesson.scenes.map(scene => ({ id: scene.id, title: scene.title, chapter: scene.chapter, beats: scene.beats })),
  });
};
export const exampleInput = async () => JobInputSchema.parse(await readJson(path.join(exampleRoot, 'request.json')));
