import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { PROJECT_ROOT } from '../core/paths.js';

test('animation beat starts remain local and stable when highlights change and time seeks backwards', async () => {
  const contexts: any[] = [];
  const diagram = { innerHTML: '' }, caption = { innerHTML: '', children: [] };
  const document = {
    documentElement: { dataset: {} },
    querySelectorAll(selector: string) { return selector === '.diagram' ? [diagram] : selector === '.focus-label' ? [{ innerHTML: '' }] : []; },
    querySelector(selector: string) { return selector === '#live-caption' ? caption : { textContent: '' }; },
  };
  const window: any = {
    LESSON_DATA: {
      lesson: { scenes: [{ id: 's1', chapter: 0 }] }, entities: { point: { color: '#58c4dd' } },
      timeline: { duration: 40, words: [], captions: [], scenes: [{ start: 10, end: 40, duration: 30,
        beats: [{ start: 10 }, { start: 14 }], reveals: [],
        focus: [{ id: 'one', start: 10, objects: ['point'], label: 'first' }, { id: 'two', start: 18, objects: ['point'], label: 'second' }],
      }] },
    },
    ReasonFrameVisual: { render(value: unknown) { contexts.push(structuredClone(value)); return ''; } },
    addEventListener() {},
  };
  vm.runInNewContext(await fs.readFile(path.join(PROJECT_ROOT, 'templates/base/runtime.js'), 'utf8'), { window, document });
  window.renderLessonAt(17); window.renderLessonAt(18.2); window.renderLessonAt(17);
  const [before, after, reverse] = contexts.slice(-3);
  assert.deepEqual(Array.from(before.context.beatStarts), [0, 4]);
  assert.deepEqual(after.context.beatStarts, before.context.beatStarts);
  assert.equal(before.context.age, 7); assert(Math.abs(after.context.age - 0.2) < 1e-10);
  assert.deepEqual(reverse, before);
  assert.equal(before.phase, 1); assert.equal(after.phase, 1);
});
