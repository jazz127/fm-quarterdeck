// Shared bounds for the v2 wire contract and structured inbox notes.
const keys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
const string = (value, max) => typeof value === "string" && value.length <= max;
export const validReviewRoute = (value) => string(value, 512) && /^#(?:lanes(?:\/[^\s#?]*)?|overview|work|expenses|quota|preferences|closed)$/.test(value);
export function validRecordId(value) {
  if (!string(value, 1000)) return false;
  const match = value.match(/^((?:main-pi-session|claude-main-session|state)\/[a-zA-Z0-9._/\-]+\.jsonl)(?::([1-9]\d*)|@(0|[1-9]\d*))(?::(0|[1-9]\d*))?(?::block:(0|[1-9]\d*))?$/);
  if (!match || match[1].split("/").some((part) => part === "." || part === "..")) return false;
  return ["state/branch-outcomes.jsonl", "state/terminal-outcomes.jsonl"].includes(match[1]) ? match[2] !== undefined && match[4] === undefined && match[5] === undefined : match[4] !== undefined;
}
const lanes = (value) => Array.isArray(value) && value.length > 0 && value.length <= 30 && value.every((lane) => string(lane, 160) && lane.length > 0);
function validRecord(record) {
  if (Object.hasOwn(record || {}, "recordId")) return keys(record, ["recordId"]) && validRecordId(record.recordId);
  return keys(record, ["source", "at", "lanes", "sha256"]) && string(record.source, 300) && record.source.length > 0 && !record.source.startsWith("/") && !record.source.split("/").includes("..") && string(record.at, 40) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(record.at) && Number.isFinite(Date.parse(record.at)) && lanes(record.lanes) && /^[0-9a-f]{16}$/.test(record.sha256 || "");
}
function validBoundary(value) {
  return keys(value, ["selector", "path", "offset"]) && string(value.selector, 512) && Array.isArray(value.path) && value.path.length <= 100 && value.path.every((n) => Number.isSafeInteger(n) && n >= 0) && Number.isSafeInteger(value.offset) && value.offset >= 0;
}
function validTarget(target) {
  if (target?.type === "text-range") return keys(target, ["type", "text", "selector", "commonAncestorSelector", "start", "end", "prefix", "suffix"]) && string(target.text, 240) && target.text.trim().length > 0 && string(target.selector, 512) && string(target.commonAncestorSelector, 512) && validBoundary(target.start) && validBoundary(target.end) && string(target.prefix, 32) && string(target.suffix, 32);
  if (target?.type === "table-cell") return keys(target, ["type", "selector", "rowLabel", "columnLabel", "text"]) && string(target.selector, 512) && string(target.rowLabel, 240) && string(target.columnLabel, 240) && string(target.text, 240);
  return false;
}
export function validV2Entry(entry) {
  return keys(entry, ["uid", "prompt", "selector", "tag", "text", "target", "record", "label", "route"]) && string(entry.prompt, 4000) && entry.prompt.trim().length > 0 && string(entry.selector, 512) && string(entry.text, 240) && string(entry.tag, 40) && /^(?:message|text|[a-z][a-z0-9-]*)$/.test(entry.tag) && (entry.uid === undefined || string(entry.uid, 100)) && (entry.route === undefined || validReviewRoute(entry.route)) && (entry.label === undefined || string(entry.label, 160)) && (entry.record === undefined || entry.tag !== "message" && validRecord(entry.record)) && (entry.target === undefined || validTarget(entry.target)) && (entry.tag !== "text" || entry.target?.type === "text-range") && (entry.tag !== "message" || entry.selector === "" && entry.text === "" && entry.target === undefined);
}
