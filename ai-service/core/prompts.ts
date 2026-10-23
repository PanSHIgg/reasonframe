import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from './paths.js';
import type { JobInput } from '../shared/schema.js';

export type PromptRole = 'answer-author' | 'answer-reviewer' | 'video-author' | 'video-reviewer';
export type AgentRole = PromptRole | 'author' | 'reviewer';
export type PromptSubject = JobInput['scope']['subject'];

const cache = new Map<string, string>();

export function normalizePromptRole(role: AgentRole): PromptRole {
  if (role === 'author') return 'video-author';
  if (role === 'reviewer') return 'video-reviewer';
  return role;
}

export function promptFiles(role: PromptRole, subject: PromptSubject) {
  return {
    base: path.join(PROJECT_ROOT, 'prompts', 'base', `${role}.md`),
    subject: path.join(PROJECT_ROOT, 'prompts', 'subjects', `${subject}.md`),
  };
}

export async function loadAgentPrompt(role: PromptRole, subject: PromptSubject): Promise<string> {
  const key = `${role}:${subject}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const files = promptFiles(role, subject);
  const [base, reference] = await Promise.all([fs.readFile(files.base, 'utf8'), fs.readFile(files.subject, 'utf8')]);
  const prompt = `${base.trim()}\n\n---\n\n${reference.trim()}\n`;
  cache.set(key, prompt);
  return prompt;
}
