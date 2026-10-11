import { parse, parseFragment } from 'parse5';
import { matches } from './css-model.mjs';

export function htmlModel(source, { fragment = false } = {}) {
  const nodes = [];
  function normalize(raw, parent = null) {
    const attrs = Object.fromEntries((raw.attrs || []).map(({ name, value }) => [name, value]));
    const node = {
      tag: raw.tagName || raw.nodeName, attrs, parent, id: attrs.id || '',
      classes: (attrs.class || '').split(/\s+/).filter(Boolean), states: [], children: [],
      textContent: raw.value || '',
    };
    nodes.push(node);
    node.children = (raw.childNodes || []).map(child => normalize(child, node));
    node.textContent += node.children.map(child => child.textContent).join('');
    return node;
  }
  normalize(fragment ? parseFragment(source) : parse(source));
  return {
    all: selector => nodes.filter(node => matches(node, selector)),
    one: selector => nodes.find(node => matches(node, selector)) || null,
  };
}
