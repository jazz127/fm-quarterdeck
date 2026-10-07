import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const SOURCE = "data/captain.md";
const MAX_BYTES = 128 * 1024;
const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

// Refuse to publish an entire entry if it appears to contain a credential. This
// is deliberately conservative: it is safer to hide a preference than leak a key.
const sensitive = (text) => /-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|password|secret|credential)\s*[:=]\s*\S+|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9_]{20,})\b/i.test(text);

export function parsePreferences(markdown) {
  if (typeof markdown !== "string") {
    throw new Error("Unrecognized captain preference record");
  }
  const normalized = markdown.replace(/\r\n/g, "\n");
  // Mask only the structural view: bodies and credential checks retain comment
  // text, while preserved newlines keep source ranges tied to the record.
  const visible = normalized.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, " "));
  if (!/^# (?:Working|Captain) preferences\s*$/m.test(visible)) {
    throw new Error("Unrecognized captain preference record");
  }
  const lines = normalized.split("\n");
  const visibleLines = visible.split("\n");
  const headings = [];
  visibleLines.forEach((line, index) => {
    const match = line.match(/^## (\S.*)$/);
    if (match) headings.push({ title: match[1].trim(), start: index });
  });
  if (!headings.length && visibleLines.some((line) => line.trim() && !/^# /.test(line))) {
    throw new Error("Unrecognized preference sections");
  }
  const entries = [];
  let withheld = 0;
  for (let i = 0; i < headings.length; i++) {
    const { title, start } = headings[i];
    const end = (headings[i + 1]?.start ?? lines.length);
    const bodyLines = lines.slice(start + 1, end);
    while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
    while (bodyLines.length && !bodyLines.at(-1).trim()) bodyLines.pop();
    const content = bodyLines.join("\n");
    if (!title || !content) continue;
    if (sensitive(`${title}\n${content}`)) { withheld++; continue; }
    const headingDate = title.match(/\((\d{4}-\d{2}-\d{2})\)\s*$/)?.[1];
    const attribution = bodyLines.filter((line) => /^Recorded from explicit owner instructions?,?\s/i.test(line));
    const recordedDate = attribution.length === 1 ? attribution[0].match(/\b(\d{4}-\d{2}-\d{2})\b/g) : null;
    const date = validDate(headingDate) ? headingDate : recordedDate?.length === 1 && validDate(recordedDate[0]) ? recordedDate[0] : null;
    const dateBasis = date ? (date === headingDate ? "Dated section heading" : "Recorded-from attribution (not necessarily introduction)") : null;
    // A dated heading or source attribution is evidence, not proof of when a
    // preference was added. Only a single explicit added-date claim qualifies.
    const addedClaims = bodyLines.flatMap((line) => {
      const match = line.match(/^\s*(?:Preference )?Added(?: on)?:\s*(\d{4}-\d{2}-\d{2})\s*$/i);
      return match ? [match[1]] : [];
    });
    const addedAt = addedClaims.length === 1 && validDate(addedClaims[0]) ? addedClaims[0] : null;
    // Only an explicitly stated reason is elevated to this field. Preserve the
    // full original text below it, including lists, caveats and safety limits.
    const reasonLine = bodyLines.find((line) => /\b(?:because|so that|in order to|motivating|owner wants|reason:|rather than|to avoid|to preserve|to keep|so the)\b/i.test(line) && !/^Recorded from /i.test(line));
    entries.push({
      title: title.replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, ""),
      content,
      date,
      dateBasis,
      addedAt,
      rationale: reasonLine?.trim() || null,
      rationaleBasis: reasonLine ? "Explicit wording in section" : null,
      source: `${SOURCE}:${start + 1}-${end}`,
    });
  }
  return { source: SOURCE, entries, withheld };
}

export async function readPreferences(home) {
  if (!home) throw new Error("Set FM_HOME to a readable Firstmate home to view preferences.");
  let file;
  try {
    file = await open(path.join(home, SOURCE), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Preference record is not a supported regular file.");
    return parsePreferences(await file.readFile("utf8"));
  } finally {
    await file?.close();
  }
}
