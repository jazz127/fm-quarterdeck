import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { validateCostConfiguration } from "./cost-config.js";

export const OVERLAY_FILES = ["ledger.json", "costs.json", "migration-manifest.json"];
export const MAX_PRIVATE_BYTES = 4 * 1024 * 1024;
const fail = () => { throw new Error("Private expense overlay unavailable; check selected FM_HOME and private files"); };

export function selectedHome(env, required = false) {
  const home = env.FM_HOME;
  if (!home && !required) return null;
  if (typeof home !== "string" || !path.isAbsolute(home) || path.normalize(home) !== home || home === path.parse(home).root) fail();
  return home;
}

// Check every component, including dangling links and links above FM_HOME. Never
// resolve a symlink into a different home's namespace. Missing is not malformed.
export async function inspectPath(file, { privateFrom, directory = false } = {}) {
  const root = path.parse(file).root;
  if (!root || path.normalize(file) !== file) fail();
  let current = root;
  for (const part of file.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (info.isSymbolicLink() || ((current !== file || directory) ? !info.isDirectory() : !info.isFile())) fail();
    if (current === file && !directory && (info.nlink !== 1 || info.size > MAX_PRIVATE_BYTES)) fail();
    if (privateFrom && (current === privateFrom || current.startsWith(`${privateFrom}${path.sep}`)) && process.platform !== "win32" &&
        ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()))) fail();
  }
  return lstat(file);
}

export async function readConfinedFile(file, options = {}) {
  const before = await inspectPath(file, options);
  if (!before) return null;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_PRIVATE_BYTES || info.dev !== before.dev || info.ino !== before.ino) fail();
    const bytes = await handle.readFile();
    if (bytes.length > MAX_PRIVATE_BYTES) fail();
    const after = await inspectPath(file, options);
    if (!after || after.dev !== info.dev || after.ino !== info.ino || after.size !== bytes.length || after.mtimeMs !== info.mtimeMs) fail();
    return bytes;
  } finally { await handle.close(); }
}

// Same ledger contract as the Python writer; retain every optional field and all
// decimal strings verbatim. Validation errors must not echo private field values.
export function validateExpenseLedger(data) {
  const keys = (obj, required, optional = []) => obj && typeof obj === "object" && !Array.isArray(obj) && required.every((k) => Object.hasOwn(obj, k)) && Object.keys(obj).every((k) => [...required, ...optional].includes(k));
  const currency = (s) => typeof s === "string" && /^[A-Z]{3}$/.test(s);
  if (!keys(data, ["version", "default_currency", "entries"]) || data.version !== 1 || !currency(data.default_currency) || !Array.isArray(data.entries)) fail();
  const seen = new Set(); const names = new Map();
  for (const row of data.entries) {
    if (!keys(row, ["id", "date", "amount", "project_id", "note"], ["currency", "project_name", "category", "confidence"]) ||
        ["id", "project_id"].some((k) => typeof row[k] !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(row[k])) || seen.has(row.id) ||
        typeof row.amount !== "string" || !/^-?[0-9]+\.[0-9]{2}$/.test(row.amount) || typeof row.date !== "string" || !/^(?!0000)\d{4}-\d\d-\d\d$/.test(row.date) ||
        !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date ||
        (Object.hasOwn(row, "currency") && !currency(row.currency))) fail();
    for (const key of ["note", "project_name", "category", "confidence"]) if (Object.hasOwn(row, key) && (typeof row[key] !== "string" || !row[key].trim() || /[\r\n]/.test(row[key]))) fail();
    if (row.project_name) {
      if (names.has(row.project_id) && names.get(row.project_id) !== row.project_name) fail();
      names.set(row.project_id, row.project_name);
    }
    seen.add(row.id);
  }
  return data;
}

export function validateManifest(value) {
  if (value?.schema !== "fm-agentos-private-copy.v1" || !Array.isArray(value.files) || value.files.length !== 2 ||
      value.files.some((entry, index) => entry.destination !== `expenses/${OVERLAY_FILES[index]}` || entry.sourceCategory !== ["repository-expense-ledger", "runtime-cost-configuration"][index] || !/^[a-f0-9]{64}$/.test(entry.sha256 || ""))) fail();
  return value;
}

export async function readExpenseOverlay(env = {}) {
  const home = selectedHome(env);
  if (!home) return null;
  const root = path.join(home, "data", "agentos");
  const directory = path.join(root, "expenses");
  if (!await inspectPath(directory, { privateFrom: root, directory: true })) return null;
  const bytes = await Promise.all(OVERLAY_FILES.map((name) => readConfinedFile(path.join(directory, name), { privateFrom: root })));
  if (bytes.some((value) => value === null)) fail(); // Partial copies never silently select tracked data.
  validateManifest(JSON.parse(bytes[2]));
  return { ledger: validateExpenseLedger(JSON.parse(bytes[0])), costs: validateCostConfiguration(JSON.parse(bytes[1])) };
}
