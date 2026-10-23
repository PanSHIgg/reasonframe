import type { Lesson, WordTable } from '../shared/schema.js';
import { WordTableSchema } from '../shared/schema.js';
import { sha256 } from './files.js';
// Mathematical operators carry meaning and must not disappear as punctuation.
export const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}+−=×÷√-]/gu, '');
export const narration = (lesson: Lesson) => lesson.scenes.map(s => s.beats.map(b => b.say).join('\n')).join('\n\n');
export interface AlignedWord { index: number; text: string; start: number; end: number; charStart: number; charEnd: number; display: string; }
export interface Caption { start: number; end: number; text: string; scene: string; beat: number; wordStart: number; wordEnd: number; }
export interface BeatTiming { start: number; end: number; duration: number; wordStart: number; wordEnd: number; charStart: number; charEnd: number; }
export interface FocusTiming { id: string; beat: number; anchor: string; objects: string[]; label: string; start: number; end: number; spokenEnd: number; wordStart: number; wordEnd: number; }
export interface SceneTiming { id: string; index: number; start: number; end: number; duration: number; beats: BeatTiming[]; focus: FocusTiming[]; reveals: number[]; }
export interface Timeline {
  schemaVersion: 2; fps: number; audioSrc: string; audioDuration: number; duration: number;
  words: AlignedWord[]; scenes: SceneTiming[]; captions: Caption[];
  speech: { mode: 'whole-script'; source: string; scriptSha256: string; audioSha256: string; synthesisRequests: number | null; importedAudioUnmodified: boolean };
  alignment: { coverage: number; normalizedCharacters: number; wordCount: number; captionCount: number; focusCueCount: number; finalVisualHold: number };
}
export function align(lesson: Lesson, payload: WordTable, audioDuration: number, audioSha256: string, source = 'external-import'): Timeline {
  const script = narration(lesson), scriptHash = sha256(script), table = WordTableSchema.parse(payload);
  if (table.scriptSha256 && table.scriptSha256 !== scriptHash) throw new Error('Word table scriptSha256 differs from the exact narration');
  const norm = normalized(script), positions: number[] = [];
  for (let offset = 0; offset < script.length;) { const c = String.fromCodePoint(script.codePointAt(offset)!); for (const _ of normalized(c)) positions.push(offset); offset += c.length; }
  const codepoints = Array.from(norm), normalizedLength = codepoints.length, scale = { seconds: 1, milliseconds: 0.001, '100ns': 0.0000001 }[table.timeUnit];
  const words: AlignedWord[] = []; let cursor = 0;
  for (const item of table.words) {
    const value = normalized(item.text); if (!value) continue;
    const valueLength = Array.from(value).length, start = item.start * scale, end = item.end !== undefined ? item.end * scale : start + item.duration! * scale;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > audioDuration + 0.06) throw new Error(`Invalid word timestamp: ${item.text}`);
    if (words.length && start < words.at(-1)!.end - 0.035) throw new Error(`Overlapping or out-of-order words: ${item.text}`);
    if (codepoints.slice(cursor, cursor + valueLength).join('') !== value) throw new Error(`Word/script mismatch at character ${cursor}: ${item.text}`);
    words.push({ index: words.length, text: item.text, start: round(start), end: round(end), charStart: cursor, charEnd: cursor + valueLength, display: '' }); cursor += valueLength;
  }
  if (cursor !== normalizedLength || !words.length) throw new Error(`Incomplete word coverage: ${cursor}/${normalizedLength}`);
  words.forEach((w, i) => { w.display = script.slice(positions[w.charStart], i + 1 < words.length ? positions[words[i + 1].charStart] : script.length).replace(/\s+/g, ''); });
  const range = (a: number, b: number) => { const result = words.filter(w => w.charEnd > a && w.charStart < b); if (!result.length) throw new Error(`Missing timing for characters ${a}:${b}`); return result; };
  const scenes: SceneTiming[] = [], captions: Caption[] = []; let beatCursor = 0;
  for (const [index, scene] of lesson.scenes.entries()) {
    const beats: BeatTiming[] = [];
    for (const [bi, beat] of scene.beats.entries()) {
      const a = beatCursor, b = a + Array.from(normalized(beat.say)).length, matched = range(a, b);
      if (matched[0].charStart < a || matched.at(-1)!.charEnd > b) throw new Error(`A TTS word crosses a teaching beat: ${scene.id}/${bi}`);
      beats.push({ start: matched[0].start, end: matched.at(-1)!.end, duration: round(matched.at(-1)!.end - matched[0].start), wordStart: matched[0].index, wordEnd: matched.at(-1)!.index + 1, charStart: a, charEnd: b }); beatCursor = b;
      let group: AlignedWord[] = [];
      const flush = () => { if (group.length) captions.push({ start: group[0].start, end: round(Math.min(audioDuration, group.at(-1)!.end + 0.12)), text: group.map(w => w.display).join(''), scene: scene.id, beat: bi, wordStart: group[0].index, wordEnd: group.at(-1)!.index + 1 }); group = []; };
      for (const word of matched) { if (group.length && (Array.from(group.map(w => w.display).join('') + word.display).length > 25 || word.end - group[0].start > 6)) flush(); group.push(word); if (/[，。；！？!?;]/u.test(word.display)) flush(); } flush();
    }
    scenes.push({ id: scene.id, index, start: 0, end: 0, duration: 0, beats, focus: [], reveals: [] });
  }
  const duration = Math.ceil((audioDuration + 1.2) * lesson.fps) / lesson.fps;
  for (const [i, slot] of scenes.entries()) {
    const scene = lesson.scenes[i]; slot.start = i ? Math.floor(slot.beats[0].start * lesson.fps) / lesson.fps : 0;
    slot.end = i + 1 < scenes.length ? Math.floor(scenes[i + 1].beats[0].start * lesson.fps) / lesson.fps : duration; slot.duration = slot.end - slot.start;
    if (slot.duration <= 0) throw new Error(`Scene has no duration: ${scene.id}`);
    const anchorTime = (item: { beat: number; anchor: string; occurrence?: number }) => {
      const beat = slot.beats[item.beat], text = normalized(scene.beats[item.beat].say), anchor = normalized(item.anchor); let local = -1;
      for (let j = 0; j < (item.occurrence ?? 1); j++) local = text.indexOf(anchor, local + 1);
      if (!anchor || local < 0 || (!item.occurrence && text.indexOf(anchor, local + 1) >= 0)) throw new Error(`Missing/ambiguous anchor: ${scene.id}/${item.anchor}`);
      const cpLocal = Array.from(text.slice(0, local)).length, found = range(beat.charStart + cpLocal, beat.charStart + cpLocal + Array.from(anchor).length);
      return { start: found[0].start, spokenEnd: found.at(-1)!.end, wordStart: found[0].index, wordEnd: found.at(-1)!.index + 1 };
    };
    slot.focus = scene.cues.map((cue, j) => ({ ...cue, ...anchorTime(cue), id: `${slot.id}-${String(j).padStart(2, '0')}`, end: 0, label: cue.label || cue.objects.map(key => { if (!lesson.entities[key]) throw new Error(`Unknown entity ${key}`); return lesson.entities[key].label; }).join(' · ') }));
    slot.focus.forEach((cue, j) => { if (j && cue.start <= slot.focus[j - 1].start) throw new Error(`Focus cues must have distinct, increasing word starts: ${slot.id}`); cue.end = slot.focus[j + 1]?.start ?? slot.end; });
    if (scene.reveals.length !== scene.blocks.length) throw new Error(`Every block needs a reveal: ${scene.id}`); slot.reveals = scene.reveals.map(r => anchorTime(r).start);
  }
  captions.forEach((c, i) => { c.end = Math.min(c.end, captions[i + 1]?.start ?? duration, scenes.find(s => s.id === c.scene)!.end); });
  return { schemaVersion: 2, fps: lesson.fps, audioSrc: 'assets/audio/narration.mp3', audioDuration, duration, words, scenes, captions,
    speech: { mode: 'whole-script', source, scriptSha256: scriptHash, audioSha256, synthesisRequests: source === 'http-tts' || source === 'edge-tts' ? 1 : null, importedAudioUnmodified: source === 'external-import' },
    alignment: { coverage: 1, normalizedCharacters: normalizedLength, wordCount: words.length, captionCount: captions.length, focusCueCount: scenes.reduce((n, s) => n + s.focus.length, 0), finalVisualHold: duration - audioDuration } };
}
const round = (n: number) => Number(n.toFixed(6));
function srtTime(n: number) {
  const ms = Math.round(n * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export const subtitles = (timeline: Timeline) => timeline.captions.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`).join('\n\n') + '\n';
