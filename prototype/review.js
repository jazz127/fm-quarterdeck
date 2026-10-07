import { createGitIdentity } from "./git-identity.js";
import { appendFile, mkdir, open, readFile, lstat, link, unlink, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const localReviewDir = path.join(root, "prototype", "data", "review-receipts");
export const reviewVersion = await createGitIdentity(root).snapshot() || "unknown";

export function reviewConfiguration(env) {
  const sessionId = env.FM_LAVISH_REVIEW_SESSION || "";
  let endpoint;
  try {
    endpoint = new URL(env.FM_LAVISH_REVIEW_URL);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.hash) endpoint = null;
  } catch { endpoint = null; }
  const lavish = Boolean(endpoint && sessionId);
  return { endpoint: lavish ? endpoint : null, sessionId: lavish ? sessionId : "", ready: true, delivery: lavish ? "lavish" : "local" };
}

// Keep review routing aligned with the actual navigable product views.
const validRoute = (route) => typeof route === "string" && /^#(?:lanes(?:\/[^\s#?]*)?|overview|work|expenses|quota|preferences|closed)$/.test(route);
const onlyKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));

export function validateReviewPayload(body, version, sessionId) {
  if (!onlyKeys(body, ["schema", "batchId", "sessionId", "version", "route", "end", "entries"]) || typeof version !== "string" ||
      body.schema !== "fm-agentos-review.v1" || !/^[0-9a-f-]{36}$/i.test(body.batchId || "") || body.version !== version || body.sessionId !== sessionId ||
      !validRoute(body.route) ||
      typeof body.end !== "boolean" || !Array.isArray(body.entries) || body.entries.length < 1 || body.entries.length > 30) return false;
  return body.entries.every((entry) => onlyKeys(entry, ["kind", "text", "route", "version", "region", "target"]) && ["annotation", "message", "lane-message-annotation"].includes(entry.kind) &&
    typeof entry.text === "string" && entry.text.trim().length > 0 && entry.text.length <= 4000 &&
    validRoute(entry.route) &&
    entry.version === version &&
    (entry.kind === "lane-message-annotation"
      ? entry.route.startsWith("#lanes") && entry.region === null && validMessageTarget(entry.target)
      : !Object.hasOwn(entry, "target") && (entry.kind === "message" ? entry.region === null :
        onlyKeys(entry.region, ["id", "label"]) && typeof entry.region.id === "string" && /^[a-zA-Z0-9:._/\-]{1,300}$/.test(entry.region.id) &&
        typeof entry.region.label === "string" && entry.region.label.length <= 300)));
}

// Compare only the public wire contract, never browser-supplied provenance.
// A retry across restarts/checkpoints recovers the original authoritative record.
export async function reconcileLocalReview(payload, directory = localReviewDir) {
  if (!validateReviewPayload(payload, payload?.version, "")) return null;
  let record;
  try { record = JSON.parse(await readFile(path.join(directory, `${payload.batchId}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const wire = ({ schema, batchId, sessionId, version, route, end, entries }) => ({ schema, batchId, sessionId, version, route, end, entries });
  if (record.receiptId !== `local:${payload.batchId}` || JSON.stringify(wire(record.payload)) !== JSON.stringify(wire(payload))) {
    throw new Error("Batch id already used for different review notes");
  }
  return record;
}

function validMessageTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return false;
  if (target.type === "record") {
    if (Object.keys(target).sort().join(",") !== "recordId,type" || typeof target.recordId !== "string" || target.recordId.length > 1000) return false;
    const id = target.recordId.match(/^((?:main-pi-session|state)\/[a-zA-Z0-9._/\-]+\.jsonl):([1-9]\d*)(?::(0|[1-9]\d*))?(?::block:(0|[1-9]\d*))?$/);
    if (!id || id[1].split("/").some((segment) => segment === "." || segment === "..")) return false;
    return id[1] === "state/branch-outcomes.jsonl" || id[1] === "state/terminal-outcomes.jsonl" ? id[3] === undefined && id[4] === undefined : id[3] !== undefined;
  }
  if (target.type === "quote") return Object.keys(target).sort().join(",") === "lanes,text,time,type" &&
    typeof target.time === "string" && target.time.length > 0 && target.time.length <= 120 &&
    typeof target.text === "string" && target.text.trim().length > 0 && target.text.length <= 120000 &&
    Array.isArray(target.lanes) && target.lanes.length > 0 && target.lanes.length <= 30 &&
    target.lanes.every((lane) => typeof lane === "string" && lane.length > 0 && lane.length <= 160);
  return false;
}

// Keep status lines bounded, single-line, and free of obvious credential material.
// The receipt remains the authoritative full-fidelity record.
function statusExcerpt(value, length) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (/\b(?:password|secret|api[_ -]?key|auth(?:orization)?|bearer|token|credential)\b/i.test(text) || /\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[psu]_[a-zA-Z0-9_]{12,})\b/.test(text)) return "[redacted: possible credential]";
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function reviewStatusLine(payload) {
  return JSON.stringify({ type: "agentos-review", batchId: payload.batchId, route: payload.route,
    notes: payload.entries.map((entry) => ({ text: statusExcerpt(entry.text, 64), region: statusExcerpt(entry.target?.type === "record" ? entry.target.recordId : entry.target ? "Lane Chat message (quoted in receipt)" : entry.region?.label || "(message)", 32) })),
  });
}

// The badge counts only local annotations with durable receipts but without
// authoritative supervisor intake. Reviewed acknowledgements are not intake.
export async function awaitingReviewCount(directory = localReviewDir, receipts = null) {
  let files;
  try { files = await readdir(directory); } catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  let count = 0;
  for (const name of files.filter((file) => /^[0-9a-f-]{36}\.json$/i.test(file))) {
    const batch = name.slice(0, -5);
    const receipt = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    if (receipt.receiptId !== `local:${batch}` || !Array.isArray(receipt.payload?.entries)) throw new Error("Invalid review receipt");
    const status = await localReviewStatus(batch, directory);
    const received = receipts && [...receipts.handled, ...receipts.replies].some((note) => note.request_id === `agentos-review:${batch}`);
    if (status.state === "accepted" && !received)
      count += receipt.payload.entries.filter((entry) => ["annotation", "lane-message-annotation"].includes(entry.kind)).length;
  }
  return count;
}

// A supervisor may atomically publish <batchId>.status.json beside a local receipt.
// No status is inferred from time, the notification append, or a reviewed-count ack.
export async function localReviewStatus(batchId, directory = localReviewDir) {
  if (!/^[0-9a-f-]{36}$/i.test(batchId || "")) return null;
  const receiptPath = path.join(directory, `${batchId}.json`);
  let receipt;
  try {
    if (!(await lstat(receiptPath)).isFile()) return null;
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (receipt.receiptId !== `local:${batchId}` || receipt.payload?.batchId !== batchId) throw new Error("Invalid review receipt");
  const result = { receiptId: receipt.receiptId, state: "accepted" };
  const statusPath = path.join(directory, `${batchId}.status.json`);
  try {
    const stat = await lstat(statusPath);
    if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid review status record");
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    if (status.schema !== "fm-agentos-review-status.v1" || status.receiptId !== receipt.receiptId ||
      !["received", "handling", "completed", "failed"].includes(status.state) ||
      typeof status.updatedAt !== "string" || !Number.isFinite(Date.parse(status.updatedAt))) throw new Error("Invalid review status record");
    return { ...result, state: status.state, updatedAt: status.updatedAt };
  } catch (error) { if (error.code === "ENOENT") return result; throw error; }
}

// Receipts live in the checkout running the server, not the browser or Firstmate home.
// Exclusive creation makes a retried batch idempotent and never overwrites an earlier note.
export async function deliverLocalReview(payload, directory = localReviewDir, statusPath = "") {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Review receipt directory is not a directory");
  const filename = path.join(directory, `${payload.batchId}.json`);
  const receiptId = `local:${payload.batchId}`;
  const record = { receiptId, deliveredAt: new Date().toISOString(), payload };
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await file.sync();
    } finally { await file.close(); }
    try {
      await link(temporary, filename); // Publish atomically without replacing an existing batch.
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(filename, "utf8"));
      // Gateway attribution includes observation timestamps which change on a
      // network retry. They are not part of the batch identity; all other
      // provenance and review fields must still match the durable original.
      const stable = (value) => {
        const copy = structuredClone(value);
        if (copy.provenance) { delete copy.provenance.receivedAt; delete copy.provenance.dataReadAt; }
        return JSON.stringify(copy);
      };
      if (stable(existing.payload) !== stable(payload)) throw new Error("Batch id already used for different review notes");
      return { receiptId: existing.receiptId, delivery: "local" };
    }
    // Sync the directory entry before announcing the newly published receipt.
    const dir = await open(directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
    // Only the first successful publication announces the batch; retries do not duplicate it.
    if (statusPath) await appendFile(statusPath, `${reviewStatusLine(payload)}\n`, { encoding: "utf8", flag: "a" });
    return { receiptId, delivery: "local" };
  } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

export async function deliverReview(payload, endpoint, fetcher = fetch) {
  const response = await fetcher(endpoint, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Lavish rejected review (${response.status})`);
  const receipt = await response.json();
  if (!receipt || typeof receipt.receiptId !== "string" || !receipt.receiptId.trim()) throw new Error("Lavish did not confirm a receipt");
  return { receiptId: receipt.receiptId };
}
