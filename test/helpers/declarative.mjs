import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const { parse } = createRequire(new URL('../../prototype/package.json', import.meta.url))('yaml');

export function workflowModel() {
  return parse(readFileSync(new URL('../../.github/workflows/source-preview.yml', import.meta.url), 'utf8'), { uniqueKeys: true });
}

export function frontmatterModel(source) {
  const lines = source.split(/\r?\n/);
  if (lines.shift() !== '---') throw new Error('Missing frontmatter');
  const end = lines.indexOf('---');
  if (end < 0) throw new Error('Unterminated frontmatter');
  return parse(lines.slice(0, end).join('\n'), { uniqueKeys: true });
}
