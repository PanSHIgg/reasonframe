import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import type { Config } from './config.js';
import type { Timeline } from './alignment.js';
import { PROJECT_ROOT } from './paths.js';
import { safeFile, writeJson, readJson, sha256, sourceDigest } from './files.js';
import { checkAbort, command, PipelineError } from './process.js';

export async function browserExecutable(config: Config) {
  if (config.browserPath) { await fs.access(config.browserPath); return config.browserPath; }
  const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  const cache = path.join(os.homedir(), '.cache/hyperframes/chrome/chrome-headless-shell');
  try {
    for (const version of (await fs.readdir(cache)).sort().reverse()) {
      const folder = path.join(cache, version);
      for (const platform of await fs.readdir(folder)) candidates.push(path.join(folder, platform, 'chrome-headless-shell'));
    }
  } catch { /* A configured or system browser may still be present. */ }
  for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch { /* next */ } }
  throw new PipelineError('BROWSER_MISSING', 'Set HYPERFRAMES_BROWSER_PATH to an installed Chromium executable; run npm run bootstrap for diagnostics');
}
export function renderingEnv(browser: string, runId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (/^(PATH|HOME|LANG|LC_ALL|TMPDIR|TMP|TEMP|SystemRoot|LD_LIBRARY_PATH|FONTCONFIG_PATH|XDG_CACHE_HOME)$/.test(k) || /^(PRODUCER_|HYPERFRAMES_)/.test(k)) env[k] = v;
  return { ...env, HYPERFRAMES_BROWSER_PATH: browser, HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_RUN_ID: runId, NO_COLOR: '1' };
}
export interface VisualSample { scene: string; time: number; file: string; reference?: 'hyperframes-snapshot'; }

async function nativeReferenceFrames(config: Config, workspace: string, samples: VisualSample[], signal: AbortSignal) {
  const output = path.join(workspace, 'reports/frames/native');
  await command(process.execPath, [hf, 'snapshot', '--at', samples.map(sample => String(sample.time)).join(','),
    '--no-end', '--keep', '--no-browser-gpu', '--describe', 'false', '--output', output], {
    cwd: path.join(workspace, 'render'), signal, timeoutMs: 120000,
    env: renderingEnv(await browserExecutable(config), 'reference-' + path.basename(workspace)),
    log: path.join(workspace, 'reports/reference.log'),
  });
  return Promise.all(samples.map(async sample => {
    const file = `reports/frames/native/at-${Number(sample.time.toFixed(3))}s.png`;
    await fs.access(path.join(workspace, file));
    return { ...sample, file, reference: 'hyperframes-snapshot' as const };
  }));
}

export async function inspectVisuals(config: Config, workspace: string, timeline: Timeline, signal: AbortSignal) {
  await fs.rm(path.join(workspace, 'reports/frames'), { recursive: true, force: true });
  const root = path.join(workspace, 'render'), errors: string[] = [], focusChecks: unknown[] = [], samples: VisualSample[] = [];
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg' };
  const server = createServer(async (req, res) => {
    try {
      const relative = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
      const file = await safeFile(root, relative), bytes = await fs.readFile(file);
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const abort = () => { void browser?.close(); };
  try {
    checkAbort(signal); browser = await chromium.launch({ executablePath: await browserExecutable(config), headless: true, args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--font-render-hinting=none', '--force-color-profile=srgb', '--force-device-scale-factor=1',
    ] });
    signal.addEventListener('abort', abort, { once: true }); checkAbort(signal);
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin + '/') || url.startsWith('data:')) return route.continue();
      errors.push(`External request is forbidden: ${url}`); return route.abort();
    });
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`); });
    await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    const measure = () => {
      const outside: string[] = [], overlaps: Record<string, unknown>[] = [], markerOverlaps: Record<string, unknown>[] = [], garbled: string[] = [];
      const scene = [...document.querySelectorAll<HTMLElement>('.scene')].find(el => getComputedStyle(el).visibility !== 'hidden');
      const sceneBottom = scene?.getBoundingClientRect().bottom ?? 1080;
      const captionTop = document.querySelector('.caption-zone')!.getBoundingClientRect().top;
      const tracked: { el: Element; text: string; r: DOMRect }[] = [];
      for (const el of document.querySelectorAll<Element>('.scene-heading,.scene-kicker,.block-label,.equation,.block-text,.model-note,.focus-label,.caption,.header-title,.eyebrow,.chapter,.footer,.model-topline,.diagram text')) {
        const css = getComputedStyle(el); if (css.visibility === 'hidden' || Number(css.opacity) < 0.15) continue;
        const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.x > 1920 || r.y > 1080) continue;
        if (r.x < -0.5 || r.y < -0.5 || r.right > 1920.5 || r.bottom > 1080.5 || (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 2 || (el.closest('.scene') && r.bottom > Math.min(sceneBottom, captionTop - 12) + 1)) outside.push((el.textContent || '').slice(0, 100));
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) tracked.push({ el, text, r });
      }
      for (let i = 0; i < tracked.length; i++) for (let j = i + 1; j < tracked.length; j++) {
        const a = tracked[i], b = tracked[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if (a.text.includes(b.text) || b.text.includes(a.text)) continue;
        const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ix > 4 && iy > 4 && ix * iy > 64) overlaps.push({ a: a.text.slice(0, 50), b: b.text.slice(0, 50), x: Math.round(Math.max(a.r.left, b.r.left)), y: Math.round(Math.max(a.r.top, b.r.top)), w: Math.round(ix), h: Math.round(iy) });
      }
      for (const marker of document.querySelectorAll<Element>('.diagram circle')) {
        const css = getComputedStyle(marker); if (css.visibility === 'hidden' || css.display === 'none') continue;
        const r = marker.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
        const markerObject = marker.parentElement?.getAttribute('data-object') || '';
        for (const item of tracked) {
          if (item.el.tagName.toLowerCase() !== 'text') continue;
          const textObject = item.el.parentElement?.getAttribute('data-object') || '';
          if (!markerObject || textObject !== markerObject) continue;
          const ix = Math.min(item.r.right, r.right) - Math.max(item.r.left, r.left), iy = Math.min(item.r.bottom, r.bottom) - Math.max(item.r.top, r.top);
          if (ix > 3 && iy > 3 && ix * iy > 40) markerOverlaps.push({ text: item.text.slice(0, 50), marker: markerObject, x: Math.round(Math.max(item.r.left, r.left)), y: Math.round(Math.max(item.r.top, r.top)), w: Math.round(ix), h: Math.round(iy) });
        }
      }
      const texts = tracked.map(item => item.text).join('\n');
      if (/\uFFFD/.test(texts)) garbled.push('Unicode replacement character in visible text');
      if (/锟斤拷|â€|Ã[\u0080-\u00BF]/.test(texts)) garbled.push('Common mojibake sequence in visible text');
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(texts)) garbled.push('Control character in visible text');
      const katexErrors = [...document.querySelectorAll('.katex-error')].map(el => (el.textContent || '').slice(0, 100)).filter(Boolean);
      if (katexErrors.length) garbled.push('KaTeX error: ' + katexErrors.slice(0, 3).join(' | '));
      return { outside, overlaps, markerOverlaps, garbled, visibleScenes: [...document.querySelectorAll('.scene')].filter(el => getComputedStyle(el).visibility !== 'hidden').length };
    };
    const seek = async (t: number) => { checkAbort(signal); await page.evaluate(time => (window as any).seekReasonFrame(time), t); };
    await fs.mkdir(path.join(workspace, 'reports/frames'), { recursive: true });
    for (const [i, scene] of timeline.scenes.entries()) {
      const time = Math.floor((scene.end - Math.min(0.6, scene.duration / 4)) * timeline.fps) / timeline.fps;
      await seek(time); const layout = await page.evaluate(measure);
      if (layout.outside.length || layout.overlaps.length || layout.markerOverlaps.length || layout.garbled.length || layout.visibleScenes !== 1) errors.push(`${scene.id}: layout ${JSON.stringify(layout).slice(0, 1600)}`);
      const file = `reports/frames/${String(i + 1).padStart(2, '0')}-${scene.id}.png`;
      await page.screenshot({ path: path.join(workspace, file) }); samples.push({ scene: scene.id, time, file });
      const before = await page.locator(`#diagram-${scene.id}`).innerHTML();
      await seek(0); await seek(time);
      if (before !== await page.locator(`#diagram-${scene.id}`).innerHTML()) errors.push(`${scene.id}: renderer is not deterministic under reverse seek`);
      for (const cue of scene.focus) {
        const proposed = cue.start + Math.min(0.25, (cue.end - cue.start) / 2);
        const aligned = Math.ceil(proposed * timeline.fps) / timeline.fps;
        const t = aligned < cue.end ? aligned : Math.floor(proposed * timeline.fps) / timeline.fps;
        if (t < cue.start || t >= cue.end) { errors.push(`${cue.id}: focus cue is shorter than an encoded frame`); continue; }
        await seek(t);
        const actual = await page.evaluate(() => {
          const id = document.documentElement.dataset.scene;
          const selected = [...document.querySelectorAll<SVGGElement>(`#diagram-${id} [data-focus="1"]`)];
          return {
            focus: document.documentElement.dataset.focus,
            objects: selected.map(n => n.dataset.object),
            visible: selected.every(n => { const r = n.getBoundingClientRect(), css = getComputedStyle(n); return (r.width > 1 || r.height > 1) && r.x >= 0 && r.y >= 0 && r.right <= 1920.5 && r.bottom <= 1080.5 && css.visibility !== 'hidden' && Number(css.opacity) > 0.05; }),
            caption: (document.querySelector('#live-caption')?.textContent || '').trim(),
          };
        });
        const caption = timeline.captions.find(c => t >= c.start && t < c.end), expectedCaption = (caption?.text || '').trim();
        const layout = await page.evaluate(measure);
        const layoutClean = layout.outside.length === 0 && layout.overlaps.length === 0 && layout.markerOverlaps.length === 0 && layout.garbled.length === 0;
        const passed = actual.focus === cue.id && actual.visible && cue.objects.length === actual.objects.length && cue.objects.every(k => actual.objects.includes(k)) && actual.caption === expectedCaption && layoutClean && layout.visibleScenes === 1;
        focusChecks.push({ id: cue.id, time: t, passed, ...(!passed ? { actual, expected: cue.objects, expectedCaption, layout } : {}) });
      }
    }
    const background = await page.evaluate(() => getComputedStyle(document.querySelector('.background')!).backgroundColor);
    const rgb = background.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)?.slice(1).map(Number);
    const luminance = rgb ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 : 0;
    const theme = luminance >= 0.6 ? 'light' : luminance <= 0.1 ? 'dark' : 'invalid';
    if (theme === 'invalid') errors.push(`The background must be light paper or near-black; got ${background}`);
    const report = { passed: errors.length === 0 && (focusChecks as { passed: boolean }[]).every(c => c.passed), errors, background, theme, focusChecks, samples };
    await writeJson(path.join(workspace, 'reports/visual.json'), report);
    if (!report.passed) throw new PipelineError('VISUAL_CHECK_FAILED', JSON.stringify({ errors, failedFocus: (focusChecks as { passed: boolean }[]).filter(c => !c.passed) }).slice(0, 7000));
    // HyperFrames installs its own runtime and capture normalization. Compare the
    // encoded video against that renderer, while retaining raw browser screenshots
    // and all semantic/layout checks above as separate evidence.
    const nativeSamples = await nativeReferenceFrames(config, workspace, samples, signal);
    await writeJson(path.join(workspace, 'reports/visual.json'), { ...report, samples: nativeSamples,
      browserSamples: samples, referenceMethod: 'hyperframes-snapshot' });
    return nativeSamples;
  } finally {
    signal.removeEventListener('abort', abort); await browser?.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

const hf = path.join(PROJECT_ROOT, 'node_modules/hyperframes/bin/hyperframes.mjs');
export async function checkHyperFrames(config: Config, workspace: string, runId: string, signal: AbortSignal) {
  const result = await command(process.execPath, [hf, 'check', '--json', '--at-transitions'], {
    cwd: path.join(workspace, 'render'), signal, timeoutMs: 240000, env: renderingEnv(await browserExecutable(config), runId),
    log: path.join(workspace, 'reports/hyperframes.log'), allowFailure: true,
  });
  let report: any;
  try { report = JSON.parse(result.stdout); } catch { throw new PipelineError('HYPERFRAMES_CHECK_FAILED', `HyperFrames returned no JSON report: ${result.stderr.slice(-3000)}`); }
  await writeJson(path.join(workspace, 'reports/hyperframes.json'), report);
  if (result.code !== 0 || !report.ok || report.browserSkipped) throw new PipelineError('HYPERFRAMES_CHECK_FAILED', `HyperFrames check failed; inspect reports/hyperframes.json`);
  return report;
}
export async function renderVideo(config: Config, workspace: string, fps: number, quality: string, runId: string, signal: AbortSignal) {
  const source = path.join(workspace, 'rendered.mp4'), file = path.join(workspace, 'pending.mp4');
  const kbps = Number.parseFloat(config.renderBitrate) * (/[mM]$/.test(config.renderBitrate) ? 1000 : 1);
  try {
    await command(process.execPath, [hf, 'render', '--no-browser-gpu', '--quality', quality, '--fps', String(fps), '--workers', String(config.renderWorkers), '--video-bitrate', config.renderBitrate, '--output', source], {
      cwd: path.join(workspace, 'render'), signal, timeoutMs: config.renderTimeoutMs,
      env: renderingEnv(await browserExecutable(config), runId), log: path.join(workspace, 'reports/render.log'),
    });
    await command('ffmpeg', ['-v', 'error', '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'slow', '-tune', 'stillimage',
      '-b:v', config.renderBitrate, '-minrate', config.renderBitrate, '-maxrate', config.renderBitrate, '-bufsize', `${Math.round(kbps * 2)}k`,
      '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', '-y', file], {
      signal, timeoutMs: 600000, log: path.join(workspace, 'reports/encode.log'),
    });
  } finally { await fs.rm(source, { force: true }); }
  return file;
}
export async function compareFrames(reference: string, encoded: string, signal?: AbortSignal) {
  // Match H.264's chroma grid and matrix. RGB-channel SSIM over-penalizes thin
  // colored SVG strokes after the normal 4:2:0 encode/decode conversion.
  const graph = '[0:v]scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p[a];[1:v]scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p[b];[a][b]ssim';
  const result = await command('ffmpeg', ['-hide_banner', '-nostats', '-i', reference, '-i', encoded, '-lavfi', graph, '-frames:v', '1', '-f', 'null', '-'], { signal });
  const ssim = Number(result.stderr.match(/All:([\d.]+)/)?.[1]);
  return { ssim, passed: Number.isFinite(ssim) && ssim >= 0.97 };
}
export async function videoBindings(workspace: string, file: string, timeline: Timeline) {
  const render = path.join(workspace, 'render'), assets = path.join(render, 'assets');
  const entries = await fs.readdir(assets, { recursive: true, withFileTypes: true });
  const files = ['index.html', 'index.motion.json', ...entries.filter(e => e.isFile()).map(e => path.relative(render, path.join(e.parentPath, e.name)))].sort();
  const content = await Promise.all(files.map(async name => [name, sha256(await fs.readFile(path.join(render, name)))]));
  return { sourceSha256: await sourceDigest(workspace), timelineSha256: sha256(JSON.stringify(timeline)),
    compositionSha256: sha256(JSON.stringify(content)), videoSha256: sha256(await fs.readFile(file)),
    validatorSha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))) };
}
export async function validatedCandidate(workspace: string, timeline: Timeline) {
  try {
    const report = await readJson<Record<string, any>>(path.join(workspace, 'reports/video.json'));
    if (!report.passed) return undefined;
    const file = path.join(workspace, 'pending.mp4'), bindings = await videoBindings(workspace, file, timeline);
    if (!Object.entries(bindings).every(([k, v]) => report[k] === v)) return undefined;
    return { file, report };
  } catch { return undefined; }
}
export async function verifyVideo(workspace: string, file: string, timeline: Timeline, samples: VisualSample[], signal: AbortSignal) {
  const errors: string[] = [];
  const probe = await command('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { signal });
  const metadata = JSON.parse(probe.stdout), video = metadata.streams?.find((s: any) => s.codec_type === 'video'), audio = metadata.streams?.find((s: any) => s.codec_type === 'audio');
  if (!video || !audio) errors.push('MP4 needs both video and audio tracks');
  if (video?.width !== 1920 || video?.height !== 1080) errors.push('Expected 1920x1080 output');
  const [n, d] = String(video?.avg_frame_rate || '0/1').split('/').map(Number);
  if (Math.abs(n / d - timeline.fps) > 0.001) errors.push('Encoded frame rate differs from the timeline');
  if (Math.abs(Number(metadata.format?.duration) - timeline.duration) > 1 / timeline.fps + 0.06) errors.push('Encoded duration differs from aligned timeline');
  if (Number(video?.nb_frames) !== Math.round(timeline.duration * timeline.fps)) errors.push('Encoded frame count is incomplete');
  const decode = await command('ffmpeg', ['-hide_banner', '-nostats', '-xerror', '-i', file, '-vf', 'blackdetect=d=0.35:pix_th=0.02:pic_th=0.9995', '-af', 'silencedetect=n=-50dB:d=3,volumedetect', '-f', 'null', '-'], { signal, timeoutMs: 180000, log: path.join(workspace, 'reports/decode.log') });
  if (/black_start:/.test(decode.stderr)) errors.push('Unexpected nearly empty black frames in encoded video');
  const meanVolume = Number(decode.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1]);
  if (!Number.isFinite(meanVolume) || meanVolume < -45) errors.push('Narration is silent or too quiet');
  for (const match of decode.stderr.matchAll(/silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g)) {
    const start = Number(match[1]), end = Number(match[2]);
    if (timeline.words.some(w => w.start < end - 0.2 && w.end > start + 0.2)) errors.push(`Unexpected silence during spoken words: ${start}..${end}`);
  }
  const comparisons = [];
  for (const [i, sample] of samples.entries()) {
    const extracted = path.join(workspace, 'reports/frames', `encoded-${String(i + 1).padStart(2, '0')}.png`);
    await command('ffmpeg', ['-v', 'error', '-ss', String(sample.time), '-i', file, '-frames:v', '1', '-update', '1', '-y', extracted], { signal });
    const { ssim, passed } = await compareFrames(path.join(workspace, sample.file), extracted, signal);
    comparisons.push({ scene: sample.scene, time: sample.time, ssim, passed });
    if (!passed) errors.push(`Encoded scene differs from checked composition: ${sample.scene} (SSIM ${ssim})`);
  }
  const report = { passed: !errors.length, errors, duration: Number(metadata.format?.duration), width: video?.width, height: video?.height, fps: n / d, frames: Number(video?.nb_frames), meanVolumeDb: meanVolume,
    comparisonFormat: 'BT.709 limited-range YUV420p', referenceMethod: samples.every(sample => sample.reference === 'hyperframes-snapshot') ? 'hyperframes-snapshot' : 'provided-images',
    ssimThreshold: 0.97, comparisons, ...await videoBindings(workspace, file, timeline) };
  await writeJson(path.join(workspace, 'reports/video.json'), report);
  if (!report.passed) throw new PipelineError('VIDEO_CHECK_FAILED', errors.join('; '));
  return report;
}
