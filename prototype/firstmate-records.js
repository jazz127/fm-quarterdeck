// Firstmate's fm-classify-lib.sh owns status tags, key positions and correlation
// tokens; fm-hold-reason-lib.sh owns the reversible reason encoding.
export function parseStatusLine(line) {
  const match = line.match(/^\s*([a-z-]+)((?:\s+corr=[a-f0-9]{16})*)(\s*(?:\[[^\]]*\]\s*)*)(?::\s*(.*))?$/i);
  if (!match) return { state: "update", text: line, fields: [], key: null, phaseKey: null, transitionAllowed: false };
  const fields = [...match[3].matchAll(/\[([^=\]]+)=([^\]]*)\]/g)].map(([, name, value]) => ({ name, value }));
  const stated = fields.find((field) => field.name === "key");
  const noteKey = !stated && match[4]?.match(/^\[key=([^\]]*)\]\s*/);
  const key = stated ? stated.value : noteKey ? noteKey[1] : "default";
  const validKey = /^[A-Za-z0-9._-]+$/.test(key);
  const declared = match[4] !== undefined || Boolean(stated);
  const text = noteKey && validKey ? match[4].slice(noteKey[0].length) : match[4] ?? line;
  const transitionAllowed = declared && validKey && (!key.startsWith("pending-reply-") || /^pending-reply-[^:]*:/.test(text));
  return { state: declared ? match[1].toLowerCase() : "update", text, fields, key: validKey ? key : null,
    phaseKey: validKey && (stated || noteKey) ? key : null, transitionAllowed };
}

export function decodeHoldReason(value) {
  if (!value?.startsWith("fm-hold-v1:")) return value;
  const payload = value.slice("fm-hold-v1:".length);
  const bytes = Buffer.from(payload, "base64");
  if (bytes.toString("base64") !== payload) return value;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return value; }
}

function currentLocalDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const TASK_TAIL_FIELDS = [
  /\s*(blocked-by|parent|discovered-from):\s*([A-Za-z0-9][A-Za-z0-9._-]*(?:,[A-Za-z0-9][A-Za-z0-9._-]*)*)(?:\s+-\s+((?:(?!\s+(?:blocked-by|parent|discovered-from):\s).)+?))?\s*$/i,
  /\s*\((?:[^()]*\+\s*)?(repo):\s*([^()]+)\)\s*$/i,
  /\s*\((kind|epic|theme|hold):\s*([^()]+)\)\s*$/i,
  /\s*\((hold-kind):\s*(captain|external|load|parked|future)\)\s*$/i,
  /\s*\((hold-until):\s*(\d{4}-\d{2}-\d{2})\)\s*$/i,
  /\s*\((priority):\s*([0-4])\)\s*$/i,
  /\s*\((since|done|reported|merged|closed)\s+(\d{4}-\d{2}-\d{2})\)\s*$/i,
];

export function parseBacklogTask(prose, closed, today = currentLocalDate()) {
  const fields = [];
  let title = prose;
  while (true) {
    const match = TASK_TAIL_FIELDS.map((pattern) => title.match(pattern)).find(Boolean);
    if (!match) break;
    fields.unshift({ name: match[1].toLowerCase(), value: match[2].trim() });
    title = title.slice(0, match.index);
  }
  const field = (name) => fields.findLast((entry) => entry.name === name)?.value || null;
  const group = fields.findLast((entry) => ["epic", "theme"].includes(entry.name));
  const doneDate = fields.findLast((entry) => ["done", "reported", "merged", "closed"].includes(entry.name))?.value || null;
  const holdReason = decodeHoldReason(field("hold"));
  const holdKind = field("hold-kind");
  const date = field("hold-until");
  const dateValue = Date.parse(`${date}T00:00:00Z`);
  const holdUntil = /^\d{4}-\d{2}-\d{2}$/.test(date || "") && Number.isFinite(dateValue) && new Date(dateValue).toISOString().slice(0, 10) === date ? date : null;
  const blockers = [...new Set(fields.filter((entry) => entry.name === "blocked-by").flatMap((entry) => entry.value.split(",")))];
  // Expired captain annotations still own an open call; a closed backlog row
  // keeps its historical fields without creating current captain pressure.
  return { title: title.trim(), repositoryPath: field("repo"), workGroup: group ? { kind: group.name, name: group.value } : null, doneDate,
    holdKind, holdReason, holdUntil, blockers, holdOpen: !closed,
    holdDeferred: !closed && Boolean(holdUntil && holdUntil > today),
    holdActive: !closed && Boolean(holdKind || holdReason) && (!holdUntil || holdUntil > today || holdKind === "captain") };
}

export function holdWaitingOn(hold) {
  if (!hold.holdOpen) return null;
  const notes = [];
  if (hold.holdDeferred) notes.push(`Deferred until ${hold.holdUntil}`);
  else if (hold.holdKind === "captain") notes.push("Captain");
  if (hold.holdActive && hold.holdReason) notes.push(hold.holdReason);
  if (hold.activeBlockers?.length) notes.push(`Dependency: ${hold.activeBlockers.join(", ")}`);
  return notes.join(" · ") || null;
}
