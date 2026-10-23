import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareFrames, validatedCandidate, videoBindings } from '../core/quality.js';
import { command } from '../core/process.js';
import { readJson, writeJson } from '../core/files.js';
import type { Timeline } from '../core/alignment.js';
import { exampleRoot, setup } from './helpers.js';

test('video comparison accepts normal H.264 chroma loss on thin colored geometry and rejects changed structure', async () => {
  const s = await setup(), fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
  try {
    const reference = path.join(fixtures, 'sphere-reference.png'), encoded = path.join(fixtures, 'sphere-encoded.png');
    assert.equal((await compareFrames(reference, encoded)).passed, true);
    const wrong = path.join(s.temp, 'wrong.png');
    await command('ffmpeg', ['-v', 'error', '-i', reference, '-vf', 'hflip', '-frames:v', '1', '-update', '1', '-y', wrong]);
    assert.equal((await compareFrames(reference, wrong)).passed, false);
  } finally { await s.cleanup(); }
});
test('a validated pending video is reusable only with identical bytes, source, timeline, composition and validator', async () => {
  const s = await setup();
  try {
    await fs.mkdir(path.join(s.temp, 'render/assets'), { recursive: true }); await fs.mkdir(path.join(s.temp, 'src'), { recursive: true });
    await Promise.all(['lesson.json', 'src/visual.js', 'src/style.css'].map(f => fs.copyFile(path.join(exampleRoot, f), path.join(s.temp, f))));
    await fs.writeFile(path.join(s.temp, 'render/index.html'), '<!-- transport fixture, not a rendered composition -->');
    await fs.writeFile(path.join(s.temp, 'render/index.motion.json'), '{}');
    const file = path.join(s.temp, 'pending.mp4'); await fs.writeFile(file, 'internal cache binding fixture');
    const timeline = await readJson<Timeline>(path.join(exampleRoot, 'reference-timeline.json'));
    await writeJson(path.join(s.temp, 'reports/video.json'), { passed: true, ...await videoBindings(s.temp, file, timeline) });
    assert(await validatedCandidate(s.temp, timeline));
    await fs.appendFile(file, 'changed'); assert.equal(await validatedCandidate(s.temp, timeline), undefined);
    await fs.writeFile(file, 'internal cache binding fixture');
    await fs.appendFile(path.join(s.temp, 'src/visual.js'), '\n// changed source'); assert.equal(await validatedCandidate(s.temp, timeline), undefined);
    await fs.copyFile(path.join(exampleRoot, 'src/visual.js'), path.join(s.temp, 'src/visual.js'));
    assert.equal(await validatedCandidate(s.temp, { ...timeline, duration: timeline.duration + 1 }), undefined);
  } finally { await s.cleanup(); }
});
