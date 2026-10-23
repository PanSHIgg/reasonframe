import fs from 'node:fs/promises';
import path from 'node:path';
import { HeadBucketCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { sha256, atomicWrite, readJson, writeJson } from '../core/files.js';
import { PipelineError } from '../core/process.js';
import type { AiConfig, StorageSettings } from './config.js';

export interface StoredObject {
  key: string;
  bytes: Buffer;
  mime_type?: string;
  sha256?: string;
  size_bytes: number;
}

export interface ObjectHead {
  key: string;
  size_bytes: number;
  mime_type?: string;
  sha256?: string;
}

export interface PutResult {
  object_key: string;
  size_bytes: number;
  sha256: string;
  mime_type: string;
}

export interface ObjectStorage {
  readonly kind: 's3' | 'local';
  readonly location: string;
  put(key: string, bytes: Uint8Array, mimeType?: string, expectedSha256?: string): Promise<PutResult>;
  get(key: string, expectedSha256?: string): Promise<StoredObject>;
  head(key: string): Promise<ObjectHead | null>;
  ready(): Promise<boolean>;
}

export function assertObjectKey(key: string) {
  if (!key || key.length > 1024 || key.startsWith('/') || key.includes('\\') || key.includes('\0')) throw new PipelineError('INVALID_OBJECT_KEY', 'Invalid object key');
  const parts = key.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new PipelineError('INVALID_OBJECT_KEY', `Unsafe object key: ${key}`);
  return key;
}

function isNotFound(error: unknown) {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value?.name === 'NotFound' || value?.name === 'NoSuchKey' || value?.name === 'NoSuchBucket' || value?.$metadata?.httpStatusCode === 404;
}

function integrity(key: string, expected: string, actual: string) {
  if (expected && expected !== actual) throw new PipelineError('STORAGE_INTEGRITY', `SHA-256 mismatch for ${key}: expected ${expected}, got ${actual}`);
}

class LocalStorage implements ObjectStorage {
  readonly kind = 'local' as const;
  readonly location: string;
  constructor(readonly root: string) { this.location = root; }
  private file(key: string) { return path.join(this.root, assertObjectKey(key)); }
  private meta(key: string) { return path.join(this.root, '.metadata', `${assertObjectKey(key)}.json`); }
  async ready() {
    try { await fs.mkdir(path.join(this.root, '.metadata'), { recursive: true, mode: 0o700 }); return true; } catch { return false; }
  }
  async put(key: string, bytes: Uint8Array, mimeType = 'application/octet-stream', expectedSha256?: string): Promise<PutResult> {
    const buffer = Buffer.from(bytes), digest = sha256(buffer);
    integrity(key, expectedSha256 ?? '', digest);
    const file = this.file(key);
    await atomicWrite(file, buffer);
    await writeJson(this.meta(key), { sha256: digest, size_bytes: buffer.length, mime_type: mimeType, updated_at: new Date().toISOString() });
    return { object_key: key, size_bytes: buffer.length, sha256: digest, mime_type: mimeType };
  }
  async get(key: string, expectedSha256?: string): Promise<StoredObject> {
    const file = this.file(key);
    let bytes: Buffer;
    try { bytes = await fs.readFile(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PipelineError('OBJECT_NOT_FOUND', `Object not found: ${key}`); throw error; }
    let metadata: { sha256?: string; mime_type?: string } = {};
    try { metadata = await readJson(this.meta(key)); } catch { /* Older local objects may not have metadata. */ }
    const digest = sha256(bytes);
    integrity(key, expectedSha256 ?? metadata.sha256 ?? '', digest);
    return { key, bytes, mime_type: metadata.mime_type, sha256: digest, size_bytes: bytes.length };
  }
  async head(key: string): Promise<ObjectHead | null> {
    try {
      const stat = await fs.stat(this.file(key));
      let metadata: { sha256?: string; mime_type?: string } = {};
      try { metadata = await readJson(this.meta(key)); } catch { /* optional */ }
      return { key, size_bytes: stat.size, mime_type: metadata.mime_type, sha256: metadata.sha256 };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
}

class S3Storage implements ObjectStorage {
  readonly kind = 's3' as const;
  readonly location: string;
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor(settings: Extract<StorageSettings, { kind: 's3' }>) {
    this.bucket = settings.bucket;
    this.location = `${settings.endpoint}/${settings.bucket}`;
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: true,
      credentials: { accessKeyId: settings.accessKey, secretAccessKey: settings.secretKey },
      ...(settings.useSSL ? {} : { tls: false }),
    });
  }
  async ready() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: AbortSignal.timeout(2500) });
      return true;
    } catch { return false; }
  }
  async put(key: string, bytes: Uint8Array, mimeType = 'application/octet-stream', expectedSha256?: string): Promise<PutResult> {
    assertObjectKey(key);
    const buffer = Buffer.from(bytes), digest = sha256(buffer);
    integrity(key, expectedSha256 ?? '', digest);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: buffer, ContentType: mimeType,
      Metadata: { sha256: digest, size: String(buffer.length) },
    }));
    return { object_key: key, size_bytes: buffer.length, sha256: digest, mime_type: mimeType };
  }
  async get(key: string, expectedSha256?: string): Promise<StoredObject> {
    assertObjectKey(key);
    let response;
    try { response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })); }
    catch (error) { if (isNotFound(error)) throw new PipelineError('OBJECT_NOT_FOUND', `Object not found: ${key}`); throw error; }
    if (!response.Body) throw new PipelineError('OBJECT_NOT_FOUND', `Object has no body: ${key}`);
    const body = response.Body as unknown as { transformToByteArray?: () => Promise<Uint8Array>; [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array> };
    let bytes: Buffer;
    if (typeof body.transformToByteArray === 'function') bytes = Buffer.from(await body.transformToByteArray());
    else {
      const chunks: Buffer[] = [];
      if (body[Symbol.asyncIterator]) for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      bytes = Buffer.concat(chunks);
    }
    const digest = sha256(bytes), expected = expectedSha256 ?? response.Metadata?.sha256;
    integrity(key, expected ?? '', digest);
    return { key, bytes, mime_type: response.ContentType, sha256: digest, size_bytes: bytes.length };
  }
  async head(key: string): Promise<ObjectHead | null> {
    assertObjectKey(key);
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        key,
        size_bytes: response.ContentLength ?? 0,
        mime_type: response.ContentType,
        sha256: response.Metadata?.sha256,
      };
    } catch (error) { if (isNotFound(error)) return null; throw error; }
  }
}

export async function createObjectStorage(config: AiConfig): Promise<ObjectStorage> {
  const storage = config.storage.kind === 's3' ? new S3Storage(config.storage) : new LocalStorage(config.storage.root);
  if (!(await storage.ready())) throw new PipelineError('STORAGE_ERROR', `Object storage is not ready: ${storage.location}`);
  return storage;
}
