// Operator-only, task-isolated acceptance fixture. Never invoked by an HTTP route.
// Run from a clean committed disposable worktree, then use chrome-devtools-axi.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { fixtureGit, createSyntheticHistory } from "./synthetic-history.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { createServer } from "../server.js";
import { reviewVersion } from "../review.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
if (!/^[a-f0-9]{40}$/.test(reviewVersion) || git("rev-parse", "HEAD") !== reviewVersion || git("status", "--porcelain")) throw new Error("Clean exact committed revision required");
const root = path.join(repo, ".preview-lab", `run-${reviewVersion.slice(0, 12)}-${Date.now()}`);
await mkdir(root, { recursive: true, mode: 0o700 });
// Explicit offline fixture provisioning, never performed during selection.
// Export a tree object through the same strict verifier used for publication.
// This generated allowlist is lab-only, not an independent release approval.
const tool = path.join(repo, "scripts/source-export.py");
const allowlist = path.join(root, "allowlist.json"), archive = path.join(root, "source.tar");
const tree = git("rev-parse", "HEAD^{tree}");
const exportCommand = (...args) => execFileSync("python3", [tool, ...args], {
  cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH, TMPDIR: root, PYTHONDONTWRITEBYTECODE: "1" },
});
await writeFile(allowlist, exportCommand("inventory", "--tree", tree));
exportCommand("export", "--tree", tree, "--allowlist", allowlist, "--archive", archive);
let history;
for (const name of ["one", "two", "bad"]) {
  const checkout = path.join(root, name);
  exportCommand("extract", "--allowlist", allowlist, "--archive", archive, "--destination", checkout);
  history = await createSyntheticHistory(checkout);
}
const { head: fixtureHead, ancestor } = history;
const home = path.join(root, "synthetic-home");
await mkdir(path.join(home, "data"), { recursive: true }); await mkdir(path.join(home, "state"));
await writeFile(path.join(home, "data/projects.md"), "- fm-quarterdeck - Synthetic lifecycle acceptance\n");
await writeFile(path.join(home, "data/backlog.md"), "## Queued\n");
const reserve = async () => { const listener = net.createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r)); return listener; };
const slot = await reserve(), blocker = await reserve();
const port = slot.address().port, badPort = blocker.address().port;
await new Promise((r) => slot.close(r));
const scenario = process.env.FM_PREVIEW_LAB_SCENARIO || "local-first";
if (!["local-first", "main-mismatch", "failed-local"].includes(scenario)) throw new Error("Unknown lab scenario");
const divergent = fixtureGit(path.join(root, "two"), "commit-tree", `${fixtureHead}^{tree}`, "-p", ancestor, "-m", "Synthetic sibling checkpoint, not active");
fixtureGit(path.join(root, "bad"), "checkout", "--detach", ancestor);
const entries = [
  { id: "main", name: "Main (isolated fixture)", branch: "main", commit: reviewVersion, remoteCheckpoint: scenario === "main-mismatch" ? ancestor : reviewVersion, validation: "captured" },
  { id: "uat", name: "UAT", branch: "uat", commit: fixtureHead, remoteCheckpoint: ancestor, validation: "review-ready", checkout: "one", port },
  { id: "stg", name: "Staging", branch: "stg", commit: fixtureHead, remoteCheckpoint: divergent, validation: "captured", checkout: "two", port: scenario === "failed-local" ? badPort : port },
  { id: "dev-bad", name: "Development: mismatched", branch: "dev/bad", commit: fixtureHead, remoteCheckpoint: fixtureHead, validation: "captured", checkout: "bad", port },
];
const events = path.join(root, "events.jsonl");
const server = createServer({ FM_HOME: home, FM_PREVIEW_ROOT: root, FM_PREVIEW_IDLE_MS: "8000", FM_PREVIEW_START_MS: "4000",
  FM_PREVIEW_PORT_MIN: String(Math.min(port, badPort)), FM_PREVIEW_PORT_MAX: String(Math.max(port, badPort)) }, {
  previewRegistry: entries, quotaReader: async () => ({ available: false, subscriptions: [], providers: [] }),
  localReviewDeliver: async (payload) => { await appendFile(path.join(root, "annotations.jsonl"), `${JSON.stringify(payload)}\n`); return { receiptId: `fixture:${payload.batchId}` }; },
  reviewCount: async () => 0,
  chatDeliver: async (payload) => { if (payload.destination !== "primary-firstmate") throw new Error("Wrong destination"); await new Promise((r) => setTimeout(r, 3000)); await appendFile(path.join(root, "chat.jsonl"), `${JSON.stringify(payload)}\n`); return { receiptId: "fixture:primary-firstmate" }; },
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
const info = { revision: reviewVersion, fixtureHead, ancestor, divergent, scenario, root, url, pid: process.pid };
await writeFile(path.join(repo, ".preview-lab", "current.json"), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info));
let last = "", blockerClosed = false;
const observe = setInterval(() => {
  const c = server.previewLifecycle;
  const state = c.list().map(({ id, state, activeRequests }) => ({ id, state, activeRequests }));
  const serialized = JSON.stringify(state);
  if (serialized !== last) {
    last = serialized;
    appendFile(events, `${JSON.stringify({ at: new Date().toISOString(), revision: reviewVersion, state, identity: c.owned?.identity || null, generation: c.owned?.generation || null })}\n`).catch(console.error);
  }
  // Release only this fixture's own deliberately occupied port after the failed start.
  if (!blockerClosed && c.status("stg").state === "failed") { blockerClosed = true; blocker.close(); }
}, 25);
let closing = false;
async function close() {
  if (closing) return; closing = true; clearInterval(observe);
  if (!blockerClosed) blocker.close();
  server.close();
  await server.shutdownPreviews();
  await appendFile(events, `${JSON.stringify({ at: new Date().toISOString(), cleanup: "exact owned children stopped", revision: reviewVersion })}\n`);
}
process.on("SIGTERM", () => close().catch(console.error));
process.on("SIGINT", () => close().catch(console.error));
