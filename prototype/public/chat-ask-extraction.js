// Canonical Captain's Call marker/reply extraction shared by chat scanning and Fleet Chats.
// No records, authority, status or delivery are created by this pure parser.
const KINDS = { ACTION: "action", APPROVAL: "approval", DECISION: "decision" };
const MAX_ASK_CHARS = 4000;
const MAX_REPLIES = 6;

export function taskMarkers(text) {
  return [...new Set([...String(text).matchAll(/\[task:([A-Za-z0-9][A-Za-z0-9._-]{0,159})\]/g)].map(match => match[1]))];
}

// ---------------------------------------------------------------------------------------
// Pure extraction

// A marker is recognised only at the start of a line, after optional blockquote, list
// bullet, heading and emphasis markup, so prose that merely mentions a marker (inside
// backticks or mid-sentence) never becomes a card. Markers are upper case by convention.
const LEAD = /^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,3}[.)])\s+)?(?:#{1,6}\s+)?(?:\p{Extended_Pictographic}️?\s*)?(?:[*_]{1,3}\s*)?/u;
const MARKER = /^(ACTION|APPROVAL|DECISION) NEEDED(?![A-Za-z0-9_])/;
const AFTER_MARKER = /^\s*[*_]{0,3}\s*(?:[:—–]|-(?!-))?\s*[*_]{0,3}\s*/;
const FENCE = /^\s*(?:```|~~~)/;
const LANE_LINE = /^\s*\[(?:fm-lane|end)\s[^\]]*\]\s*$/;

function markerLine(line) {
  const lead = LEAD.exec(line)[0];
  const match = MARKER.exec(line.slice(lead.length));
  if (!match) return null;
  const rest = line.slice(lead.length + match[0].length);
  return { kind: KINDS[match[1]], marker: `${match[1]} NEEDED`, rest: rest.replace(AFTER_MARKER, "").trim() };
}

// Quoted alternatives after the word "reply": Reply **"yes"**, reply `ship` or `hold`,
// shortest reply: "go". Unquoted replies are ambiguous and are never guessed.
const REPLY = /\breply(?:\s+(?:with|exactly))?\s*:?\s*/gi;
const QUOTED = /^[*_]{0,3}\s*(?:"([^"\n]{1,200})"|“([^”\n]{1,200})”|`([^`\n]{1,200})`|'([^'\n]{1,200})'|‘([^’\n]{1,200})’)\s*[*_]{0,3}/;
const SEPARATOR = /^\s*(?:,|\/|\||\bor\b)\s*/i;
export function extractReplies(text) {
  const replies = [];
  for (const match of String(text).matchAll(REPLY)) {
    let rest = text.slice(match.index + match[0].length);
    for (;;) {
      const quoted = QUOTED.exec(rest);
      if (!quoted) break;
      const reply = quoted.slice(1).find(value => value !== undefined).trim();
      if (reply && !replies.includes(reply) && replies.length < MAX_REPLIES) replies.push(reply);
      rest = rest.slice(quoted[0].length);
      const separator = SEPARATOR.exec(rest);
      if (!separator) break;
      rest = rest.slice(separator[0].length);
    }
  }
  // Explicit option labels at the start of an ask/list line also supply replies:
  // - "stay here": continue; or "plan A" keeps the current setup.
  for (const line of String(text).split(/\r?\n/)) {
    const quoted = QUOTED.exec(line.slice(LEAD.exec(line)[0].length));
    if (!quoted) continue;
    const reply = quoted.slice(1).find(value => value !== undefined).trim();
    if (reply && !replies.includes(reply) && replies.length < MAX_REPLIES) replies.push(reply);
  }
  return replies;
}

const readable = (text) => text.replace(/\*\*|__/g, "").replace(/[ \t]+/g, " ").trim();

// Each marker line opens an ask; following non-blank lines continue it (a DECISION NEEDED
// line often introduces a list). A blank line, another marker, a code fence or a lane
// marker ends it. Code fences are skipped entirely: examples are not asks.
export function extractAskSections(text) {
  const source = String(text ?? "");
  const asks = [];
  let fence = false, current = null;
  const close = () => {
    if (!current) return;
    const raw = current.body.filter(Boolean).join("\n");
    const clipped = raw.length > MAX_ASK_CHARS ? `${raw.slice(0, MAX_ASK_CHARS - 1)}…` : raw;
    const ask = { kind: current.kind, marker: current.marker, line: current.line, taskMarkers: taskMarkers(current.line), text: readable(clipped), replies: extractReplies(raw) };
    asks.push({ ask, start: current.start, end: current.end, raw: source.slice(current.start, current.end) });
    current = null;
  };
  let offset = 0;
  for (const chunk of source.split(/(?<=\n)/)) {
    const line = chunk.replace(/\r?\n$/, "");
    const start = offset;
    offset += chunk.length;
    if (FENCE.test(line)) { close(); fence = !fence; continue; }
    if (fence) continue;
    const marker = markerLine(line);
    if (marker) { close(); current = { ...marker, line: line.trim(), body: [marker.rest], start, end: offset }; continue; }
    if (!current) continue;
    if (LANE_LINE.test(line)) { close(); continue; }
    if (!line.trim()) { if (current.body.some(Boolean)) close(); continue; }
    current.body.push(line.trim());
    current.end = offset;
  }
  close();
  return asks;
}

// Keep the server projection identical; ranges are presentation evidence only.
export function extractAsks(text) {
  return extractAskSections(text).map(({ ask }) => ask);
}
