// Operator-only, bounded, task-isolated read-only expense acceptance.
// Explicit FM_HOME authorizes ONLY its expense overlay, not other home endpoints.
// No account CLI, intake executable, preview child, Git mutation or private logging.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer, loadExpenses, rollupLedger } from "../server.js";
import { createConfiguredCostReader } from "../costs.js";
import { selectedHome, OVERLAY_FILES, inspectPath, readConfinedFile } from "../private-runtime.js";
import { verifyPreservedExpenses } from "../private-verification.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const servers = [];
let closing = false;
let before;
let snapshot;
let deadline;
async function close() {
  if (closing) return;
  closing = true;
  clearTimeout(deadline);
  for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  try {
    if (!before || JSON.stringify(await snapshot()) !== JSON.stringify(before)) throw new Error();
    console.log("PASS: selected expense bytes, inode, size, permissions and modification times unchanged");
  } catch { console.error("FAIL: private read-only invariant; no private diagnostics emitted"); process.exitCode = 1; }
}
try {
  const git = (...args) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const revision = git("rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/.test(revision) || git("status", "--porcelain")) throw new Error();
  const home = selectedHome(process.env, true);
  const env = { FM_HOME: home };
  const original = await verifyPreservedExpenses(env);
  snapshot = async () => Promise.all(OVERLAY_FILES.map(async (name) => {
    const file = path.join(home, "data/agentos/expenses", name);
    const options = { privateFrom: path.join(home, "data/agentos") };
    const info = await inspectPath(file, options);
    return { digest: createHash("sha256").update(await readConfinedFile(file, options)).digest("hex"), ino: info.ino, size: info.size, mode: info.mode, mtime: info.mtimeMs, ctime: info.ctimeMs };
  }));
  before = await snapshot();
  const expected = { ...rollupLedger(original.ledger), source: "private overlay (selected FM_HOME)", demo: false };
  if (JSON.stringify(await loadExpenses(env)) !== JSON.stringify(expected)) throw new Error();
  // Production config/attribution path, but command execution is replaced before
  // it can launch anything. Unavailable labels remain selected-home authoritative.
  const offline = { run: async () => { throw new Error("Offline acceptance"); } };
  const urls = {};
  for (const mode of ["empty", "private"]) {
    const selected = mode === "private" ? env : {};
    const server = createServer({ FM_DEPLOYMENT_TIER: "uat" }, {
      expenseReader: () => loadExpenses(selected),
      costReader: createConfiguredCostReader(selected, offline),
      quotaReader: async () => ({ available: false, providers: [], subscriptions: [] }),
      reviewCount: async () => 0,
      lanesReader: async () => ({ source: "synthetic", lanes: [], transcript: {} }),
      durabilityVerifier: async () => ({ state: "unknown" }),
      localReviewDeliver: async () => { throw new Error("Read-only fixture"); },
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    urls[mode] = `http://127.0.0.1:${server.address().port}/#expenses`;
  }
  deadline = setTimeout(() => { console.error("Fixture deadline reached"); process.exitCode = 1; void close(); }, 300000);
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());
  console.log(JSON.stringify({ revision, ...urls, deadlineSeconds: 300 }));
  console.log("PASS: private ledger/rollup parity; only expense overlay selected, all account readers injected offline");
} catch {
  console.error("Expense acceptance fixture refused; verify explicit home, preserved bundle and exact clean revision");
  process.exitCode = 1;
  await close();
}
