import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from 'mathjs';
import katex from 'katex';
import { LessonSchema, type Lesson } from '../shared/schema.js';
import { normalized } from './alignment.js';
import { readJson, writeJson } from './files.js';
const functions = new Set(['sqrt', 'abs', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'log', 'log10', 'min', 'max', 'sum', 'dot', 'cross', 'norm', 'det', 'transpose', 'flatten', 'lusolve', 'multiply', 'divide', 'add', 'subtract']);
const operators = new Set(['+', '-', '*', '/', '^']);
function evaluate(expression: string, model: Lesson['model']): number {
  const tree = parse(expression); let count = 0;
  tree.traverse((node: any) => {
    if (++count > 160) throw new Error('Expression is too complex');
    if (!['ConstantNode', 'SymbolNode', 'OperatorNode', 'ParenthesisNode', 'FunctionNode', 'ArrayNode'].includes(node.type)) throw new Error(`Unsupported expression node: ${node.type}`);
    if (node.type === 'SymbolNode' && !functions.has(node.name) && !['pi', 'e'].includes(node.name) && !Object.hasOwn(model, node.name)) throw new Error(`Unknown symbol: ${node.name}`);
    if (node.type === 'FunctionNode' && !functions.has(node.name)) throw new Error(`Unsupported function: ${node.name}`);
    if (node.type === 'OperatorNode' && !operators.has(node.op)) throw new Error(`Unsupported operator: ${node.op}`);
    if (node.type === 'OperatorNode' && node.op === '^') {
      const exp = node.args[1]; if (exp.type !== 'ConstantNode' || Math.abs(Number(exp.value)) > 12) throw new Error('Powers need a constant exponent within -12..12; use sqrt for roots');
    }
  });
  const value = tree.compile().evaluate(new Map(Object.entries(model)));
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('A claim must evaluate to a finite real scalar'); return value;
}
export function verifyMath(lesson: Lesson) {
  const results = lesson.claims.map(claim => {
    try {
      if (claim.left.replace(/\s+/g, '') === claim.right.replace(/\s+/g, '')) throw new Error('A claim cannot merely compare an expression with itself');
      const left = evaluate(claim.left, lesson.model), right = evaluate(claim.right, lesson.model), delta = left - right, tolerance = claim.absoluteTolerance + claim.tolerance * Math.max(Math.abs(left), Math.abs(right));
      const passed = claim.relation === 'eq' ? Math.abs(delta) <= tolerance : claim.relation === 'lt' ? delta < -tolerance : claim.relation === 'gt' ? delta > tolerance : claim.relation === 'lte' ? delta <= tolerance : delta >= -tolerance;
      return { id: claim.id, description: claim.description, kind: claim.kind, passed, left, right, tolerance };
    } catch (e) { return { id: claim.id, description: claim.description, kind: claim.kind, passed: false, error: (e as Error).message }; }
  });
  return { passed: results.every(r => r.passed), method: 'bounded numeric expressions over the exact rendered model; logical proof also requires independent review', checks: results.length, results };
}
export function validateStructure(lesson: Lesson, fps?: number) {
  const issues: string[] = [], claimIds = new Set(lesson.claims.map(c => c.id));
  if (claimIds.size !== lesson.claims.length) issues.push('Claim ids must be unique');
  if (!lesson.claims.some(c => c.kind === 'given') || !lesson.claims.some(c => c.kind === 'answer')) issues.push('Need at least one given claim and one answer claim');
  if (new Set(lesson.scenes.map(s => s.id)).size !== lesson.scenes.length) issues.push('Scene ids must be unique');
  if (fps !== undefined && lesson.fps !== fps) issues.push(`fps must equal request fps ${fps}`);
  for (const [key, entity] of Object.entries(lesson.entities)) for (const vertex of entity.vertices ?? []) if (!Object.hasOwn(lesson.model, vertex) || !Array.isArray(lesson.model[vertex]) || (lesson.model[vertex] as number[]).length !== 3) issues.push(`${key}: vertex ${vertex} must refer to a model 3-vector`);
  for (const scene of lesson.scenes) {
    if (scene.chapter >= lesson.chapters.length) issues.push(`${scene.id}: unknown chapter`);
    if (scene.reveals.length !== scene.blocks.length) issues.push(`${scene.id}: every block needs one reveal`);
    scene.claimIds.forEach(c => { if (!claimIds.has(c)) issues.push(`${scene.id}: unknown claim ${c}`); });
    for (const item of [...scene.cues, ...scene.reveals]) {
      const beat = scene.beats[item.beat]; if (!beat) { issues.push(`${scene.id}: unknown beat ${item.beat}`); continue; }
      const text = normalized(beat.say), anchor = normalized(item.anchor); let position = -1, count = 0;
      while (anchor && (position = text.indexOf(anchor, position + 1)) >= 0) count++;
      if (!anchor || !count || (item.occurrence ? item.occurrence > count : count !== 1)) issues.push(`${scene.id}: missing/ambiguous spoken anchor ${item.anchor}`);
    }
    for (const cue of scene.cues) for (const key of cue.objects) if (!lesson.entities[key]) issues.push(`${scene.id}: unknown entity ${key}`);
    for (const block of scene.blocks) {
      if (block.beat >= scene.beats.length) issues.push(`${scene.id}: block references an unknown beat`);
      if (block.math) { try { katex.renderToString(block.math, { throwOnError: true, strict: 'ignore' }); } catch (e) { issues.push(`${scene.id}: invalid TeX: ${(e as Error).message}`); } }
    }
  }
  const referenced = new Set(lesson.scenes.flatMap(s => s.claimIds));
  for (const claim of lesson.claims.filter(c => c.kind === 'answer')) if (!referenced.has(claim.id)) issues.push(`Answer claim ${claim.id} is not connected to a scene`);
  return { passed: issues.length === 0, issues };
}
export async function validateWorkspace(workspace: string, fps?: number) {
  try {
    const lesson = LessonSchema.parse(await readJson(path.join(workspace, 'lesson.json')));
    const [visual, style] = await Promise.all(['visual.js', 'style.css'].map(f => fs.readFile(path.join(workspace, 'src', f), 'utf8')));
    const structure = validateStructure(lesson, fps), math = verifyMath(lesson);
    try { new vm.Script(visual, { filename: 'src/visual.js' }); } catch (e) { structure.issues.push((e as Error).message); }
    if (!visual.includes('ReasonFrameVisual')) structure.issues.push('visual.js must define window.ReasonFrameVisual.render');
    if (/\b(?:https?:)?\/\//i.test(style) || /@import/i.test(style)) structure.issues.push('Use local CSS assets only');
    structure.passed = structure.issues.length === 0;
    await Promise.all([writeJson(path.join(workspace, 'reports/structure.json'), structure), writeJson(path.join(workspace, 'reports/math.json'), math)]);
    return { passed: structure.passed && math.passed, lesson, structure, math };
  } catch (e) { const result = { passed: false as const, error: (e as Error).message }; await writeJson(path.join(workspace, 'reports/structure.json'), result); return result; }
}
