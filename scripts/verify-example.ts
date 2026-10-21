import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, sha256 } from '../core/files.js';
import { PROJECT_ROOT } from '../core/paths.js';
import type { Timeline } from '../core/alignment.js';

const latest = await readJson<{ workspace: string; status: string }>(path.join(PROJECT_ROOT, '.reasonframe/latest-example.json'));
assert.equal(latest.status, 'completed', 'Run npm run example -- --render first');
const names = ['structure', 'math', 'review', 'alignment', 'visual', 'hyperframes', 'video', 'quality'];
const reports = await Promise.all(names.map(n => readJson<any>(path.join(latest.workspace, `reports/${n}.json`))));
for (const [i, r] of reports.entries()) assert.equal(r.passed ?? r.approved ?? r.ok, true, `${names[i]} must pass`);
const [actual, golden] = await Promise.all([readJson<Timeline>(path.join(latest.workspace, 'timeline.json')), readJson<Timeline>(path.join(PROJECT_ROOT, 'examples/solid-geometry/reference-timeline.json'))]);
assert.deepEqual(actual.words, golden.words); assert.deepEqual(actual.scenes, golden.scenes); assert.deepEqual(actual.captions, golden.captions);
assert.equal(sha256(await fs.readFile(path.join(latest.workspace, 'render/assets/audio/narration.mp3'))), sha256(await fs.readFile(path.join(PROJECT_ROOT, 'examples/solid-geometry/narration.mp3'))));
console.log(JSON.stringify({ passed: true, gates: names.length, words: actual.words.length, focusCues: actual.alignment.focusCueCount, duration: actual.duration, video: path.join(latest.workspace, 'lesson.mp4') }, null, 2));
