// Request admission guards shared by every guarded gateway route: exact origin authority,
// JSON-only bodies and byte-bounded uploads. Policy (which routes, which limits) stays in server.js.

// Loopback hosts may carry an optional port; the Origin header must then echo the same host exactly.
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;
// One exact HTTPS DNS origin: no port, path, wildcard, userinfo or trailing slash.
const HTTPS_DNS_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;

export function exactHttpsOrigin(value) {
  return typeof value === "string" && HTTPS_DNS_ORIGIN.test(value);
}

// The wire Host and Origin must both match the configured origin; forwarding headers are never authority.
export function exactOriginRequest(request, origin) {
  if (typeof origin !== "string" || !origin.startsWith("https://")) return false;
  const host = origin.slice("https://".length);
  return Boolean(host) && (request.headers.host || "") === host && (request.headers.origin || "") === origin;
}

// Same-origin loopback, or the one operator-configured HTTPS origin when present.
export function sameOriginAuthorized(request, allowedOrigin = "") {
  const host = request.headers.host || "";
  const origin = request.headers.origin || "";
  return (LOOPBACK_HOST.test(host) && origin === `http://${host}`) || exactOriginRequest(request, allowedOrigin);
}

export function isJsonRequest(request) {
  return JSON_CONTENT_TYPE.test(request.headers["content-type"] || "");
}

// Composer sends ask for immediate inbox delivery; card sends keep the shared debounce.
export function sendNowRequested(request) {
  return request.headers["x-quarterdeck-send-now"] === "1";
}

// Reads at most `maxBytes` of the body, stops reading as soon as the bound is crossed, and decodes the
// bytes once so a multi-byte character split across chunks is never corrupted. `body` is null when the
// text is not JSON; callers keep their own shape checks.
export async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    size += buffer.length;
    if (size > maxBytes) return { tooLarge: true, text: null, body: null };
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks, size).toString("utf8");
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { tooLarge: false, text, body };
}
