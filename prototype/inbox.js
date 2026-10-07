import { spawn } from "node:child_process";
import path from "node:path";

// Invoke only the guarded Firstmate interface. Never read or write its state directly.
async function call(home, args, input = "") {
  if (!path.isAbsolute(home)) throw new Error("FM_HOME must be absolute for review intake");
  const executable = path.join(home, "bin", "fm-inbox.sh");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: { ...process.env, FM_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 4_000_000) child.kill(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 4096) child.kill(); });
    child.on("error", reject);
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
  const body = `Quarterdeck review annotation batch ${payload.batchId}\nVersion: ${payload.version}\nRoute: ${payload.route}\nEnd: ${payload.end}\nPreview: ${payload.provenance ? `${payload.provenance.preview} · ${payload.provenance.branch} · ${payload.provenance.commit} · ${payload.provenance.remoteCheckpoint || "no remote checkpoint"}` : "standalone"}\nEntries:\n${payload.entries.map((entry, i) => `${i + 1}. ${entry.kind} · ${entry.route} · ${entry.target?.type === "record" ? `Lane Chat record ${entry.target.recordId}` : entry.target?.type === "quote" ? `Lane Chat message quote ${JSON.stringify({ time: entry.target.time, text: entry.target.text, lanes: entry.target.lanes })}` : entry.region ? `${entry.region.label} (${entry.region.id})` : "message"}\n${entry.text}`).join("\n\n")}`;
  const result = await call(home, ["note", "--request-id", requestId(payload.batchId), "--json", "-"], body);
  if (![0, 3].includes(result.code)) throw new Error("Firstmate note not saved");
  const note = JSON.parse(result.stdout);
  if (note.schema !== "fm-inbox-note.v1" || note.request_id !== requestId(payload.batchId) || !note.saved || typeof note.id !== "string") throw new Error("Invalid Firstmate note receipt");
  if (result.code === 3 || !note.announced) {
    const repair = await call(home, ["announce", "--json", note.id]);
    if (repair.code !== 0) throw new Error("Firstmate note saved but not announced; retry same batch to repair");
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
export function inboxReviewState(receipts, batchId) {
  const id = requestId(batchId);
  const pending = receipts.pending.find((note) => note.request_id === id);
  const handled = receipts.handled.find((note) => note.request_id === id);
  const note = handled || pending;
  if (!note) return null;
  const reply = receipts.replies.find((entry) => entry.id === note.id || entry.note_id === note.id || entry.in_reply_to === note.id);
  if (reply) return { state: "replied", reply: typeof reply.text === "string" ? reply.text : null };
  return { state: handled ? "received" : "accepted", announced: note.announced === true };
}
