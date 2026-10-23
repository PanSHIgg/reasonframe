import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export async function atomicWrite(file: string, data: string | Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, data, { mode: 0o600 }); await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }); }
}
export const writeJson = (file: string, value: unknown) => atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
export async function readJson<T = unknown>(file: string): Promise<T> { return JSON.parse(await fs.readFile(file, 'utf8')); }
export function containedPath(root: string, relative: string) {
  if (relative.includes('\0') || path.isAbsolute(relative) || relative.includes('\\')) throw new Error('Invalid workspace path');
  const result = path.resolve(root, relative), rel = path.relative(root, result);
  if (!rel || rel === '..' || rel.startsWith('../')) throw new Error('Path escapes the workspace'); return result;
}
export async function safeFile(root: string, relative: string) {
  const file = containedPath(root, relative); let parent = file;
  while (true) {
    try {
      const real = await fs.realpath(parent), rel = path.relative(await fs.realpath(root), real);
      if (rel === '..' || rel.startsWith('../')) throw new Error('Symlink escapes the workspace'); break;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; parent = path.dirname(parent); }
  }
  return file;
}
export function decodeBase64(value: string, limit: number) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw new Error('Expected plain base64 without a data URL prefix');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > limit) throw new Error(`Decoded file must be between 1 and ${limit} bytes`); return bytes;
}
export async function sourceDigest(workspace: string) {
  const files = ['lesson.json', 'src/visual.js', 'src/style.css'];
  const content = await Promise.all(files.map(async f => `${f}\0${sha256(await fs.readFile(await safeFile(workspace, f)))}\n`)); return sha256(content.join(''));
}
