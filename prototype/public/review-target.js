// Selector/range/table capture adapted from lavish-axi (MIT); see THIRD-PARTY-NOTICES.md.
(() => {
  const excerpt = (node) => String(node?.innerText ?? node?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  const element = (node) => node?.nodeType === 1 || node?.tagName ? node : node?.parentElement;
  function cssSelector(el) {
    const parts = [];
    for (let node = el; node?.tagName && parts.length < 5; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.matches?.(".message-content")) { parts.unshift(".message-content"); break; }
      const reviewId = node.getAttribute?.("data-review-id");
      if (reviewId) { parts.unshift(`[data-review-id="${reviewId.replace(/[\\"\n\r\f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `)}"]`); break; }
      if (node.id) { parts.unshift(`${part}#${globalThis.CSS?.escape ? globalThis.CSS.escape(node.id) : node.id.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `)}`); break; }
      const same = Array.from(node.parentElement?.children || []).filter((child) => child.tagName === node.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    return parts.join(" > ").slice(0, 512);
  }
  function boundary(node, offset) {
    const root = element(node), path = [];
    for (let current = node; current && current !== root; current = current.parentNode) {
      if (!current.parentNode) return null;
      path.unshift(Array.from(current.parentNode.childNodes).indexOf(current));
    }
    return { selector: cssSelector(root), path, offset };
  }
  function textRangeTarget(selection) {
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0), ancestor = element(range.commonAncestorContainer);
    const text = selection.toString().replace(/\s+/g, " ").trim().slice(0, 240);
    if (range.collapsed || !text || !ancestor?.closest?.(".product-view, .lane-list, .context-rail")) return null;
    // Never permit a range spanning separate message identities or review chrome.
    const startElement = element(range.startContainer), endElement = element(range.endContainer);
    if (startElement?.closest?.(".message") !== endElement?.closest?.(".message") || ancestor.closest?.("#review-panel, #review-annotation")) return null;
    const block = ancestor.closest?.("p, li, pre, td, th, .message-content") || ancestor;
    const before = range.cloneRange(), after = range.cloneRange();
    before.selectNodeContents(block); before.setEnd(range.startContainer, range.startOffset);
    after.selectNodeContents(block); after.setStart(range.endContainer, range.endOffset);
    const selector = cssSelector(ancestor);
    return { element: ancestor, tag: "text", selector, text, target: { type: "text-range", text, selector, commonAncestorSelector: selector, start: boundary(range.startContainer, range.startOffset), end: boundary(range.endContainer, range.endOffset), prefix: before.toString().replace(/\s+/g, " ").slice(-32), suffix: after.toString().replace(/\s+/g, " ").slice(0, 32) } };
  }
  const rowCells = (row) => Array.from(row?.children || []).filter((node) => /^(TH|TD)$/.test(node.tagName));
  const spanValue = (cell, name) => {
    const parsed = cell?.[name === "colspan" ? "colSpan" : "rowSpan"];
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    const digits = /^[\t\n\f\r ]*(\d+)/.exec(String(cell?.getAttribute?.(name) ?? ""));
    return digits ? Number(digits[1]) : 1;
  };
  const width = (cell) => Math.max(1, spanValue(cell, "colspan"));
  const rowsIn = (root, table) => Array.from(root?.querySelectorAll?.("tr") || []).filter((row) => row.closest("table") === table);
  function rowShifted(table, row) {
    const group = row.parentElement?.closest?.("thead,tbody,tfoot") || table;
    const rows = rowsIn(group, table), index = rows.indexOf(row);
    if (index < 0) return true;
    return rows.slice(0, index).some((previous, i) => rowCells(previous).some((cell) => spanValue(cell, "rowspan") === 0 || spanValue(cell, "rowspan") > index - i));
  }
  function columnLabel(header, cells, index) {
    const headers = rowCells(header);
    if (!headers.length || headers.reduce((n, cell) => n + width(cell), 0) !== cells.reduce((n, cell) => n + width(cell), 0)) return "";
    const start = cells.slice(0, index).reduce((n, cell) => n + width(cell), 0), end = start + width(cells[index]);
    let cursor = 0;
    for (const cell of headers) {
      const next = cursor + width(cell);
      if (cursor === start && next === end) return excerpt(cell);
      if (start < next) return "";
      cursor = next;
    }
    return "";
  }
  function tableCellTarget(el) {
    const cell = el.closest?.("td,th"), row = cell?.closest?.("tr"), table = row?.closest?.("table");
    if (!cell || !row || !table) return null;
    const cells = rowCells(row), index = cells.indexOf(cell);
    if (index < 0) return null;
    const head = Array.from(table.children).find((node) => node.tagName === "THEAD");
    const first = rowsIn(table, table)[0];
    const header = head ? rowsIn(head, table).at(-1) : rowCells(first).length && rowCells(first).every((node) => node.tagName === "TH") ? first : null;
    const shifted = rowShifted(table, row), gridShifted = shifted || (header ? rowShifted(table, header) : false);
    const declared = cells.find((node) => node.tagName === "TH" && String(node.getAttribute("scope") || "").toLowerCase() === "row");
    const heading = row === header || cell.closest("thead") ? null : declared || (shifted || cells.every((node) => node.tagName === "TH") ? null : cells[0]);
    return { type: "table-cell", selector: cssSelector(cell), rowLabel: excerpt(heading), columnLabel: gridShifted ? "" : columnLabel(header, cells, index), text: excerpt(cell) };
  }
  async function recordFingerprint(text) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }
  function migrateEntry(entry) {
    if (typeof entry.prompt === "string") return entry;
    const converted = { prompt: entry.text, tag: entry.kind === "message" ? "message" : "element", selector: "", text: "", route: entry.route, version: entry.version };
    if (entry.region) converted.label = entry.region.label.slice(0, 160);
    if (entry.target?.type === "record") converted.record = { recordId: entry.target.recordId };
    if (entry.target?.type === "quote") {
      converted.text = entry.target.text.slice(0, 240);
      converted.record = { source: "legacy-quote", at: new Date(0).toISOString(), lanes: entry.target.lanes };
      recordFingerprint(entry.target.text).then((sha256) => { converted.record.sha256 = sha256; }).catch(() => {});
    }
    return converted;
  }
  window.QuarterdeckReviewTarget = { cssSelector, textRangeTarget, tableCellTarget, excerpt, recordFingerprint, migrateEntry };
})();
