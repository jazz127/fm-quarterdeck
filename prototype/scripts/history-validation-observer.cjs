// Opt-in validation observer only. Never read runtime inputs or emit arbitrary argv/env.
const { readFileSync, writeSync } = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { performance } = require("node:perf_hooks");

const PREFIX = "fm-history-observer ";
const WORKER_PREFIX = "fm-history-worker ";
const MAX_EVENTS = 512;
const MAX_FRAME_BYTES = 2048;
const MAX_SAMPLES = 16;
const SAMPLE_MS = 60000;
const RESOURCE_KINDS = new Set(["PipeWrap", "TCPServerWrap", "TCPSocketWrap", "ProcessWrap", "Timeout", "Immediate", "FSEventWrap", "FSReqCallback", "FSReqPromise", "UDPWrap", "TTYWrap", "Other"]);
const WORKER_EVENTS = new Set(["worker-start", "resources", "tests-after", "before-exit"]);
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV"]);
const prototype = path.resolve(__dirname, "..");
const selection = JSON.parse(readFileSync(path.join(__dirname, "test-selection.json"), "utf8"));
const allowedFiles = new Map(selection.integration.map(file => [path.resolve(prototype, file), file]));
// Sole neutral fixture for proving the actual preload/worker interface offline.
allowedFiles.set(path.join(prototype, "test/fixtures/history-validation-observer/neutral.cjs"), "fixture:neutral");
const identifyFile = value => typeof value === "string" ? allowedFiles.get(path.resolve(value)) : undefined;

function resourceCounts(resources) {
  const counts = new Map();
  for (const kind of resources.slice(0, 1024)) {
    const safe = RESOURCE_KINDS.has(kind) ? kind : "Other";
    counts.set(safe, (counts.get(safe) || 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => ({ kind, count }));
}

function safeWorkerRecord(value, file, pid) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "elapsedMs,event,file,pid,resources" ||
      !WORKER_EVENTS.has(value.event) || value.file !== file || value.pid !== pid ||
      !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 ||
      !Array.isArray(value.resources) || value.resources.length > RESOURCE_KINDS.size) return null;
  const seen = new Set();
  for (const entry of value.resources) {
    if (!entry || Object.keys(entry).sort().join(",") !== "count,kind" || !RESOURCE_KINDS.has(entry.kind) ||
        seen.has(entry.kind) || !Number.isSafeInteger(entry.count) || entry.count < 1 || entry.count > 1024) return null;
    seen.add(entry.kind);
  }
  return { event: value.event, file, pid, workerElapsedMs: value.elapsedMs,
    resources: value.resources.map(({ kind, count }) => ({ kind, count })) };
}

function observeChild(child, file, emit) {
  const pid = Number.isSafeInteger(child.pid) ? child.pid : null;
  // This is a sanitized projection, NOT the original argument vector.
  emit({ event: "child-start", file, pid, argv: ["node", file] });
  child.once("exit", (code, signal) => emit({ event: "child-exit", file, pid,
    code: Number.isInteger(code) && code >= 0 && code <= 255 ? code : null,
    signal: SIGNALS.has(signal) ? signal : null }));
  child.stdout?.once("end", () => emit({ event: "child-stdout-end", file, pid }));
  child.once("close", () => emit({ event: "child-close", file, pid }));
  let frame = "", dropping = false;
  child.stderr?.on("data", chunk => {
    // Do not retain arbitrary stderr or an unbounded incomplete frame.
    for (const char of chunk.toString("utf8")) {
      if (char === "\n") {
        if (!dropping && frame.startsWith(WORKER_PREFIX)) {
          let value;
          try { value = JSON.parse(frame.slice(WORKER_PREFIX.length)); } catch {}
          const safe = safeWorkerRecord(value, file, pid);
          if (safe) emit(safe);
        }
        frame = ""; dropping = false;
      } else if (!dropping) {
        frame += char;
        if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) { frame = ""; dropping = true; }
      }
    }
  });
}

function createEmitter(prefix, write = text => writeSync(2, text)) {
  let count = 0;
  const start = performance.now();
  return value => {
    if (count++ >= MAX_EVENTS) return;
    try { write(`${prefix}${JSON.stringify({ ...value, elapsedMs: Math.floor(performance.now() - start) })}\n`); }
    catch { /* An observer output failure must not change the validation outcome. */ }
  };
}

function installObserver() {
  if (process.env.NODE_TEST_CONTEXT === "child-v8") {
    const file = identifyFile(process.argv[1]);
    if (!file) return;
    const emit = createEmitter(WORKER_PREFIX);
    const sample = event => emit({ event, file, pid: process.pid, resources: resourceCounts(process.getActiveResourcesInfo()) });
    sample("worker-start");
    let samples = 1;
    const timer = setInterval(() => {
      if (samples++ < MAX_SAMPLES) sample("resources");
      if (samples >= MAX_SAMPLES) clearInterval(timer);
    }, SAMPLE_MS);
    timer.unref(); // Does not retain a worker or extend an existing timeout.
    require("node:test").after(() => sample("tests-after"));
    process.once("beforeExit", () => sample("before-exit"));
  } else if (process.execArgv.includes("--test")) {
    const emit = createEmitter(PREFIX);
    // Node loads its runner (and caches the spawn function) before preloads.
    // Observe the original ChildProcess method that cached spawn invokes.
    const original = childProcess.ChildProcess.prototype.spawn;
    childProcess.ChildProcess.prototype.spawn = function (options) {
      const result = Reflect.apply(original, this, arguments);
      const file = options?.file === process.execPath && Array.isArray(options.args) ? identifyFile(options.args.at(-1)) : undefined;
      if (file) observeChild(this, file, emit);
      return result;
    };
  }
}

module.exports = { PREFIX, WORKER_PREFIX, MAX_EVENTS, MAX_FRAME_BYTES, MAX_SAMPLES, SAMPLE_MS,
  identifyFile, resourceCounts, safeWorkerRecord, observeChild, createEmitter };
if (process.env.FM_HISTORY_VALIDATION_OBSERVER === "1") installObserver();
