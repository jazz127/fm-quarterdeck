import { mkdir, open, link, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { defaultCostConfiguration, validateCostConfiguration } from "./cost-config.js";
import { inspectPath, readConfinedFile, selectedHome, validateExpenseLedger, MAX_PRIVATE_BYTES } from "./private-runtime.js";

const serialize = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const conflict = () => { throw new Error("Private copy conflict or unsafe path; no existing data was overwritten"); };

async function ensureDirectory(directory, privateFrom) {
  if (!await inspectPath(directory, { privateFrom, directory: true })) {
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (!await inspectPath(directory, { privateFrom, directory: true })) conflict();
}

// Publish a complete file with no-replace semantics. rename() would overwrite a
// user-created destination; hard-link publication is atomic and refuses it.
async function publish(file, bytes, privateFrom) {
  const existing = await readConfinedFile(file, { privateFrom });
  if (existing !== null) { if (!existing.equals(bytes)) conflict(); return; }
  const temporary = path.join(path.dirname(file), `.copy-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    await inspectPath(path.dirname(file), { privateFrom, directory: true });
    await link(temporary, file); // EEXIST fails closed, even for a concurrent identical writer.
  } finally { await handle.close(); await unlink(temporary); }
}

// Bounded input allowlist only: no recursive home/repository copying, Git reads,
// account tools, historical prose, or environment dumps. Sources stay untouched.
export async function migratePrivateExpenses({ sourceRoot, env = {}, mode = "verify", costConfiguration } = {}) {
  if (!["copy", "verify"].includes(mode) || !path.isAbsolute(sourceRoot || "") || path.normalize(sourceRoot) !== sourceRoot) conflict();
  const home = selectedHome(env, true);
  if (!await inspectPath(home, { directory: true }) || !await inspectPath(sourceRoot, { directory: true })) conflict();
  // Do not turn the source checkout into the canonical private home.
  const relative = path.relative(sourceRoot, home);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) conflict();
  const ledger = await readConfinedFile(path.join(sourceRoot, "expenses", "ledger.json"));
  if (!ledger) conflict();
  validateExpenseLedger(JSON.parse(ledger));
  const costs = serialize(validateCostConfiguration(costConfiguration ?? defaultCostConfiguration(env)));
  if (costs.length > MAX_PRIVATE_BYTES) conflict();
  const files = [
    { name: "ledger.json", sourceCategory: "repository-expense-ledger", bytes: ledger },
    { name: "costs.json", sourceCategory: "runtime-cost-configuration", bytes: costs },
  ];
  const manifest = serialize({ schema: "fm-agentos-private-copy.v1", files: files.map(({ name, sourceCategory, bytes }) => ({ sourceCategory, destination: `expenses/${name}`, sha256: hash(bytes) })) });
  files.push({ name: "migration-manifest.json", bytes: manifest });
  const root = path.join(home, "data", "agentos");
  const directory = path.join(root, "expenses");
  const preflight = async () => {
    await inspectPath(directory, { directory: true, privateFrom: root });
    for (const { name, bytes } of files) {
      const existing = await readConfinedFile(path.join(directory, name), { privateFrom: root });
      if (existing === null ? mode === "verify" : !existing.equals(bytes)) conflict();
    }
  };
  await preflight(); // Conflicts anywhere refuse before any destination creation.
  if (mode === "verify") return { verified: 2 };
  await ensureDirectory(path.join(home, "data"));
  await ensureDirectory(root, root);
  const lockPath = path.join(root, ".expense-migration.lock");
  const lock = await open(lockPath, "wx", 0o600); // Never steal a possibly live lock.
  try {
    await preflight();
    await ensureDirectory(directory, root);
    for (const { name, bytes } of files) await publish(path.join(directory, name), bytes, root);
    const dir = await open(directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
    await preflight();
    return { copiedOrIdentical: 2 };
  } finally { await lock.close(); await unlink(lockPath); }
}
