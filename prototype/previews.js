import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { readFile } from "node:fs/promises";

const SHA = /^[a-f0-9]{40}$/;
const ID = /^(main|uat|stg|dev-[a-z0-9-]{1,60})$/;
const LABELS = new Set(["captured", "previewable", "review-ready", "accepted", "archived"]);
const TIERS = { main: "main", uat: "uat", stg: "stg" };

// Only already-present objects are inspected. Neither this code nor the gateway updates refs.
export async function commitRelation(local, remote, cwd, run = (args) => exec("git", ["-c", "core.fsmonitor=false", ...args], {
  cwd, env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" }, timeout: 5000,
})) {
  if (remote == null) return "absent";
  if (local === remote) return "equal";
  try {
    const object = await run(["cat-file", "-t", remote]);
    if (object.stdout.trim() !== "commit") return "unknown";
    const ancestor = async (a, b) => { try { await run(["merge-base", "--is-ancestor", a, b]); return true; } catch (error) { if (error.code === 1) return false; throw error; } };
    if (await ancestor(remote, local)) return "local-ahead";
    if (await ancestor(local, remote)) return "remote-ahead";
    return "diverged";
  } catch { return "unknown"; }
}

// This is an operator-owned allowlist, never derived from a browser ref or a remote branch listing.
export function validateRegistry(entries) {
  if (!Array.isArray(entries) || entries.length > 100) throw new Error("Preview registry must be an array (up to 100 entries)");
  const seen = new Set();
  return entries.map((entry) => {
    if (!entry || Object.keys(entry).some((key) => !["id", "name", "branch", "commit", "remoteCheckpoint", "validation", "checkout", "port"].includes(key)) || !ID.test(entry.id) || seen.has(entry.id) || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 80 ||
      typeof entry.branch !== "string" || !SHA.test(entry.commit) ||
      (entry.remoteCheckpoint != null && !SHA.test(entry.remoteCheckpoint)) ||
      ((entry.id === "main" || entry.id.startsWith("dev-")) && !SHA.test(entry.remoteCheckpoint)) || !LABELS.has(entry.validation) ||
      (TIERS[entry.id] ? entry.branch !== TIERS[entry.id] : entry.branch !== `dev/${entry.id.slice(4)}`)) throw new Error("Invalid or duplicate registered preview");
    seen.add(entry.id);
    if (entry.checkout != null && (typeof entry.checkout !== "string" || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(entry.checkout) || entry.checkout.length > 200)) throw new Error("Unsafe registered checkout");
    if (entry.port != null && (!Number.isInteger(entry.port) || entry.port < 1024 || entry.port > 65535)) throw new Error("Invalid registered port");
    if (entry.id === "main" && (entry.checkout != null || entry.port != null)) throw new Error("Main is the warm stable host, never a managed child");
    return Object.freeze({ id: entry.id, name: entry.name.trim(), branch: entry.branch, commit: entry.commit, remoteCheckpoint: entry.remoteCheckpoint ?? null, validation: entry.validation, checkout: entry.checkout || null, port: entry.port ?? null });
  });
}

export async function loadRegistry(file) {
  return validateRegistry(file ? JSON.parse(await readFile(file, "utf8")) : []);
}

export function previewPath(pathname) {
  const match = pathname.match(/^\/preview\/(main|uat|stg|dev-[a-z0-9-]{1,60})(\/.*)?$/);
  return match ? { id: match[1], pathname: match[2] || "/" } : null;
}

export async function previewHealth(entry, probe = fetch) {
  if (!entry.url) return { health: "stopped", checkedAt: new Date().toISOString(), freshness: "unknown" };
  try {
    const response = await probe(`${entry.url}/api/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    const health = await response.json();
    if (!response.ok || health.ok !== true || health.service !== "fm-quarterdeck") throw new Error("Unhealthy preview");
    const identity = await probe(`${entry.url}/api/review`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    if (!identity.ok || (await identity.json()).version !== entry.commit) throw new Error("Revision mismatch");
    return { health: "running", checkedAt: new Date().toISOString(), freshness: "current" };
  } catch (error) {
    return { health: "stopped", state: error.message === "Revision mismatch" ? "revision-mismatch" : "failed", reason: error.message === "Revision mismatch" ? "Revision mismatch" : "Preview unavailable", checkedAt: null, freshness: "unknown" };
  }
}

// Proxy only the registered loopback service. No repository-ref, arbitrary URL or shell access.
export function proxyPreview(entry, pathname, search, request, response, onRead = () => {}, hostId = "main") {
  return new Promise((resolve) => {
    const upstream = http.get(`${entry.url}${pathname}${search}`, { timeout: 30000 }, (result) => {
      if (pathname.startsWith("/api/")) {
        response.writeHead(result.statusCode, { "content-type": result.headers["content-type"] || "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        let bytes = 0;
        result.on("data", (chunk) => { bytes += chunk.length; if (bytes > 128 * 1024 * 1024) result.destroy(); });
        result.on("end", () => { if (result.statusCode === 200) onRead(new Date().toISOString()); resolve(); });
        result.on("error", () => { response.destroy(); resolve(); });
        result.pipe(response);
        return;
      }
      const chunks = [];
      let length = 0;
      result.on("data", (chunk) => { length += chunk.length; if (length > 8 * 1024 * 1024) result.destroy(); else chunks.push(chunk); });
      result.on("error", () => { if (!response.headersSent) { response.writeHead(502); response.end("Preview unavailable"); } resolve(); });
      result.on("end", () => {
        if (response.headersSent) return resolve();
        let body = Buffer.concat(chunks);
        const type = result.headers["content-type"] || "application/octet-stream";
        if (pathname === "/" && type.includes("text/html") && result.statusCode === 200) {
          // Script before the preview's own code redirects only its API reads to its isolated runtime.
          // Review/chat writes remain on this host; the host, not the preview, signs provenance.
          const prefix = `/preview/${entry.id}`;
          body = Buffer.from(body.toString("utf8")
            .replace(/(src|href)="\/(app\.js|quota-view-model\.js|review-client\.js|bearings-patch\.js|bearings-view\.js|bearings-live\.js|styles\.css|dev-reload\.js)"/g, `$1="${prefix}/$2"`)
            .replace("</head>", `<script>window.FM_HOST_ID=${JSON.stringify(hostId)};window.FM_PREVIEW_ID=${JSON.stringify(entry.id)};window.FM_SERVED_COMMIT=${JSON.stringify(entry.commit)};const fmFetch=window.fetch.bind(window);window.fetch=(input,options)=>typeof input==="string"&&input.startsWith("/api/")&&!input.startsWith("/api/previews")?fmFetch(${JSON.stringify(prefix)}+input,options):fmFetch(input,options);</script><script defer src="/preview-selector.js"></script></head>`));
        }
        response.writeHead(result.statusCode, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(body);
        if (result.statusCode === 200 && pathname.startsWith("/api/")) onRead(new Date().toISOString());
        resolve();
      });
    });
    const disconnected = () => { upstream.destroy(); resolve(); };
    response.once("close", disconnected);
    upstream.once("close", () => response.off("close", disconnected));
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => { if (!response.headersSent) { response.writeHead(502); response.end("Preview unavailable"); } resolve(); });
  });
}
