// Package-free semantic consumer for the declarative CSS regressions. This models
// cascade/media/selector meaning, not browser rendering; served geometry is a separate gate.
function split(text, separator) {
  let depth = 0, quote = '', start = 0;
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (!depth && separator(c)) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}
export function parseCss(source, media = []) {
  source = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let start = 0;
  while (start < source.length) {
    const open = source.indexOf('{', start);
    if (open < 0) break;
    const head = source.slice(start, open).trim();
    let depth = 1, end = open + 1, quote = '';
    for (; end < source.length && depth; end++) {
      const c = source[end];
      if (quote) { if (c === quote && source[end - 1] !== '\\') quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth) throw new Error('Unbalanced CSS artifact');
    const body = source.slice(open + 1, end - 1);
    if (head.startsWith('@media')) rules.push(...parseCss(body, [...media, head.slice(6).trim()]));
    else if (!head.startsWith('@')) {
      const declarations = Object.fromEntries(split(body, c => c === ';').map(entry => {
        const colon = entry.indexOf(':');
        return [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()];
      }));
      for (const selector of split(head, c => c === ',')) rules.push({ selector, media, declarations });
    }
    start = end;
  }
  return rules;
}
function mediaMatches(query, width, height) {
  if (/forced-colors|prefers-reduced-motion|hover|pointer|orientation/.test(query)) return false;
  const limits = [...query.matchAll(/\((min|max)-(width|height):\s*([\d.]+)px\)/g)];
  return limits.length > 0 && limits.every(([, bound, axis, value]) => {
    const actual = axis === 'width' ? width : height;
    return bound === 'min' ? actual >= Number(value) : actual <= Number(value);
  });
}
function compound(node, selector) {
  if (!node || selector.includes('::')) return false;
  let rest = selector;
  for (;;) {
    const pseudo = /:(is|not|has)\(/.exec(rest);
    if (!pseudo) break;
    let end = pseudo.index + pseudo[0].length, depth = 1;
    for (; end < rest.length && depth; end++) { if (rest[end] === '(') depth++; if (rest[end] === ')') depth--; }
    const inside = rest.slice(pseudo.index + pseudo[0].length, end - 1);
    const found = pseudo[1] === 'has' ? (node.children || []).some(child => matches(child, inside))
      : split(inside, c => c === ',').some(part => compound(node, part));
    if (pseudo[1] === 'not' ? found : !found) return false;
    rest = rest.slice(0, pseudo.index) + rest.slice(end);
  }
  for (const [, attr, , value] of rest.matchAll(/\[([\w-]+)(?:=(["']?)([^\]"']+)\2)?\]/g)) {
    if (!(attr in (node.attrs || {})) || value !== undefined && node.attrs[attr] !== value) return false;
  }
  rest = rest.replace(/\[[^\]]+\]/g, '');
  for (const [, id] of rest.matchAll(/#([\w-]+)/g)) if (node.id !== id) return false;
  for (const [, cls] of rest.matchAll(/\.([\w-]+)/g)) if (!node.classes?.includes(cls)) return false;
  for (const [, state] of rest.matchAll(/:([\w-]+)/g)) if (!node.states?.includes(state)) return false;
  const tag = /^[\w-]+/.exec(rest)?.[0];
  return !tag || tag === node.tag;
}
export function matches(node, selector) {
  // Preserve child combinators while splitting only outside attribute/pseudo args.
  const pieces = split(selector.replaceAll(' > ', '>'), c => c === ' ' || c === '>');
  function walk(current, index) {
    if (!compound(current, pieces[index])) return false;
    if (!index) return true;
    // The repository selectors under test use '>' only immediately before the leaf.
    if (index === pieces.length - 1 && selector.includes('>')) return walk(current.parent, index - 1);
    for (let parent = current.parent; parent; parent = parent.parent) if (walk(parent, index - 1)) return true;
    return false;
  }
  return pieces.length > 0 && walk(node, pieces.length - 1);
}
function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const attributes = (selector.match(/\[[^\]]+\]/g) || []).length;
  const classes = (selector.match(/\.[\w-]+/g) || []).length;
  const pseudos = (selector.match(/:(?!:)[\w-]+/g) || []).length;
  return ids * 100 + (attributes + classes + pseudos) * 10;
}
export function computed(rules, node, width = 1440, height = 1000) {
  const values = {}, priorities = {};
  for (const rule of rules) {
    if (!rule.media.every(query => mediaMatches(query, width, height)) || !matches(node, rule.selector)) continue;
    for (let [key, value] of Object.entries(rule.declarations)) {
      const important = value.endsWith('!important');
      if (important) value = value.slice(0, -10).trim();
      const priority = specificity(rule.selector) + (important ? 100000 : 0);
      if ((priorities[key] ?? -1) <= priority) { priorities[key] = priority; values[key] = value; }
    }
  }
  return values;
}
export function element(tag, classes = [], attrs = {}, parent = null, id = '', states = []) {
  const node = { tag, classes, attrs, parent, id, states, children: [] };
  parent?.children.push(node);
  return node;
}
