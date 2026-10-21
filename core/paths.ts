import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let root = path.dirname(fileURLToPath(import.meta.url));
while (!existsSync(path.join(root, 'package.json'))) {
  const parent = path.dirname(root);
  if (parent === root) throw new Error('Cannot locate ReasonFrame package root');
  root = parent;
}
export const PROJECT_ROOT = root;
