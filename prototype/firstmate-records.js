// Firstmate's fm-classify-lib.sh owns status tags, key positions and correlation
// tokens; fm-hold-reason-lib.sh owns the reversible reason encoding.
export function parseStatusLine(line) {
  const match = line.match(/^\s*([a-z-]+)((?:\s+corr=[a-f0-9]{16})*)(\s*(?:\[[^\]]*\]\s*)*)(?::\s*(.*))?$/i);
  if (!match) return { state: "update", text: line, fields: [], key: null, transitionAllowed: false };
  const fields = [...match[3].matchAll(/\[([^=\]]+)=([^\]]*)\]/g)].map(([, name, value]) => ({ name, value }));
  const stated = fields.find((field) => field.name === "key");
  const noteKey = !stated && match[4]?.match(/^\[key=([^\]]*)\]\s*/);
  const key = stated ? stated.value : noteKey ? noteKey[1] : "default";
  const validKey = /^[A-Za-z0-9._-]+$/.test(key);
  const declared = match[4] !== undefined || Boolean(stated);
  const text = noteKey && validKey ? match[4].slice(noteKey[0].length) : match[4] ?? line;
  const transitionAllowed = declared && validKey && (!key.startsWith("pending-reply-") || /^pending-reply-[^:]*:/.test(text));
  return { state: declared ? match[1].toLowerCase() : "update", text, fields, key: validKey ? key : null, transitionAllowed };
}

export function decodeHoldReason(value) {
  if (!value?.startsWith("fm-hold-v1:")) return value;
  const payload = value.slice("fm-hold-v1:".length);
  const bytes = Buffer.from(payload, "base64");
  if (bytes.toString("base64") !== payload) return value;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return value; }
}

export function parseTaskHold(metadata, closed, today = new Date().toISOString().slice(0, 10)) {
  const field = (name) => metadata.match(new RegExp(`\\(${name}:\\s*([^)]*)\\)`, "i"))?.[1].trim() || null;
  const holdReason = decodeHoldReason(field("hold"));
  const holdKind = field("hold-kind");
  const date = field("hold-until");
  const dateValue = Date.parse(`${date}T00:00:00Z`);
  const holdUntil = /^\d{4}-\d{2}-\d{2}$/.test(date || "") && Number.isFinite(dateValue) && new Date(dateValue).toISOString().slice(0, 10) === date ? date : null;
  const blockers = [...new Set((metadata.match(/\bblocked-by:\s*([^\s(]+)/i)?.[1] || "").split(",").filter((id) => /^[A-Za-z0-9._-]+$/.test(id)))];
  // Expired captain annotations still own an open call; a closed backlog row
  // keeps its historical fields without creating current captain pressure.
  return { holdKind, holdReason, holdUntil, blockers, holdOpen: !closed,
    holdDeferred: !closed && Boolean(holdUntil && holdUntil > today),
    holdActive: !closed && Boolean(holdKind || holdReason) && (!holdUntil || holdUntil > today || holdKind === "captain") };
}

export function holdWaitingOn(hold) {
  if (!hold.holdOpen) return null;
  const notes = [];
  if (hold.holdDeferred) notes.push(`Deferred until ${hold.holdUntil}`);
  else if (hold.holdKind === "captain") notes.push("Captain");
  if (hold.holdActive && hold.holdReason) notes.push(hold.holdReason);
  if (hold.blockers.length) notes.push(`Dependency: ${hold.blockers.join(", ")}`);
  return notes.join(" · ") || null;
}
