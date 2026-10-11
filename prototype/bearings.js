import { parseBacklogTask } from "./firstmate-records.js";
import { enumeratedLetterOptions, publishOptions } from "./enumerated-options.js";
import { projectUnderwayRecords } from "./underway-records.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, watch as fsWatch } from "node:fs";
import { access, lstat, open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Live Overview bearings sections. Contract: BEARINGS.md. Quarterdeck runs only
// Firstmate's own bounded bearings projection. A bounded read of the selected home's
// backlog adds durable clocks plus existing main-home titles, hold reasons and, when the
// snapshot has no repository, the backlog repo name. The same read supplements `(main)`
// landed rows with a repository, a landed date, and the checked item title. A bounded read of that home's
// bearings board can supply decision options. Neither read creates calls or writes under FM_HOME.
export const MODEL_SCHEMA = "fm-quarterdeck-call.v1";
const SOURCE_SCHEMA = "fm-bearings.v1";
const MIN_GAP_FLOOR_MS = 15000;
const MAX_AGE_FLOOR_MS = 60000;

export class BearingsUnavailable extends Error {}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const TOKEN = /^[A-Za-z0-9()][A-Za-z0-9 ()._:-]{0,79}$/;
const token = (value) => typeof value === "string" && TOKEN.test(value) ? value : null;
const isoDate = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

// Free text from Firstmate records stays readable, but absolute filesystem paths are
// reduced to their final segment so no home or checkout location is ever served.
export function publicText(value, max = 400) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/(^|[\s("'`=,])(?:~\/|\/)(?:[^\s/"'`)]+\/)+([^\s/"'`)]*)/g, (_, lead, last) => `${lead}…/${last}`)
    .replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
const repoName = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  return token(path.basename(value.trim().replace(/\.git$/, "").replace(/[\\/]+$/, "")));
};
const httpsUrl = (value) => {
  if (typeof value !== "string" || value.length > 400) return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
};
// Landed links stay whole. The decision cap is 400; a pull-request link can be longer and is still one https URL with no userinfo.
const landedHttps = (value) => {
  if (typeof value !== "string" || value.length > 2000) return null;
  try { const url = new URL(value.trim()); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
};
const httpsCandidates = (text) => {
  if (typeof text !== "string") return [];
  const found = [];
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
    const url = landedHttps(match[0].replace(/[),.;]+$/g, ""));
    if (url && !found.includes(url)) found.push(url);
  }
  return found;
};
// The snapshot cuts a long landing link with "…" or "...". Only a backlog URL that continues that prefix may replace it.
function recoverArtifactUrl(artifact, urls) {
  if (typeof artifact !== "string" || !/(?:…|\.{3,})\s*$/.test(artifact.trim())) return null;
  const cut = artifact.trim().replace(/(?:…|\.{3,})\s*$/, "").trim();
  if (!cut.startsWith("https://")) return null;
  let best = null;
  for (const url of Array.isArray(urls) ? urls : []) {
    if (typeof url === "string" && url.startsWith(cut) && url.length > artifact.trim().length && (!best || url.length > best.length)) best = url;
  }
  return landedHttps(best);
}
// Colon metadata uses the work-view field split. A space-separated
// (since|done|reported|merged YYYY-MM-DD) date is not part of the title.
function ledgerItemTitle(fields) {
  return fields
    .replace(/\s+\((?:since|done|reported|merged)\s+\d{4}-\d\d-\d\d\)/gi, "")
    .split(/\s+\((?:repo|epic|theme|kind|since|done|merged|hold|hold-kind):/i)[0]
    .trim();
}

export function shortHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
const withRev = (card) => ({ ...card, rev: shortHash(card) });
const durableDate = (value) => isoDate(value) || (typeof value === "string" && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null);
export function decisionClock(row) {
  const candidates = [["Updated", row.updated_at], ["Hold set", row.hold_set_at], ["Created", row.created]]
    .map(([label, value]) => ({ label, at: durableDate(value) })).filter((entry) => entry.at);
  return candidates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] || { label: "Created / updated", at: null };
}

// Read only the selected home's ledger, never another owner's endpoint namespace.
// Missing/oversized ledgers and missing fields leave clocks unknown; file mtimes are not task times.
export function backlogClocks(text) {
  const clocks = new Map();
  let current = null, firstBody = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) { current = null; continue; }
    const item = line.match(/^\s*-\s+\[[ xX]\]\s+(\S+)\s+-\s+(.+)$/);
    if (item) {
      current = TASK_ID.test(item[1]) ? item[1] : null;
      firstBody = true;
      if (current) clocks.set(current, { created: item[2].match(/\(since (\d{4}-\d\d-\d\d)\)/)?.[1] });
    } else if (current && /^\s{2,}\S/.test(line) && firstBody) {
      firstBody = false;
      const stamp = line.trim().match(/^Captain hold set: (\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\dZ)?)$/)?.[1];
      if (stamp) clocks.get(current).hold_set_at = stamp;
    }
  }
  return clocks;
}
// Legacy snapshots shorten summary and omit reason. Decode only the versioned captain
// hold field on unchecked items, never body prose or another home's records. Duplicate
// ids and malformed/noncanonical UTF-8/base64 fail closed.
export function backlogHoldReasons(text) {
  const reasons = new Map(), seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+\[ \]\s+(\S+)\s+-\s+(.+)$/);
    if (!item || !TASK_ID.test(item[1])) continue;
    const [, id, fields] = item;
    if (seen.has(id)) { reasons.delete(id); continue; }
    seen.add(id);
    if (!fields.includes("(hold-kind: captain)")) continue;
    const encoded = fields.match(/\(hold: fm-hold-v1:([A-Za-z0-9+/=]{1,22000})\)/)?.[1];
    if (!encoded) continue;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || bytes.length > 16 * 1024) continue;
    try {
      const reason = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (reason.trim()) reasons.set(id, reason);
    } catch {}
  }
  return reasons;
}
// Unchecked item titles. Colon metadata uses the work-view field split. A
// space-separated (since|done|reported|merged YYYY-MM-DD) date is the same ledger
// form the clock reader already accepts, so it is not part of the title. Duplicates
// fail closed. Body prose is never a title.
export function backlogTitles(text) {
  const titles = new Map(), seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+\[ \]\s+(\S+)\s+-\s+(.+)$/);
    if (!item || !TASK_ID.test(item[1])) continue;
    const [, id, fields] = item;
    if (seen.has(id)) { titles.delete(id); continue; }
    seen.add(id);
    const title = ledgerItemTitle(fields);
    if (title) titles.set(id, title);
  }
  return titles;
}
// Repository names from the same unchecked item line. A path is only its final segment.
// Duplicate ids fail closed, matching titles. Body prose is never a repository.
export function backlogRepos(text) {
  const repos = new Map(), seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+\[ \]\s+(\S+)\s+-\s+(.+)$/);
    if (!item || !TASK_ID.test(item[1])) continue;
    const [, id, fields] = item;
    if (seen.has(id)) { repos.delete(id); continue; }
    seen.add(id);
    const name = repoName(fields.match(/\(repo:\s*([^)]+)\)/i)?.[1] || "");
    if (name) repos.set(id, name);
  }
  return repos;
}
// Checked items only. Duplicate ids fail closed. The newest done, merged or reported
// date is the landing clock; a path repository is only its final segment. The title
// uses the same split as unchecked decision titles. https URLs on that line can
// continue a snapshot artifact the bearings snapshot cut short.
export function backlogLandedEvidence(text) {
  const evidence = new Map(), seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+\[[xX]\]\s+(\S+)\s+-\s+(.+)$/);
    if (!item || !TASK_ID.test(item[1])) continue;
    const [, id, fields] = item;
    if (seen.has(id)) { evidence.delete(id); continue; }
    seen.add(id);
    const repo = repoName(fields.match(/\(repo:\s*([^)]+)\)/i)?.[1] || "");
    const dates = [...fields.matchAll(/\((?:done|merged|reported)\s+(\d{4}-\d\d-\d\d)\)/gi)]
      .map((match) => durableDate(match[1])).filter(Boolean).sort();
    const landedAt = dates.at(-1) || null;
    const title = ledgerItemTitle(fields);
    const backlogUrls = httpsCandidates(fields);
    if (repo || landedAt || title || backlogUrls.length) evidence.set(id, {
      ...(repo ? { backlogRepo: repo } : {}),
      ...(landedAt ? { landedAt } : {}),
      ...(title ? { backlogTitle: title } : {}),
      ...(backlogUrls.length ? { backlogUrls } : {}),
    });
  }
  return evidence;
}
// Durable lifecycle blocks are scoped to their ledger item, not arbitrary prose.
// Duplicate ids invalidate evidence, including checked/unchecked duplicates.
export function backlogHoldRecords(text) {
  const records = new Map(), seen = new Set();
  const allItems = text.replace(/^(\s*-\s+)\[[xX]\]/gm, "$1[ ]");
  const reasons = backlogHoldReasons(allItems), titles = backlogTitles(allItems);
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const item = /^\s*-\s+\[([ xX])\]\s+(\S+)\s+-\s+(.+)$/.exec(line);
    if (item) {
      const [, checked, id, fields] = item;
      current = null;
      if (!TASK_ID.test(id)) continue;
      if (seen.has(id)) { records.delete(id); continue; }
      seen.add(id);
      const parsed = parseBacklogTask(fields, checked !== " ");
      const captain = parsed.holdKind === "captain";
      current = { task: id, type: "decision", title: titles.get(id), reason: reasons.get(id),
        open: captain && parsed.holdActive,
        closed: checked !== " ", captain, source: "data/backlog.md", resolution: checked !== " " ? "closed" : null };
      records.set(id, current);
    } else if (/^##\s/.test(line) || (line.trim() && !/^\s{2,}/.test(line))) current = null;
    else if (current && /^  Resolution recorded by fm-captain-hold\.$/.test(line)) current.recorded = true;
    else if (current?.recorded) {
      const mode = /^  Resolution mode: (released|done|answered|closed)$/.exec(line)?.[1];
      // A still-open captain hold may have historical resolution prose from an older cycle.
      if (mode && !current.open) { current.closed = true; current.resolution = mode; }
    }
  }
  return [...records.values()].filter(row => row.open || (row.closed && (row.captain || row.recorded))).map(({ recorded, captain, ...row }) => row);
}

export async function readBacklogHoldRecords(home) {
  const file = await open(path.join(home, "data", "backlog.md"), "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("Backlog exceeds bounded regular-file contract");
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) throw new Error("Backlog exceeds read bound");
    return backlogHoldRecords(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } finally { await file.close(); }
}

// Supplements only projected main-home gates, using the shared trailing-field parser.
export function backlogWorkRepos(text) {
  const repos = new Map(), seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const item = /^\s*-\s+\[([ xX])\]\s+(\S+)\s+-\s+(.+)$/.exec(line);
    if (!item || !TASK_ID.test(item[2])) continue;
    const [, checked, id, prose] = item;
    if (seen.has(id)) { repos.delete(id); continue; }
    seen.add(id);
    if (checked === " ") {
      const repo = repoName(parseBacklogTask(prose, false).repositoryPath);
      if (repo) repos.set(id, repo);
    }
  }
  return repos;
}

async function addBacklogEvidence(output, home) {
  let file;
  try {
    file = await open(path.join(home, "data", "backlog.md"), "r");
    const info = await file.stat();
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return output;
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) return output;
    const raw = JSON.parse(output);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const clocks = backlogClocks(text), reasons = backlogHoldReasons(text), titles = backlogTitles(text), repos = backlogRepos(text);
    raw.quarterdeck_holds = backlogHoldRecords(text);
    const workRepos = backlogWorkRepos(text);
    if (Array.isArray(raw.gates)) raw.gates = raw.gates.map(row =>
      object(row) && row.owner === "(main)" && !repoName(row.repo) && workRepos.has(row.id)
        ? { ...row, repo: workRepos.get(row.id) } : row);
    if (Array.isArray(raw.decisions_open)) raw.decisions_open = raw.decisions_open.map((row) =>
      object(row) && row.owner === "(main)" ? {
        ...clocks.get(row.id), ...row,
        ...(typeof row.reason !== "string" && reasons.has(row.id) ? { reason: reasons.get(row.id) } : {}),
        ...(titles.has(row.id) ? { backlogTitle: titles.get(row.id) } : {}),
        ...(reasons.has(row.id) ? { backlogReason: reasons.get(row.id) } : {}),
        ...((typeof row.repo !== "string" || !row.repo.trim()) && repos.has(row.id) ? { repo: repos.get(row.id) } : {}),
      } : row);
    const landedEvidence = backlogLandedEvidence(text);
    if (Array.isArray(raw.landed)) raw.landed = raw.landed.map((row) => {
      if (!object(row) || row.owner !== "(main)" || !landedEvidence.has(row.id)) return row;
      const evidence = landedEvidence.get(row.id);
      const rest = { ...row };
      delete rest.backlogTitle;
      delete rest.backlogUrls;
      return {
        ...rest,
        ...(evidence.backlogRepo ? { backlogRepo: evidence.backlogRepo } : {}),
        ...(evidence.landedAt ? { backlogLandedAt: evidence.landedAt } : {}),
        ...(evidence.backlogTitle ? { backlogTitle: evidence.backlogTitle } : {}),
        ...(evidence.backlogUrls ? { backlogUrls: evidence.backlogUrls } : {}),
      };
    });
    return JSON.stringify(raw);
  } catch { return output; } finally { await file?.close(); }
}

// Fail closed: only a recognised projection whose consumed fields have the expected
// shape may replace the last good model.
export function validateSnapshot(raw) {
  if (!object(raw)) throw new BearingsUnavailable("Bearings output is not an object");
  if (raw.schema !== SOURCE_SCHEMA) throw new BearingsUnavailable("Unsupported bearings schema");
  for (const name of ["in_flight", "gates"]) if (Object.hasOwn(raw, name) && !Array.isArray(raw[name])) throw new BearingsUnavailable(`Bearings ${name} invalid`);
  if (!Array.isArray(raw.decisions_open)) throw new BearingsUnavailable("Bearings decisions missing");
  if (!Array.isArray(raw.omitted)) throw new BearingsUnavailable("Bearings disclosure missing");
  const c = raw.contributions;
  if (!object(c) || !Array.isArray(c.captain) || count(c.known) === null || count(c.checked) === null || typeof c.proven_clear !== "boolean") {
    throw new BearingsUnavailable("Bearings contribution coverage missing");
  }
  return raw;
}

// How a card may be answered from Quarterdeck (BEARINGS.md "Answers"). The question is
// the same key the /bearings board sends to Firstmate's keyed-answer intake: the task id
// for a decision, merge.<task> for a merge ask. Structured options, a recommendation and
// a close mode appear only when Firstmate's row supplies them. A decision with no options
// array can still offer explicit lettered lines from its recorded text. Otherwise the
// answer is freeform. No other option is composed here except the board's own "Merge now".
export const ANSWER_SLUG = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_OPTIONS = 8;
function sourceOptions(row) {
  if (!Array.isArray(row.options) || !row.options.length || row.options.length > MAX_OPTIONS) return [];
  const options = [];
  for (const entry of row.options) {
    const value = object(entry) && typeof entry.value === "string" && ANSWER_SLUG.test(entry.value) ? entry.value : null;
    const label = object(entry) ? publicText(entry.label, 120) : null;
    // reconcile is never an answer (captain-hold-lifecycle); one bad option voids them all.
    if (!value || !label || value === "reconcile" || options.some((option) => option.value === value)) return [];
    options.push({ value, label, hint: publicText(entry.hint, 240) });
  }
  return options;
}
// Recorded text only. A present options array, even an invalid one, does not fall through.
function proseLetterOptions(row) {
  if (Array.isArray(row.options) && row.options.length) return [];
  const fields = ["backlogReason", "reason", "summary", "title", "backlogTitle"];
  let best = [];
  let bestRank = fields.length;
  for (const [rank, field] of fields.entries()) {
    if (typeof row[field] !== "string") continue;
    const options = publishOptions(enumeratedLetterOptions(row[field]), publicText);
    if (!options.length) continue;
    if (options.length > best.length || (options.length === best.length && rank < bestRank)) {
      best = options;
      bestRank = rank;
    }
  }
  return best;
}
function decisionAnswer(row, task) {
  if (!ANSWER_SLUG.test(task)) return null;
  const structured = sourceOptions(row);
  const options = structured.length ? structured : proseLetterOptions(row);
  const recommend = options.some((option) => option.value === row.recommend_value) ? row.recommend_value : null;
  const close = row.close === "done" || row.close === "release" ? row.close : null;
  return { question: task, options, recommend, close, freeform: true, allow_freeform: row.board_allow_freeform === true, freeform_hint: publicText(row.board_freeform_hint, 240) };
}
function mergeAnswer(task) {
  const question = `merge.${task}`;
  if (!ANSWER_SLUG.test(question)) return null;
  return { question, options: [{ value: "merge", label: "Merge now", hint: "Firstmate re-checks that the pull request is open and green before merging." }], recommend: null, close: null, freeform: true };
}

// The selected home's lavish board (BEARINGS.md "Answers"). Text only: the page is never
// executed. The builder escapes every "<" so the JSON block cannot close early.
export const BOARD_SCHEMA = "fm-bearings-board.v1";
const BOARD_MAX_BYTES = 1024 * 1024;
const BOARD_OPEN = '<script id="bearings-data" type="application/json">';
const boardInstant = (value) => {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};
export function extractBoardPayload(html) {
  if (typeof html !== "string") return null;
  const open = html.indexOf(BOARD_OPEN);
  if (open < 0) return null;
  const start = open + BOARD_OPEN.length;
  const end = html.indexOf("</script>", start);
  if (end < 0) return null;
  const raw = html.slice(start, end).trim();
  if (!raw || raw.includes("<")) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export function validBoardPayload(raw) {
  if (!object(raw) || raw.schema !== BOARD_SCHEMA) return null;
  if (typeof raw.home !== "string" || !raw.home.trim() || raw.home.length > 4096) return null;
  if (boardInstant(raw.generated) === null) return null;
  if (!Array.isArray(raw.captains_call)) return null;
  return raw;
}
// Stale when the board was generated before the hold's latest durable update.
// A date-only hold time is UTC midnight. No durable update is not stale.
export function boardBeforeHold(generated, row) {
  const boardMs = boardInstant(generated);
  if (boardMs === null) return true;
  const at = decisionClock(row).at;
  if (!at) return false;
  const holdMs = Date.parse(at);
  return !Number.isFinite(holdMs) || boardMs < holdMs;
}
function boardCardForDecision(board, taskId) {
  let credential = null;
  for (const item of board.captains_call) {
    if (!object(item) || item.key !== taskId || item.type === "merge") continue;
    if (item.type === "decision") return item;
    if (item.type === "credential" && !credential) credential = item;
  }
  return credential;
}
function optionsFromBoardCard(item) {
  if (!Array.isArray(item.options)) return null;
  const withoutReserved = item.options.filter((entry) => !(object(entry) && entry.value === "reconcile"));
  if (!withoutReserved.length) return null;
  const options = sourceOptions({ options: withoutReserved });
  if (!options.length) return null;
  const recommend = options.some((option) => option.value === item.recommend_value) ? item.recommend_value : null;
  return { options, recommend };
}
// Fresh matching decision options replace the row's options and recommend_value.
// close stays on the snapshot row. Absent, stale, merge-only and invalid sets leave the row unchanged.
export function applyBoardDecisionOptions(raw, board) {
  const payload = validBoardPayload(board);
  if (!payload || !object(raw) || !Array.isArray(raw.decisions_open)) return raw;
  for (const row of raw.decisions_open) {
    if (!object(row) || typeof row.id !== "string") continue;
    const item = boardCardForDecision(payload, row.id);
    if (!item || boardBeforeHold(payload.generated, row)) continue;
    
    // Always transfer board fields
    row.board_title = item.title;
    row.board_about = item.about;
    row.board_decide = item.decide;
    row.board_detail = item.detail;
    row.board_pr_url = item.pr_url;
    row.board_freeform_hint = item.freeform_hint;
    row.board_allow_freeform = item.allow_freeform;
    row.board_close = item.close;

    const picked = optionsFromBoardCard(item);
    if (picked) {
      row.options = picked.options;
      row.recommend_value = picked.recommend;
    }
  }
  return raw;
}
export async function readBearingsBoard(home, { lstatImpl = lstat, openImpl = open } = {}) {
  if (typeof home !== "string" || !path.isAbsolute(home)) return null;
  const filePath = path.join(home, ".lavish", "bearings-board.html");
  let file;
  try {
    const info = await lstatImpl(filePath);
    if (!info.isFile() || info.size < 1 || info.size > BOARD_MAX_BYTES) return null;
    file = await openImpl(filePath, "r");
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size || bytesRead > BOARD_MAX_BYTES) return null;
    const html = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    return validBoardPayload(extractBoardPayload(html));
  } catch { return null; } finally { await file?.close(); }
}
async function addBoardEvidence(output, home) {
  try {
    const board = await readBearingsBoard(home);
    if (!board) return output;
    const raw = JSON.parse(output);
    applyBoardDecisionOptions(raw, board);
    return JSON.stringify(raw);
  } catch { return output; }
}

// Every section uses the same authoritative snapshot and live transport.
function callSection(raw) {
  const repos = new Map();
  for (const row of Array.isArray(raw.in_flight) ? raw.in_flight : []) {
    if (object(row) && typeof row.id === "string" && TASK_ID.test(row.id) && !repos.has(row.id)) repos.set(row.id, repoName(row.repo));
  }
  let invalid = 0;
  const cards = [];
  const decided = new Set();
  for (const row of raw.decisions_open) {
    const id = object(row) && typeof row.id === "string" && TASK_ID.test(row.id) ? row.id : null;
    // Keep the complete ask: choices and recommendations may exist only in this text.
    const summary = id && publicText(row.summary, Infinity);
    if (!id || !summary || decided.has(id)) { invalid += 1; continue; }
    decided.add(id);
    const contribution = raw.contributions.captain.find((entry) => object(entry) && entry.task === id && httpsUrl(entry.url));
    // Optional source title/reason retain quoted replies for chat-ask deduplication.
    const title = publicText(row.title, Infinity), reason = publicText(row.reason, Infinity);
    const backlogTitle = publicText(row.backlogTitle, Infinity), backlogReason = publicText(row.backlogReason, Infinity);
    cards.push(withRev({ key: `decision:${id}`, type: "decision", task: id, verb: token(row.verb), summary, ...(title ? { title } : {}), ...(reason ? { reason } : {}), ...(backlogTitle ? { backlogTitle } : {}), ...(backlogReason ? { backlogReason } : {}), url: httpsUrl(contribution?.url), owner: token(row.owner), repo: repos.get(id) || repoName(row.repo) || null, clock: decisionClock(row), answer: decisionAnswer(row, id),
      boardTitle: row.board_title || null,
      boardAbout: row.board_about || null,
      boardDecide: row.board_decide || null,
      boardDetail: row.board_detail || null,
      boardPrUrl: row.board_pr_url || null,
      boardFreeformHint: row.board_freeform_hint || null,
      boardAllowFreeform: row.board_allow_freeform === true,
      boardClose: row.board_close || null
    }));
  }
  const merges = new Set();
  const mainHolds = new Set((Array.isArray(raw.quarterdeck_holds) ? raw.quarterdeck_holds : [])
    .filter(row => object(row) && row.source === "data/backlog.md" && row.open === true && TASK_ID.test(row.task))
    .map(row => row.task));
  for (const row of raw.contributions.captain) {
    const task = object(row) && typeof row.task === "string" && TASK_ID.test(row.task) ? row.task : null;
    if (!task) { invalid += 1; continue; }
    // A live decision for the same task already asks the captain; one card per call.
    if (decided.has(task) || merges.has(task)) continue;
    // Captain actor includes arbitration holds, even for a draft PR. Those are
    // decisions, never Merge asks when a decision falls outside the snapshot bound.
    // The selected-home ledger also covers deferred holds absent from captain.hold;
    // its task ids apply only to that home's contribution owner.
    if ((typeof row.hold === "string" && row.hold.trim()) || (row.owner === "(main)" && mainHolds.has(task))) continue;
    merges.add(task);
    cards.push(withRev({ key: `merge:${task}`, type: "merge", task, kind: token(row.kind), url: httpsUrl(row.url), reason: publicText(row.reason, Infinity), owner: token(row.owner), repo: repos.get(task) ?? null, checkedAt: isoDate(row.checked_at), clock: { label: "Checked", at: isoDate(row.checked_at) }, answer: mergeAnswer(task) }));
  }
  const c = raw.contributions;
  const coverage = { known: c.known, checked: c.checked, complete: c.complete === true, provenClear: c.proven_clear,
    captainOmitted: count(c.captain_omitted) ?? 0, unmeasuredHomes: count(c.unmeasured_homes) ?? 0 };
  const omitted = [];
  for (const entry of raw.omitted) {
    const surface = object(entry) && typeof entry.surface === "string" ? entry.surface : "";
    let match;
    if ((match = /^captain holds bucketed blocked, dated, or aged: (\d+)$/.exec(surface))) omitted.push({ kind: "deferred-holds", count: Number(match[1]) });
    else if ((match = /^decisions_open showing (\d+) of (\d+)$/.exec(surface))) omitted.push({ kind: "decisions-bound", shown: Number(match[1]), total: Number(match[2]) });
  }
  if (invalid) omitted.push({ kind: "invalid-rows", count: invalid });
  return { cards, coverage, omitted };
}
const newerAt = (left, right) => !left ? right || null : !right ? left : Date.parse(left) >= Date.parse(right) ? left : right;
const textShortened = (value) => typeof value === "string" && /(?:…|\.{3,})\s*$/.test(value.trim());
function landedArtifact(value) {
  if (typeof value !== "string") return { url: null, artifact: null };
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return { url: null, artifact: null };
  // A trailing ellipsis is the snapshot's cut, not part of a finished link.
  if (!textShortened(trimmed)) {
    const url = landedHttps(trimmed);
    if (url) return { url, artifact: null };
  }
  if (trimmed === "local main") return { url: null, artifact: "local main" };
  return { url: null, artifact: publicText(trimmed) };
}
// Snapshot landed rows only. Invalid rows are counted, never a failed snapshot.
// Another home's ledger is never read, so its repository and time stay unknown.
function landedSection(raw) {
  if (!Array.isArray(raw.landed)) return { landed: [], landedInvalid: 0 };
  let landedInvalid = 0;
  const seen = new Set();
  const landed = [];
  for (const row of raw.landed) {
    const id = object(row) && typeof row.id === "string" && TASK_ID.test(row.id) ? row.id : null;
    const what = id ? publicText(row.what, Infinity) : null;
    if (!id || !what || seen.has(id)) { landedInvalid += 1; continue; }
    seen.add(id);
    const owner = token(row.owner);
    let { url, artifact } = landedArtifact(row.artifact);
    const backlogTitle = owner === "(main)" ? publicText(row.backlogTitle, Infinity) : null;
    if (!url && owner === "(main)") {
      const recovered = recoverArtifactUrl(typeof row.artifact === "string" ? row.artifact : "", row.backlogUrls);
      if (recovered) { url = recovered; artifact = null; }
    }
    const repo = repoName(row.repo) || (owner === "(main)" ? repoName(row.backlogRepo) : null);
    const at = owner === "(main)" ? newerAt(durableDate(row.landedAt), durableDate(row.backlogLandedAt)) : null;
    landed.push(withRev({ key: `landed:${id}`, type: "landed", task: id, what, ...(backlogTitle ? { backlogTitle } : {}), repo, owner, url, artifact, clock: { label: "Landed", at } }));
  }
  return { landed, landedInvalid };
}
// Preserve the snapshot's bucket membership and run state; no status/hold inference.
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const WARNING_IDS = new Set(["(main-inventory)", "(return-catchup)"]);
function workSection(raw, source, section) {
  const rows = [], seen = new Set();
  let invalid = 0;
  for (const row of Array.isArray(raw[source]) ? raw[source] : []) {
    const id = object(row) && typeof row.id === "string" && row.id.length <= 321
      && (WORK_ID.test(row.id) || (section === "charted" && WARNING_IDS.has(row.id))) ? row.id : null;
    const title = id ? publicText(section === "underway" ? row.name : row.title, Infinity) : null;
    const owner = token(row?.owner) || (section === "underway" ? token(id?.split("/").length === 2 ? id.split("/")[0] : "(main)") : null);
    const identity = `${owner || ""}:${id}`;
    if (!id || !title || seen.has(identity)) { invalid += 1; continue; }
    seen.add(identity);
    const warning = section === "charted" && (row.kind === "warning" || WARNING_IDS.has(id));
    rows.push(withRev({ key: `${section}:${owner || ""}:${id}`, type: section, task: id, title,
      repo: repoName(row.repo), owner,
      ...(section === "underway" ? { home: owner === "(main)" ? "Main home" : owner,
        stage: publicText(row.quarterdeckStage, Infinity) || "Stage unavailable" } : {}),
      kind: warning ? "warning" : section === "charted" ? "queued" : token(row.kind),
      state: section === "underway" ? token(row.state) : null,
      doing: section === "underway" ? publicText(row.doing, Infinity) : null,
      reason: section === "charted" ? publicText(row.reason, Infinity) : null,
      blockedBy: section === "charted" && row.blocked_by !== "-" ? publicText(row.blocked_by, Infinity) : null,
      clock: { label: "Filed", at: section === "charted" ? durableDate(row.filed) : null },
    }));
  }
  // Keep the producer's reserved catch-up warning first and stable unknown-date ties.
  if (section === "charted") rows.sort((a, b) => a.task === "(return-catchup)" ? -1 : b.task === "(return-catchup)" ? 1
    : (b.clock.at ? Date.parse(b.clock.at) : -Infinity) - (a.clock.at ? Date.parse(a.clock.at) : -Infinity));
  return { [section]: rows, ...(invalid ? { workOmitted: [{ kind: `invalid-${section}`, count: invalid }] } : {}) };
}
export const SECTIONS = { call: callSection, landed: landedSection,
  underway: raw => workSection(raw, "in_flight", "underway"), charted: raw => workSection(raw, "gates", "charted") };

export function normalizeSnapshot(raw, enabled = ["call", "landed", "underway", "charted"]) {
  validateSnapshot(raw);
  const content = { cards: [], coverage: null, omitted: [], landed: [], underway: [], charted: [],
    workCoverage: { underway: Array.isArray(raw.in_flight), charted: Array.isArray(raw.gates),
      disclosures: raw.omitted.filter(row => object(row) && typeof row.surface === "string" && /in_flight|gates|inventory|current|registry|secondmate/.test(row.surface))
        .map(row => publicText(row.surface, Infinity)).filter(Boolean) } };
  if (Array.isArray(raw.quarterdeckWorkDisclosures)) content.workCoverage.underwayDisclosures = raw.quarterdeckWorkDisclosures.map(value => publicText(value, Infinity)).filter(Boolean);
  let landedInvalid = 0;
  for (const name of enabled) {
    const section = SECTIONS[name]?.(raw);
    if (!section) continue;
    if (name === "landed") {
      content.landed = section.landed || [];
      landedInvalid = section.landedInvalid || 0;
      continue;
    }
    if (name === "underway" || name === "charted") {
      content[name] = section[name];
      content.omitted.push(...(section.workOmitted || []));
    } else Object.assign(content, section);
  }
  if (landedInvalid) content.omitted = [...(content.omitted || []), { kind: "invalid-landed", count: landedInvalid }];
  const holds = Array.isArray(raw.quarterdeck_holds) ? raw.quarterdeck_holds.filter(row => object(row) && TASK_ID.test(row.task) && row.source === "data/backlog.md")
    .map(row => ({ ...row, reason: publicText(row.reason, Infinity), title: publicText(row.title, Infinity) })) : [];
  return { ...content, holds, generatedAt: isoDate(raw.generated) };
}
// The revision covers only what the captain sees, never the snapshot clock, so an
// unchanged Captain's Call is never pushed again. Empty landed rows stay out of the hash.
export const contentRevision = ({ cards, coverage, omitted, holds, landed, underway, charted, workCoverage }) => shortHash({ cards, coverage, omitted, ...(workCoverage ? { workCoverage } : {}), ...(underway?.length ? { underway } : {}), ...(charted?.length ? { charted } : {}), ...(holds?.length ? { holds } : {}), ...(landed?.length ? { landed } : {}) });

export function createSnapshotRunner(home, { spawnImpl = spawn, accessImpl = access, setPriority = os.setPriority, timeoutMs = 45000, maxStdout = 2 * 1024 * 1024, maxStderr = 4096 } = {}) {
  let pending = null;
  const once = async (script = "fm-bearings-snapshot.sh", args = ["--json", "--all-in-flight", "--all-secondmates"]) => {
    if (!home) throw new BearingsUnavailable("FM_HOME is not configured");
    if (!path.isAbsolute(home)) throw new BearingsUnavailable("FM_HOME must be absolute");
    const executable = path.join(home, "bin", script);
    try { await accessImpl(executable, constants.X_OK); } catch { throw new BearingsUnavailable("Firstmate bearings snapshot is not installed"); }
    return new Promise((resolve, reject) => {
      // Never --include-prs: the background loop makes no GitHub calls.
      const child = spawnImpl(executable, args, { env: { ...process.env, FM_HOME: home, FM_CREW_STATE_NO_FORGE: "1", FM_SNAPSHOT_SECONDMATES: "0" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      let stdout = "", stderr = "", failure = null, settled = false;
      const stop = (reason) => {
        failure ||= reason;
        try { process.platform !== "win32" && child.pid ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGKILL"); } catch { child.kill?.("SIGKILL"); }
      };
      const timer = setTimeout(() => stop("Bearings snapshot timed out"), timeoutMs);
      try { if (child.pid) setPriority(child.pid, 10); } catch {}
      child.stdout.setEncoding?.("utf8");
      child.stderr.setEncoding?.("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > maxStdout) stop("Bearings snapshot output too large"); });
      child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > maxStderr) stderr = stderr.slice(-maxStderr); });
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(stdout);
      };
      child.on("error", () => finish(new BearingsUnavailable("Bearings snapshot could not start")));
      child.on("close", (code) => {
        if (failure) finish(new BearingsUnavailable(failure));
        else if (code !== 0) finish(new BearingsUnavailable(`Bearings snapshot exited ${code}`));
        else finish(null);
      });
    });
  };
  const addWorkRecords = async output => {
    const raw = JSON.parse(output);
    try {
      // This stock reader owns registry selection and permitted home-ledger reads.
      // Its Underway observation stands alone; never join two task generations.
      const work = projectUnderwayRecords(JSON.parse(await once("fm-fleet-snapshot.sh", ["--json"])));
      raw.in_flight = work.rows.map(({ stage, ...row }) => ({ ...row, quarterdeckStage: stage }));
      raw.quarterdeckWorkDisclosures = work.disclosures;
    } catch {
      raw.quarterdeckWorkDisclosures = ["Canonical work records unavailable; current stages and registered-home inventory unverified"];
    }
    return JSON.stringify(raw);
  };
  return () => (pending ||= once().then(addWorkRecords).then((output) => addBacklogEvidence(output, home)).then((output) => addBoardEvidence(output, home)).finally(() => { pending = null; }));
}

// Reads mtimes and sizes only (never contents) of the two record kinds whose change
// can alter the Captain's Call: data/backlog.md (captain holds) and state/*.meta (PR records).
export function createRecordFingerprint(home) {
  return async () => {
    const parts = [];
    try { const s = await stat(path.join(home, "data", "backlog.md")); parts.push(`b:${s.mtimeMs}:${s.size}`); } catch { parts.push("b:-"); }
    try {
      const names = (await readdir(path.join(home, "state"))).filter((name) => name.endsWith(".meta")).sort();
      for (const name of names) {
        try { const s = await stat(path.join(home, "state", name)); parts.push(`${name}:${s.mtimeMs}:${s.size}`); } catch {}
      }
    } catch { parts.push("s:-"); }
    return shortHash(parts);
  };
}

const watchedName = (dir, name) => name == null || (dir === "data" ? name === "backlog.md" : String(name).endsWith(".meta"));
function defaultWatch(home, onChange) {
  const watchers = [];
  for (const dir of ["data", "state"]) {
    try {
      // Non-recursive: the snapshot's own cache writes live in a state/ subdirectory.
      const watcher = fsWatch(path.join(home, dir), (_, name) => { if (watchedName(dir, name)) onChange(dir); });
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {}
  }
  return () => { for (const watcher of watchers) watcher.close(); };
}

const boundedMs = (value, fallback, floor) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(floor, Math.round(parsed)) : fallback;
};

// The hub owns the cached model and decides when the snapshot runs: only while someone
// watches, on record changes (debounced), on a stat-fingerprint change, or at the age
// ceiling, never more often than the minimum gap, and never two at once.
export function createBearingsHub({ home, runner = createSnapshotRunner(home), fingerprint = home ? createRecordFingerprint(home) : null, watchRecords = home ? (onChange) => defaultWatch(home, onChange) : null,
  now = Date.now, timers = globalThis, minGapMs, maxAgeMs, debounceMs = 2000, tickMs = 10000, firstRunAfterMs = 60000, pollTtlMs = 60000 } = {}) {
  const gap = boundedMs(minGapMs, 30000, MIN_GAP_FLOOR_MS);
  const ceiling = Math.max(gap, boundedMs(maxAgeMs, 300000, MAX_AGE_FLOOR_MS));
  const empty = { cards: [], coverage: null, omitted: [], landed: [], underway: [], charted: [] };
  let model = { schema: MODEL_SCHEMA, rev: contentRevision(empty), state: "loading", observedAt: null, checkedAt: null, generatedAt: null, stale: false, error: null, ...empty };
  let lastGood = null;
  let lastAttemptAt = 0;
  let lastStartAt = -Infinity;
  let running = null;
  let rerun = false;
  let debounceTimer = null, gapTimer = null, tickTimer = null;
  let stopWatching = null;
  let lastPrint = null;
  let pollSeenAt = -Infinity;
  let closed = false;
  let runs = 0;
  const listeners = new Set();

  const watched = () => !closed && (listeners.size > 0 || now() - pollSeenAt < pollTtlMs);
  const freshness = () => ({ rev: model.rev, state: model.state, observedAt: model.observedAt, checkedAt: model.checkedAt, stale: model.stale, error: model.error });
  const emit = (event) => { for (const listener of [...listeners]) { try { listener(event); } catch {} } };

  function publish(next) {
    const changed = next.rev !== model.rev;
    model = next;
    emit(changed ? { type: "model", model } : { type: "observed", ...freshness() });
  }
  async function runOnce() {
    runs += 1;
    lastStartAt = now();
    lastAttemptAt = lastStartAt;
    try {
      const content = normalizeSnapshot(JSON.parse(await runner()));
      const at = new Date(now()).toISOString();
      lastGood = { schema: MODEL_SCHEMA, rev: contentRevision(content), state: "ready", observedAt: at, checkedAt: at, generatedAt: content.generatedAt, stale: false, error: null, cards: content.cards, coverage: content.coverage, omitted: content.omitted, holds: content.holds, landed: content.landed || [], underway: content.underway || [], charted: content.charted || [], workCoverage: content.workCoverage };
      publish(lastGood);
    } catch (error) {
      const reason = error instanceof BearingsUnavailable ? error.message : error instanceof SyntaxError ? "Bearings output is not JSON" : "Bearings snapshot failed";
      const at = new Date(now()).toISOString();
      // Keep the last good calls visible and marked stale; never blank them on a failed run.
      publish(lastGood ? { ...lastGood, state: "stale", stale: true, error: reason, checkedAt: at }
        : { schema: MODEL_SCHEMA, rev: contentRevision(empty), state: "unavailable", observedAt: null, checkedAt: at, generatedAt: null, stale: false, error: reason, ...empty });
    }
  }
  function schedule() {
    if (!watched()) return;
    if (running) { rerun = true; return; }
    const wait = lastStartAt + gap - now();
    if (wait > 0) {
      gapTimer ||= timers.setTimeout(() => { gapTimer = null; schedule(); }, wait);
      return;
    }
    running = runOnce().finally(() => {
      running = null;
      if (rerun) { rerun = false; schedule(); }
    });
  }
  function request() {
    if (!watched()) return;
    timers.clearTimeout(debounceTimer);
    debounceTimer = timers.setTimeout(() => { debounceTimer = null; schedule(); }, debounceMs);
  }
  async function tick() {
    if (!watched()) { deactivate(); return; }
    if (now() - lastAttemptAt >= ceiling) { schedule(); return; }
    if (!fingerprint) return;
    try {
      const print = await fingerprint();
      if (lastPrint !== null && print !== lastPrint) request();
      lastPrint = print;
    } catch {}
  }
  function activate() {
    if (tickTimer || closed) return;
    stopWatching = watchRecords ? watchRecords(() => request()) : null;
    tickTimer = timers.setInterval(() => { void tick(); }, tickMs);
    lastPrint = null;
    if (fingerprint) fingerprint().then((print) => { lastPrint ??= print; }, () => {});
    // The first watcher sees the cache immediately; refresh it only when it is old.
    if (now() - lastAttemptAt >= firstRunAfterMs) schedule();
  }
  function deactivate() {
    timers.clearInterval(tickTimer);
    timers.clearTimeout(debounceTimer);
    timers.clearTimeout(gapTimer);
    tickTimer = debounceTimer = gapTimer = null;
    stopWatching?.();
    stopWatching = null;
    rerun = false;
  }
  return {
    current: () => model,
    freshness,
    subscribe(listener) {
      listeners.add(listener);
      activate();
      return () => { listeners.delete(listener); if (!watched()) deactivate(); };
    },
    // A ?since or plain read counts as a watcher for pollTtlMs, so poll-only clients
    // (previews, stream fallback) keep the cadence alive without a stream.
    touch() { if (closed) return; pollSeenAt = now(); activate(); },
    request,
    stats: () => ({ runs, running: Boolean(running), subscribers: listeners.size, active: Boolean(tickTimer), minGapMs: gap, maxAgeMs: ceiling }),
    close() { closed = true; listeners.clear(); deactivate(); },
  };
}
