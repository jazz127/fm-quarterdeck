import { formatReviewNote } from "./review-note.js";
import { spawn } from "node:child_process";
import path from "node:path";

// Invoke only the guarded Firstmate interface. Never read or write its state directly.
async function call(home, args, input = "") {
  if (!path.isAbsolute(home)) throw new Error("FM_HOME must be absolute for review intake");
  const executable = path.join(home, "bin", "fm-inbox.sh");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: { ...process.env, FM_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 4_000_000) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 4096) child.kill("SIGKILL"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    // A guarded inbox may refuse before consuming stdin. EPIPE is an unconfirmed
    // delivery, not an unhandled stream error that can terminate the HTTP server.
    child.stdin.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}
const requestId = (batchId) => `agentos-review:${batchId}`;
export async function inboxReady(home) {
  const result = await call(home, ["ready"]);
  if (result.code !== 0) throw new Error("Firstmate readiness unavailable");
  const ready = JSON.parse(result.stdout);
  return ready.schema === "fm-primary-ready.v1" && ready.can_receive === true;
}
export async function announceReview(home, payload) {
  const body = payload.schema === "fm-agentos-review.v2" ? formatReviewNote(payload) : `Quarterdeck review annotation batch ${payload.batchId}\nVersion: ${payload.version}\nRoute: ${payload.route}\nEnd: ${payload.end}\nPreview: ${payload.provenance ? `${payload.provenance.preview} · ${payload.provenance.branch} · ${payload.provenance.commit} · ${payload.provenance.remoteCheckpoint || "no remote checkpoint"}` : "standalone"}\nEntries:\n${payload.entries.map((entry, i) => `${i + 1}. ${entry.kind} · ${entry.route} · ${entry.target?.type === "record" ? `Lane Chat record ${entry.target.recordId}` : entry.target?.type === "quote" ? `Lane Chat message quote ${JSON.stringify({ time: entry.target.time, text: entry.target.text, lanes: entry.target.lanes })}` : entry.region ? `${entry.region.label} (${entry.region.id})` : "message"}\n${entry.text}`).join("\n\n")}`;
  return noteWithRequestId(home, requestId(payload.batchId), body);
}
// Idempotent per request id: a retry returns the original note and repairs a missing wake.
export async function noteWithRequestId(home, id, body) {
  const result = await call(home, ["note", "--request-id", id, "--json", "-"], body);
  if (![0, 3].includes(result.code)) throw new Error("Firstmate note not saved");
  const note = JSON.parse(result.stdout);
  if (note.schema !== "fm-inbox-note.v1" || note.request_id !== id || !note.saved || typeof note.id !== "string") throw new Error("Invalid Firstmate note receipt");
  if (result.code === 3 || !note.announced) {
    const repair = await call(home, ["announce", "--json", note.id]);
    if (repair.code !== 0) throw new Error("Firstmate note saved but not announced; retry the same request to repair");
  }
  return note;
}
export async function inboxReceipts(home) {
  const result = await call(home, ["receipts", "--all-pending", "--all-handled", "--all-replies"]);
  if (result.code !== 0) throw new Error("Firstmate receipts unavailable");
  const data = JSON.parse(result.stdout);
  if (data.schema !== "fm-inbox-receipts.v1" || !Array.isArray(data.pending) || !Array.isArray(data.handled) || !Array.isArray(data.replies) || data.omitted?.length) throw new Error("Incomplete Firstmate receipts");
  return data;
}
export function inboxNoteState(receipts, id) {
  const pending = receipts.pending.find((note) => note.request_id === id);
  const handled = receipts.handled.find((note) => note.request_id === id);
  const note = handled || pending;
  if (!note) return null;
  const reply = receipts.replies.find((entry) => entry.id === note.id || entry.note_id === note.id || entry.in_reply_to === note.id);
  if (reply) return { state: "replied", reply: typeof reply.body === "string" ? reply.body : typeof reply.text === "string" ? reply.text : null };
  return { state: handled ? "received" : "accepted", announced: note.announced === true };
}
export const inboxReviewState = (receipts, batchId) => inboxNoteState(receipts, requestId(batchId));

// Explicit operator action, never called by HTTP intake or health checks.
// Retry repairs closure only: it must not repeat the underlying captain order.
export async function replyAndAckNote(home, id, text, { invoke = call } = {}) {
  if (!path.isAbsolute(home) || !/^[0-9]{1,12}(?:[-_.][A-Za-z0-9_.-]{1,100})?$/.test(id) ||
      typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 32 * 1024 || text.includes("\0")) {
    throw new Error("Explicit home, safe note id and bounded nonempty reply required");
  }
  const read = async () => {
    const result = await invoke(home, ["receipts", "--all-pending", "--all-handled", "--all-replies"]);
    if (result.code !== 0) throw new Error("Note receipts unavailable; nothing acknowledged");
    const data = JSON.parse(result.stdout);
    if (data.schema !== "fm-inbox-receipts.v1" || !Array.isArray(data.pending) || !Array.isArray(data.handled) ||
        !Array.isArray(data.replies) || data.omitted?.length) throw new Error("Incomplete note receipts");
    const pending = data.pending.filter((note) => note.id === id);
    const handled = data.handled.filter((note) => note.id === id);
    if (pending.length + handled.length !== 1) throw new Error("Note absent or ambiguous");
    const replies = data.replies.filter((entry) => entry.id === id || entry.note_id === id || entry.in_reply_to === id);
    const bodies = replies.map((entry) => typeof entry.body === "string" ? entry.body : entry.text);
    if (bodies.some((body) => body !== text)) throw new Error("Recorded reply differs; inspect before retrying");
    return { pending: pending.length === 1, replied: bodies.length > 0 };
  };
  let state = await read();
  if (!state.replied) {
    if (!state.pending) throw new Error("Note already acknowledged without a reply; inspect manually");
    const reply = await invoke(home, ["reply", id, text]);
    if (reply.code !== 0) throw new Error("Reply failed; acknowledgement not attempted");
    state = await read();
    if (!state.replied) throw new Error("Reply not recorded; acknowledgement not attempted");
  }
  if (state.pending) {
    const ack = await invoke(home, ["drain", "--ack", id]);
    if (ack.code !== 0) throw new Error("Acknowledgement failed; retry the same reply, not the order");
    state = await read();
  }
  if (state.pending || !state.replied) throw new Error("Reply plus acknowledgement not confirmed");
  return { state: "replied-and-acked", id };
}
