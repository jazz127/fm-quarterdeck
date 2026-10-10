// Minimal DOM for Captain's Call patcher tests: element identity, attributes,
// bubbling events, focus, a single selection range and stacked card geometry.
const decode = (value) => value.replace(/&(amp|lt|gt|quot|#039);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#039": "'" })[entity]);
const VOID = new Set(["input", "br", "hr", "img"]);

export function callDom() {
  let mutations = 0;
  const listenersOf = new WeakMap();
  const on = (target, type, listener) => { if (!listenersOf.has(target)) listenersOf.set(target, new Map()); const map = listenersOf.get(target); if (!map.has(type)) map.set(type, []); map.get(type).push(listener); };
  const off = (target, type, listener) => { const list = listenersOf.get(target)?.get(type); if (list) list.splice(list.indexOf(listener) >>> 0, 1); };
  const fire = (target, event) => { for (const listener of [...(listenersOf.get(target)?.get(event.type) || [])]) listener(event); };

  const selection = {
    node: null,
    get isCollapsed() { return !this.node; },
    get rangeCount() { return this.node ? 1 : 0; },
    getRangeAt() { const node = this.node; return { intersectsNode: (other) => Boolean(node && (other.contains(node) || node.contains(other))) }; },
    selectAllChildren(node) { this.node = node; document.dispatchEvent({ type: "selectionchange" }); },
    removeAllRanges() { this.node = null; document.dispatchEvent({ type: "selectionchange" }); },
  };

  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.attrs = new Map();
      this.childNodes = [];
      this.parentNode = null;
      this.text = "";
      this.value = "";
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.selectionDirection = "none";
      this.rect = null;
    }
    get children() { return this.childNodes.filter((node) => node instanceof Element); }
    get nextElementSibling() {
      const siblings = this.parentNode?.children || [];
      return siblings[siblings.indexOf(this) + 1] || null;
    }
    get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
    hasAttribute(name) { return this.attrs.has(name); }
    setAttribute(name, value) { mutations += 1; this.attrs.set(name, String(value)); }
    removeAttribute(name) { if (this.attrs.delete(name)) mutations += 1; }
    toggleAttribute(name, force) { const on = force ?? !this.hasAttribute(name); if (on && !this.hasAttribute(name)) this.setAttribute(name, ""); else if (!on) this.removeAttribute(name); return on; }
    get className() { return this.getAttribute("class") || ""; }
    set className(value) { this.setAttribute("class", value); }
    get classList() {
      const names = () => this.className.split(/\s+/).filter(Boolean);
      return {
        contains: (name) => names().includes(name),
        add: (name) => { if (!names().includes(name)) this.className = [...names(), name].join(" "); },
        remove: (name) => { if (names().includes(name)) this.className = names().filter((entry) => entry !== name).join(" "); },
      };
    }
    get hidden() { return this.hasAttribute("hidden"); }
    set hidden(value) { if (value) { if (!this.hidden) this.setAttribute("hidden", ""); } else this.removeAttribute("hidden"); }
    get textContent() { return this.text + this.childNodes.map((node) => node.textContent).join(""); }
    set textContent(value) { mutations += 1; for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this.text = String(value); }
    get innerHTML() { return this.text.replace(/&/g, "&amp;").replace(/</g, "&lt;") + this.childNodes.map((node) => node.outerHTML).join(""); }
    get outerHTML() {
      const tag = this.tagName.toLowerCase();
      const attrs = [...this.attrs].map(([name, value]) => value === "" ? ` ${name}` : ` ${name}="${value}"`).join("");
      return VOID.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
    }
    set innerHTML(html) {
      mutations += 1;
      for (const child of this.childNodes) { if (child.contains(document.activeElement)) document.activeElement = null; child.parentNode = null; }
      this.childNodes = [];
      this.text = "";
      const stack = [this];
      for (const token of html.match(/<\/?[a-z][^>]*>|[^<]+/gi) || []) {
        if (token.startsWith("</")) { stack.pop(); continue; }
        const parent = stack.at(-1);
        if (!token.startsWith("<")) {
          const text = new Element("#text");
          text.text = decode(token);
          text.parentNode = parent;
          parent.childNodes.push(text);
          continue;
        }
        const tag = /^<([\w-]+)/.exec(token)[1].toLowerCase();
        const node = new Element(tag);
        for (const match of token.slice(tag.length + 1).matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) node.attrs.set(match[1], decode(match[2] || ""));
        node.parentNode = parent;
        parent.childNodes.push(node);
        if (!VOID.has(tag) && !token.endsWith("/>")) stack.push(node);
      }
    }
    contains(node) { for (let cursor = node; cursor; cursor = cursor.parentNode) if (cursor === this) return true; return false; }
    insertBefore(node, before) {
      if (node === before) return node;
      if (node.isConnected && node.contains(document.activeElement)) document.activeElement = null;
      if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
      const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
      if (index < 0) throw new Error("Reference node is not a child");
      this.childNodes.splice(index, 0, node);
      node.parentNode = this;
      mutations += 1;
      return node;
    }
    append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
    replaceWith(node) {
      if (!this.parentNode) return;
      this.parentNode.insertBefore(node, this);
      this.remove();
    }
    remove() {
      if (!this.parentNode) return;
      if (this.contains(document.activeElement)) document.activeElement = null;
      this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
      this.parentNode = null;
      mutations += 1;
    }
    matches(selector) {
      return selector.split(",").some((part) => {
        const simple = part.trim();
        if (this.tagName === "#TEXT") return false;
        const tag = /^[a-z][\w-]*/i.exec(simple)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        for (const [, name] of simple.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
        for (const [, name, value] of simple.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) if (!this.hasAttribute(name) || (value !== undefined && this.getAttribute(name) !== value)) return false;
        return true;
      });
    }
    closest(selector) { for (let node = this; node instanceof Element; node = node.parentNode) if (node.matches(selector)) return node; return null; }
    querySelectorAll(selector) {
      const found = [];
      const walk = (node) => { for (const child of node.children) { if (child.matches(selector)) found.push(child); walk(child); } };
      walk(this);
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, listener) { on(this, type, listener); }
    removeEventListener(type, listener) { off(this, type, listener); }
    dispatchEvent(event) {
      event.target ||= this;
      for (let node = this; node; node = node.parentNode) fire(node, event);
      if (this.isConnected) fire(document, event);
    }
    getBoundingClientRect() { return this.rect || { top: 0, bottom: 0, height: 0 }; }
    focus() {
      const previous = document.activeElement;
      if (previous === this) return;
      document.activeElement = this;
      previous?.dispatchEvent({ type: "focusout", relatedTarget: this });
      this.dispatchEvent({ type: "focusin", relatedTarget: previous });
    }
    blur() {
      if (document.activeElement !== this) return;
      document.activeElement = null;
      this.dispatchEvent({ type: "focusout", relatedTarget: null });
    }
    setSelectionRange(start, end, direction = "none") {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = direction;
    }
    // A user gesture: pointer press, release and click on this element.
    click() {
      this.dispatchEvent({ type: "pointerdown" });
      this.dispatchEvent({ type: "pointerup" });
      this.dispatchEvent({ type: "click", preventDefault() {} });
    }
    type(text) {
      this.focus();
      this.value = text;
      this.dispatchEvent({ type: "input" });
    }
  }

  const document = {
    activeElement: null,
    body: null,
    visibilityState: "visible",
    createElement: (tag) => new Element(tag),
    getSelection: () => selection,
    addEventListener: (type, listener) => on(document, type, listener),
    removeEventListener: (type, listener) => off(document, type, listener),
    dispatchEvent: (event) => { event.target ||= document; fire(document, event); },
  };
  document.body = new Element("body");
  return { document, selection, Element, mutations: () => mutations };
}

// Deterministic timers shared by the client tests.
export function fakeTimers() {
  let now = 0, seq = 0;
  const tasks = new Map();
  return {
    setTimeout: (fn, ms = 0) => { const id = ++seq; tasks.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { tasks.delete(id); },
    setInterval: (fn, ms) => { const id = ++seq; tasks.set(id, { at: now + ms, fn, interval: ms }); return id; },
    clearInterval: (id) => { tasks.delete(id); },
    pending: () => tasks.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        tasks.delete(next[0]);
        now = next[1].at;
        if (next[1].interval) tasks.set(next[0], { ...next[1], at: now + next[1].interval });
        next[1].fn();
      }
      now = end;
    },
  };
}
