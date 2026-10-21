import express, { type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { ZodError } from 'zod';
import { AudioInputSchema, JobInputSchema, type JobEvent, type JobRecord } from '../shared/schema.js';
import { JobManager } from '../core/jobs.js';
import { publicConfig } from '../core/config.js';
import { PipelineError } from '../core/process.js';
import { safeFile } from '../core/files.js';
import { openapi } from './openapi.js';

export function createApp(manager: JobManager) {
  const app = express(); app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'reasonframe', modelConfigured: manager.engine.configured }));
  app.use((req, res, next) => {
    const key = manager.config.serviceApiKey;
    if (!key) return next();
    const value = req.get('authorization') || '', expected = `Bearer ${key}`;
    if (Buffer.byteLength(value) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(value), Buffer.from(expected))) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Valid service bearer token required' } });
    next();
  });
  app.use(express.json({ limit: '64mb' }));
  app.get('/openapi.json', (_req, res) => res.json(openapi(Boolean(manager.config.serviceApiKey))));
  const publicJob = (job: JobRecord) => ({ ...job, input: { ...job.input, images: job.input.images.map(i => ({ mimeType: i.mimeType })) },
    artifacts: job.artifacts.map(a => ({ name: a.name, mimeType: a.mimeType, url: `/v1/jobs/${job.id}/artifacts/${a.name}` })),
    eventsUrl: `/v1/jobs/${job.id}/events`, narrationUrl: `/v1/jobs/${job.id}/narration` });
  app.get('/v1/config', (_req, res) => res.json(publicConfig(manager.config)));
  app.get('/v1/jobs', (_req, res) => res.json({ jobs: manager.store.list().map(publicJob) }));
  app.post('/v1/jobs', async (req, res) => {
    const job = await manager.create(JobInputSchema.parse(req.body)); res.status(202).location(`/v1/jobs/${job.id}`).json(publicJob(job));
  });
  app.get('/v1/jobs/:id', (req, res) => res.json(publicJob(manager.store.get(req.params.id))));
  app.post('/v1/jobs/:id/cancel', async (req, res) => res.json(publicJob(await manager.cancel(req.params.id))));
  app.post('/v1/jobs/:id/retry', async (req, res) => res.status(202).json(publicJob(await manager.retry(req.params.id))));
  app.post('/v1/jobs/:id/audio', async (req, res) => res.status(202).json(publicJob(await manager.provideAudio(req.params.id, AudioInputSchema.parse(req.body)))));
  app.get('/v1/jobs/:id/narration', async (req, res) => {
    const job = manager.store.get(req.params.id);
    if (!job.scriptSha256) throw new PipelineError('INVALID_STATE', 'Narration is available after authoring and independent review');
    const fs = await import('node:fs/promises');
    res.json({ scriptSha256: job.scriptSha256, text: await fs.readFile(path.join(manager.store.workspace(job.id), 'narration.txt'), 'utf8') });
  });
  app.get('/v1/jobs/:id/artifacts/:name', async (req, res) => {
    const job = manager.store.get(req.params.id), artifact = job.artifacts.find(a => a.name === req.params.name);
    if (!artifact || (artifact.name === 'video' && job.status !== 'completed')) throw new PipelineError('NOT_FOUND', 'Artifact not found');
    const file = await safeFile(manager.store.workspace(job.id), artifact.file);
    res.type(artifact.mimeType); res.set('X-Content-Type-Options', 'nosniff'); res.set('Content-Disposition', `attachment; filename="${path.basename(artifact.file)}"`); res.sendFile(file);
  });
  app.get('/v1/jobs/:id/events', async (req, res, next) => {
    const id = req.params.id; manager.store.get(id);
    const after = Number(req.get('last-event-id') ?? req.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new PipelineError('BAD_INPUT', 'after/Last-Event-ID must be a nonnegative integer');
    let replaying = true, last = after; const pending: JobEvent[] = [];
    const send = (event: JobEvent) => {
      if (event.id <= last || res.writableEnded) return;
      last = event.id; res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const listener = (event: JobEvent) => { if (event.jobId === id) { if (replaying) pending.push(event); else send(event); } };
    manager.store.on('jobEvent', listener);
    let timer: ReturnType<typeof setInterval> | undefined;
    const close = () => { if (timer) clearInterval(timer); manager.store.off('jobEvent', listener); };
    req.on('close', close);
    try {
      const events = await manager.store.events(id, after);
      res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
      for (const event of events) send(event); for (const event of pending) send(event); replaying = false;
      timer = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, 15000); timer.unref();
    } catch (e) { close(); next(e); }
  });
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.end(); return; }
    const code = (error as any).type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : error instanceof ZodError ? 'BAD_INPUT' : error instanceof PipelineError ? error.code : error instanceof SyntaxError ? 'BAD_INPUT' : 'INTERNAL_ERROR';
    const status = code === 'PAYLOAD_TOO_LARGE' ? 413 : code === 'NOT_FOUND' ? 404 : code === 'INVALID_STATE' ? 409 : code === 'MODEL_NOT_CONFIGURED' || code === 'SERVICE_STOPPING' ? 503 : code === 'INTERNAL_ERROR' ? 500 : 422;
    const message = error instanceof ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : code === 'INTERNAL_ERROR' ? 'Internal service error' : error.message;
    res.status(status).json({ error: { code, message } });
  });
  return app;
}
