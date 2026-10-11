// Explicit lettered choices on a decision (BEARINGS.md "Answers").
// A line is an option only when its marker is one letter. Prose is not guessed.
const LEAD = /^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,3}[.)])\s+)?(?:#{1,6}\s+)?(?:\p{Extended_Pictographic}️?\s*)?(?:[*_]{1,3}\s*)?/u;
const FENCE = /^\s*(?:```|~~~)/;
const QUOTE = /^[*_]{0,3}\s*(?:"([^"\n]{1,200})"|“([^”\n]{1,200})”|`([^`\n]{1,200})`|'([^'\n]{1,200})'|‘([^’\n]{1,200})’)\s*[*_]{0,3}/;
const MAX_OPTIONS = 8;
const HINT_CAP = 240;

const oneLine = (value) => {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > HINT_CAP ? `${cleaned.slice(0, HINT_CAP - 1)}…` : cleaned;
};

function stripLead(line) {
  const lead = LEAD.exec(line);
  return line.slice(lead ? lead[0].length : 0).replace(/^[*_]+/, "").trim();
}

// `a) desc`, `(a) desc`, `"a": desc`, `Option A: desc`, `a — desc`, `a. desc`.
// A capital `A.` sentence is not an option. A repeated letter voids the set.
function matchLetter(body) {
  const optionWord = /^(?:option\s+)/i.exec(body);
  const rest = optionWord ? body.slice(optionWord[0].length).replace(/^[*_]+/, "") : body;
  const paren = /^\(([A-Za-z])\)\s*[:.)—–-]?\s+(\S.*)$/.exec(rest);
  if (paren) return { letter: paren[1], hint: paren[2] };
  const quoted = /^(?:"([A-Za-z])"|“([A-Za-z])”|`([A-Za-z])`|'([A-Za-z])'|‘([A-Za-z])’)\s*[*_]*\s*[:)—–-]\s+(\S.*)$/.exec(rest);
  if (quoted) return { letter: quoted.slice(1, 6).find(Boolean), hint: quoted[6] };
  const bare = /^([A-Za-z])[*_]*\s*(?:[:)]\s*|[—–-]\s+)(\S.*)$/.exec(rest);
  if (bare) return { letter: bare[1], hint: bare[2] };
  const dotted = /^([a-z])\.\s+(\S.*)$/.exec(rest);
  if (dotted) return { letter: dotted[1], hint: dotted[2] };
  if (optionWord) {
    const titled = /^([A-Za-z])\.\s+(\S.*)$/.exec(rest);
    if (titled) return { letter: titled[1], hint: titled[2] };
  }
  return null;
}

export function enumeratedLetterOptions(text) {
  const found = [];
  const seen = new Set();
  let fence = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (FENCE.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const match = matchLetter(stripLead(line));
    if (!match) continue;
    const hint = oneLine(match.hint);
    const key = match.letter.toLowerCase();
    if (!hint || seen.has(key)) return [];
    seen.add(key);
    found.push({ value: match.letter, label: match.letter, hint });
    if (found.length > MAX_OPTIONS) return [];
  }
  return found.length >= 2 ? found : [];
}

// Description after a quoted reply label on its own line: `- "stay": continue`.
export function replyDescription(text, reply) {
  const wanted = String(reply ?? "").trim();
  if (!wanted) return null;
  let fence = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (FENCE.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const body = stripLead(line);
    const quoted = QUOTE.exec(body);
    if (!quoted) continue;
    const label = quoted.slice(1, 6).find((value) => value !== undefined)?.trim();
    if (label !== wanted) continue;
    const after = body.slice(quoted[0].length).replace(/^[*_]+/, "");
    const separator = /^\s*[:—–-]\s+(\S.*)$/.exec(after);
    if (!separator) continue;
    return oneLine(separator[1]);
  }
  return null;
}

// Drop a set that sanitizing leaves without two described choices.
export function publishOptions(options, sanitize) {
  const published = [];
  for (const option of options) {
    const label = sanitize(option.label, 120);
    const hint = sanitize(option.hint, HINT_CAP);
    if (!label || !hint || option.value !== option.label) continue;
    published.push({ value: option.value, label, hint });
  }
  return published.length >= 2 ? published : [];
}
