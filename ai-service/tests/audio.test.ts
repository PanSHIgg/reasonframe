import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { synthesize } from '../core/audio.js';
import { narration } from '../core/alignment.js';
import { readJson, sha256 } from '../core/files.js';
import { exampleLesson, exampleRoot, setup } from './helpers.js';

test('HTTP TTS receives the entire narration exactly once and preserves the complete MP3', async () => {
  const s = await setup(), oldFetch = globalThis.fetch;
  try {
    const lesson = await exampleLesson(), mp3 = await fs.readFile(path.join(exampleRoot, 'narration.mp3')), words = await readJson(path.join(exampleRoot, 'words.json'));
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, options: any) => {
      calls++; const body = JSON.parse(options.body);
      assert.equal(body.text, narration(lesson)); assert.equal(body.scriptSha256, sha256(body.text));
      assert(body.text.startsWith(lesson.scenes[0].beats[0].say)); assert(body.text.endsWith(lesson.scenes.at(-1)!.beats.at(-1)!.say));
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ audioBase64: mp3.toString('base64'), words }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    s.config.tts = { provider: 'http', url: 'https://fixture.invalid/tts', apiKey: '', voice: '', python: '' };
    const timeline = await synthesize(s.config, s.temp, lesson, new AbortController().signal);
    assert.equal(calls, 1); assert.equal(timeline.speech.synthesisRequests, 1); assert.equal(timeline.alignment.coverage, 1);
    assert.deepEqual(await fs.readFile(path.join(s.temp, 'render/assets/audio/narration.mp3')), mp3);
  } finally { globalThis.fetch = oldFetch; await s.cleanup(); }
});
