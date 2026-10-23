import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import katex from 'katex';
import { z } from 'zod';
import { LessonSchema, type JobInput, type Lesson } from '../shared/schema.js';
import type { Timeline } from './alignment.js';
import { narration, subtitles } from './alignment.js';
import { PROJECT_ROOT } from './paths.js';
import { atomicWrite, sha256, writeJson } from './files.js';

const require = createRequire(import.meta.url);
const dependency = (name: string) => path.dirname(require.resolve(`${name}/package.json`));
export async function prepareWorkspace(workspace: string, input: JobInput) {
  const template = input.options.template === 'auto' ? (/立体|棱锥|空间几何|线面|共球/.test(input.problem + input.scope.topics.join(' ')) ? 'solid-geometry' : 'blank') : input.options.template;
  await Promise.all(['src', 'reports', 'inputs', 'render', 'sessions'].map(d => fs.mkdir(path.join(workspace, d), { recursive: true })));
  await Promise.all([
    fs.copyFile(path.join(PROJECT_ROOT, 'templates', template, 'visual.js'), path.join(workspace, 'src/visual.js')),
    fs.copyFile(path.join(PROJECT_ROOT, 'templates/base/style.css'), path.join(workspace, 'src/style.css')),
    fs.copyFile(path.join(PROJECT_ROOT, 'docs/authoring.md'), path.join(workspace, 'AUTHORING.md')),
    writeJson(path.join(workspace, 'schema.json'), z.toJSONSchema(LessonSchema)),
    writeJson(path.join(workspace, 'request.json'), { ...input, images: input.images.map(i => ({ mimeType: i.mimeType })) }),
  ]);
}
export async function compile(workspace: string, lesson: Lesson, timeline: Timeline) {
  if (sha256(narration(lesson)) !== timeline.speech.scriptSha256) throw new Error('Narration changed after audio alignment');
  const render = path.join(workspace, 'render'), assets = path.join(render, 'assets');
  if (sha256(await fs.readFile(path.join(assets, 'audio/narration.mp3'))) !== timeline.speech.audioSha256) throw new Error('Audio hash differs from aligned MP3');
  await Promise.all(['vendor', 'fonts'].map(d => fs.mkdir(path.join(assets, d), { recursive: true })));
  await Promise.all([
    fs.copyFile(path.join(dependency('gsap'), 'dist/gsap.min.js'), path.join(assets, 'vendor/gsap.min.js')),
    fs.copyFile(path.join(dependency('katex'), 'dist/katex.min.css'), path.join(assets, 'vendor/katex.min.css')),
    fs.cp(path.join(dependency('katex'), 'dist/fonts'), path.join(assets, 'vendor/fonts'), { recursive: true }),
    ...[400, 700].flatMap(weight => ['chinese-simplified', 'latin'].map(set => {
      const name = `noto-sans-sc-${set}-${weight}-normal.woff2`;
      return fs.copyFile(path.join(dependency('@fontsource/noto-sans-sc'), 'files', name), path.join(assets, 'fonts', name));
    })),
    fs.copyFile(path.join(workspace, 'src/style.css'), path.join(assets, 'style.css')),
    fs.copyFile(path.join(workspace, 'src/visual.js'), path.join(assets, 'visual.js')),
    fs.copyFile(path.join(PROJECT_ROOT, 'templates/base/runtime.js'), path.join(assets, 'runtime.js')),
  ]);
  const json = JSON.stringify({ lesson, model: lesson.model, entities: lesson.entities, timeline }).replace(/</g, '\\u003c');
  await atomicWrite(path.join(assets, 'lesson-data.js'), `window.LESSON_DATA=${json};\n`);
  const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const typeset = (s: string) => katex.renderToString(s, { throwOnError: true, displayMode: true, output: 'html', strict: 'ignore' }).replace(/<path /g, '<path data-layout-allow-overflow="true" ');
  const scenes = lesson.scenes.map((scene, i) => {
    const slot = timeline.scenes[i];
    const blocks = scene.blocks.map((b, j) => `<div id="block-${scene.id}-${j}" class="proof-block${b.accent ? ' accent' : ''}${b.answer ? ' answer' : ''}">${b.label ? `<div class="block-label">${esc(b.label)}</div>` : ''}${b.math ? `<div class="equation${b.small ? ' small' : ''}">${typeset(b.math)}</div>` : `<div class="block-text${b.compact ? ' compact' : ''}">${esc(b.text!)}</div>`}</div>`).join('\n');
    return `<section id="scene-${scene.id}" class="clip scene" data-start="${slot.start}" data-duration="${slot.duration}" data-track-index="0" aria-label="${esc(scene.title)}"><div class="model-panel"><div class="model-topline"><span>情景与模型</span></div><svg id="diagram-${scene.id}" class="diagram" viewBox="0 0 900 650" role="img" aria-label="${esc(scene.note)}"></svg><div class="focus-label"></div><div class="model-note">${esc(scene.note)}</div></div><div class="explanation"><div class="scene-kicker"><span class="scene-number">${String(i + 1).padStart(2, '0')}</span><span>${esc(lesson.chapters[scene.chapter])}</span></div><h2 class="scene-heading">${esc(scene.title)}</h2><div class="blocks">${blocks}</div></div></section>`;
  }).join('\n');
  const tweens: string[] = [];
  lesson.scenes.forEach((s, i) => {
    const slot = timeline.scenes[i];
    tweens.push(`tl.fromTo('#scene-${s.id} .explanation',{opacity:0,y:8},{opacity:1,y:0,duration:.3,immediateRender:false},${slot.start});`);
    s.blocks.forEach((_, j) => tweens.push(`tl.fromTo('#block-${s.id}-${j}',{opacity:0,y:10},{opacity:1,y:0,duration:.36,ease:'power2.out',immediateRender:false},${slot.reveals[j]});`));
  });
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=1920,height=1080"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>${esc(lesson.title)}</title><link rel="stylesheet" href="assets/vendor/katex.min.css"><link rel="stylesheet" href="assets/style.css"><script src="assets/vendor/gsap.min.js"></script><script src="assets/lesson-data.js"></script></head><body><div id="lesson" data-composition-id="reasonframe" data-start="0" data-duration="${timeline.duration}" data-width="1920" data-height="1080" data-fps="${lesson.fps}"><div class="background"></div><header class="header"><div><div class="eyebrow">${esc(lesson.subtitle)}</div><div class="header-title">${esc(lesson.title)}</div></div><nav class="chapters">${lesson.chapters.map((s, i) => `<div class="chapter${i === 0 ? ' active' : ''}"><span class="chapter-index">${String(i + 1).padStart(2, '0')}</span>${esc(s)}</div>`).join('')}</nav></header>${scenes}<div class="caption-zone"><div id="live-caption" class="caption"></div></div><audio id="lesson-narration" src="${timeline.audioSrc}" preload="metadata" data-start="0" data-duration="${timeline.audioDuration}" data-track-index="3" data-volume="1"></audio><footer class="footer"><span>理象 · ReasonFrame</span><div class="progress-track"><div class="progress-fill"></div></div><span class="page-counter">01 / ${lesson.scenes.length}</span></footer></div><script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});${tweens.join('\n')}tl.fromTo('.progress-fill',{scaleX:0},{scaleX:1,duration:${timeline.duration},ease:'none'},0);window.__timelines.reasonframe=tl;</script><script src="assets/visual.js"></script><script src="assets/runtime.js"></script></body></html>`;
  const srt = subtitles(timeline);
  await Promise.all([
    atomicWrite(path.join(render, 'index.html'), html),
    writeJson(path.join(render, 'index.motion.json'), { duration: timeline.duration, assertions: [{ kind: 'staysInFrame', selector: '.header' }, { kind: 'staysInFrame', selector: '.caption-zone' }, { kind: 'appearsBy', selector: `#scene-${lesson.scenes[0].id} .scene-heading`, bySec: 1 }] }),
    writeJson(path.join(workspace, 'timeline.json'), timeline), atomicWrite(path.join(workspace, 'narration.txt'), narration(lesson)),
    atomicWrite(path.join(workspace, 'lesson.srt'), srt), atomicWrite(path.join(workspace, 'lesson.vtt'), 'WEBVTT\n\n' + srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')),
  ]);
}
