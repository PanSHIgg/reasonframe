import { z } from 'zod';
import { AudioInputSchema, JobInputSchema } from '../shared/schema.js';

export function openapi(auth: boolean) {
  const job = { description: 'Job status, progress stage, narration digest and artifact links', content: { 'application/json': { schema: { type: 'object', required: ['id', 'status', 'stage'], properties: { id: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['queued', 'running', 'awaiting_audio', 'completed', 'failed', 'cancelled'] }, stage: { type: 'string' }, artifacts: { type: 'array', items: { type: 'object' } }, error: { type: 'object' } } } } } };
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const body = (schema: string) => ({ required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } } });
  return {
    openapi: '3.1.0', info: { title: '理象 ReasonFrame', version: '0.1.0', description: 'Pi + HyperFrames asynchronous teaching video service. No web workbench.' },
    ...(auth ? { security: [{ bearerAuth: [] }] } : {}),
    paths: {
      '/health': { get: { summary: 'Liveness', security: [], responses: { '200': { description: 'Service and model configuration status' } } } },
      '/v1/config': { get: { summary: 'Redacted configuration', responses: { '200': { description: 'Endpoint, URL, model, TTS availability; no credentials' } } } },
      '/v1/jobs': { get: { summary: 'List latest 100 jobs', responses: { '200': { description: 'Jobs' } } }, post: { summary: 'Queue a video generation job', requestBody: body('JobInput'), responses: { '202': job, '422': { description: 'Invalid input' }, '503': { description: 'Model not configured' } } } },
      '/v1/jobs/{id}': { parameters: [id], get: { summary: 'Get job and artifact links', responses: { '200': job } } },
      '/v1/jobs/{id}/narration': { parameters: [id], get: { summary: 'Get the exact whole narration and scriptSha256', responses: { '200': { description: '{text, scriptSha256}' }, '409': { description: 'Authoring/review incomplete' } } } },
      '/v1/jobs/{id}/audio': { parameters: [id], post: { summary: 'Import one complete MP3 plus exact word timestamps, then resume', requestBody: body('AudioInput'), responses: { '202': job, '409': { description: 'Not awaiting audio' }, '422': { description: 'Stale script, invalid audio or mismatching word table' } } } },
      '/v1/jobs/{id}/cancel': { parameters: [id], post: { summary: 'Cancel queued/running/awaiting job', responses: { '200': job, '409': { description: 'Already terminal' } } } },
      '/v1/jobs/{id}/retry': { parameters: [id], post: { summary: 'Retry failed/cancelled job; reuse only approved source and matching narration', responses: { '202': job, '409': { description: 'Not stopped' } } } },
      '/v1/jobs/{id}/events': { parameters: [id], get: { summary: 'SSE with durable event IDs; supports Last-Event-ID or ?after=', responses: { '200': { description: 'Event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } } } } },
      '/v1/jobs/{id}/artifacts/{name}': { parameters: [id, { name: 'name', in: 'path', required: true, schema: { type: 'string' } }], get: { summary: 'Download a listed artifact; video is published only after every gate passes', responses: { '200': { description: 'Artifact bytes' }, '404': { description: 'Missing/not published' } } } },
    },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: {
      JobInput: z.toJSONSchema(JobInputSchema, { io: 'input' }), AudioInput: z.toJSONSchema(AudioInputSchema, { io: 'input' }),
    } },
  };
}
