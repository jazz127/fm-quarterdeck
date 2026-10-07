const decode = (value) => value.replace(/&(amp|lt|gt|quot|#039);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#039": "'" })[entity]);
const encode = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function quotaDom(document) {
  class Node {
    constructor(name, data = "", connected = false) {
      this.nodeType = name === "#text" ? 3 : name === "#fragment" ? 11 : 1;
      this.tagName = name.toUpperCase();
      this.childNodes = [];
      this.parentNode = null;
      this.attrs = new Map();
      this.listeners = new Map();
      this.rootConnected = connected;
      this._data = data;
    }
    get data() { return this._data; }
    set data(value) {
      this._data = value;
      const selection = document.selection;
      if (selection?.anchorNode === this) selection.anchorOffset = 0;
      if (selection?.focusNode === this) selection.focusOffset = 0;
    }
    get length() { return this.data.length; }
    get isConnected() { return this.rootConnected || Boolean(this.parentNode?.isConnected); }
    get attributes() { return Array.from(this.attrs, ([name, value]) => ({ name, value })); }
    get dataset() { return Object.fromEntries(this.attributes.filter(({ name }) => name.startsWith("data-")).map(({ name, value }) => [name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])); }
    get classList() { return { contains: (name) => (this.getAttribute("class") || "").split(/\s+/).includes(name) }; }
    get open() { return this.hasAttribute("open"); }
    set open(value) { if (value) this.setAttribute("open", ""); else this.removeAttribute("open"); }
    get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((node) => node.textContent).join(""); }
    set textContent(value) {
      for (const child of [...this.childNodes]) this.removeChild(child);
      if (value) this.insertBefore(new Node("#text", value), null);
    }
    get innerHTML() { return this.childNodes.map((node) => node.serialize()).join(""); }
    set innerHTML(html) {
      for (const child of [...this.childNodes]) this.removeChild(child);
      const stack = [this];
      for (const token of html.match(/<\/?[a-z][^>]*>|[^<]+/gi) || []) {
        if (token.startsWith("</")) { stack.pop(); continue; }
        if (!token.startsWith("<")) { stack.at(-1).insertBefore(new Node("#text", decode(token)), null); continue; }
        const tag = /^<([\w-]+)/.exec(token)[1];
        const node = new Node(tag);
        const attributes = token.slice(tag.length + 1, -1);
        for (const match of attributes.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) node.setAttribute(match[1], decode(match[2] || ""));
        stack.at(-1).insertBefore(node, null);
        if (!["input", "br", "hr", "img"].includes(tag)) stack.push(node);
      }
    }
    serialize() {
      if (this.nodeType === 3) return encode(this.data);
      if (this.nodeType === 11) return this.innerHTML;
      const tag = this.tagName.toLowerCase();
      const attributes = this.attributes.map(({ name, value }) => value === "" ? ` ${name}` : ` ${name}="${encode(value)}"`).join("");
      return `<${tag}${attributes}>${this.innerHTML}${["input", "br", "hr", "img"].includes(tag) ? "" : `</${tag}>`}`;
    }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    hasAttribute(name) { return this.attrs.has(name); }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    removeAttribute(name) { this.attrs.delete(name); }
    contains(node) { return node === this || this.childNodes.some((child) => child.contains(node)); }
    insertBefore(node, before) {
      if (node === before) return node;
      if (node.parentNode) node.parentNode.removeChild(node);
      const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
      if (index < 0) throw new Error("Reference node is not a child");
      this.childNodes.splice(index, 0, node);
      node.parentNode = this;
      return node;
    }
    removeChild(node) {
      const index = this.childNodes.indexOf(node);
      if (index < 0) throw new Error("Node is not a child");
      if (node.contains(document.activeElement)) document.activeElement = null;
      const selection = document.selection;
      if (selection && (node.contains(selection.anchorNode) || node.contains(selection.focusNode))) selection.setBaseAndExtent(this, index, this, index);
      this.childNodes.splice(index, 1);
      node.parentNode = null;
      return node;
    }
    remove() { this.parentNode?.removeChild(this); }
    matches(selector) {
      if (this.nodeType !== 1) return false;
      const tag = /^[\w-]+/.exec(selector)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
      for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) if (!this.hasAttribute(name) || (value !== undefined && this.getAttribute(name) !== value)) return false;
      return true;
    }
    querySelectorAll(selector) {
      const parts = selector.split(/\s+/);
      const matches = (node, index) => {
        if (!node.matches(parts[index])) return false;
        if (index === 0) return true;
        for (let parent = node.parentNode; parent && parent !== this; parent = parent.parentNode) if (matches(parent, index - 1)) return true;
        return false;
      };
      const nodes = [];
      const walk = (parent) => {
        for (const child of parent.childNodes) {
          if (matches(child, parts.length - 1)) nodes.push(child);
          walk(child);
        }
      };
      walk(this);
      return nodes;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { document.activeElement = this; }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    dispatchEvent(event) {
      event.target ||= this;
      for (let node = this; node; node = node.parentNode) for (const listener of node.listeners.get(event.type) || []) listener(event);
    }
  }
  document.selection = {
    anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0,
    setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
      const length = (node) => node.nodeType === 3 ? node.length : node.childNodes.length;
      if (anchorOffset < 0 || anchorOffset > length(anchorNode) || focusOffset < 0 || focusOffset > length(focusNode)) throw new RangeError("Selection offset exceeds node length");
      Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
    },
    toString() {
      return this.anchorNode === this.focusNode && this.anchorNode?.nodeType === 3
        ? this.anchorNode.data.slice(Math.min(this.anchorOffset, this.focusOffset), Math.max(this.anchorOffset, this.focusOffset)) : "";
    }
  };
  return {
    element(name, connected = false) {
      const node = new Node(name, "", connected);
      if (name === "template") {
        node.content = new Node("#fragment");
        Object.defineProperty(node, "innerHTML", { set(html) { node.content.innerHTML = html; } });
      }
      return node;
    }
  };
}
