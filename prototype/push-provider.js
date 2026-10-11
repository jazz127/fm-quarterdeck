import https from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIPv4 } from "node:net";
import webPush from "web-push";

const privateAddresses = new BlockList();
for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]]) privateAddresses.addSubnet(ip, bits);
export const publicIPv4 = (ip) => isIPv4(ip) && !privateAddresses.check(ip);
export function pushEndpoint(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash || url.href !== value) return null;
    const google = url.hostname === "fcm.googleapis.com" && /^\/(?:fcm\/send|wp)\/[A-Za-z0-9_:-]+$/.test(url.pathname);
    const apple = /^(?:[a-z0-9-]+\.)?push\.apple\.com$/.test(url.hostname) && /^\/[A-Za-z0-9_/-]+$/.test(url.pathname) && !url.pathname.includes("//");
    return google || apple ? url : null;
  } catch { return null; }
}
export function validSubscription(value) {
  const exact = (obj, fields) => obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).sort().join(",") === fields;
  const key = (text, size) => typeof text === "string" && /^[A-Za-z0-9_-]+$/.test(text) && Buffer.from(text, "base64url").length === size && Buffer.from(text, "base64url").toString("base64url") === text;
  return exact(value, "endpoint,expirationTime,keys") && pushEndpoint(value.endpoint) &&
    (value.expirationTime === null || Number.isSafeInteger(value.expirationTime) && value.expirationTime > 0) &&
    exact(value.keys, "auth,p256dh") && key(value.keys.auth, 16) && key(value.keys.p256dh, 65) && Buffer.from(value.keys.p256dh, "base64url")[0] === 4;
}

// The standards library owns all RFC 8291/8292 encryption and signatures. Native
// HTTPS owns the bounded transport: no redirects, environment proxy or raw diagnostics.
export function createPushProvider(vapidDetails, { resolve = lookup, request = https.request } = {}) {
  return async (subscription, payload, { ttl, topic, beforeSend = async () => true, remainingTtl = () => ttl }) => {
    if (!validSubscription(subscription)) throw new Error("Invalid push destination");
    const url = pushEndpoint(subscription.endpoint);
    const addresses = await Promise.race([
      resolve(url.hostname, { family: 4, all: true }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Push DNS timeout")), 5000); timer.unref?.(); }),
    ]);
    if (!addresses.length || addresses.some((entry) => entry.family !== 4 || !publicIPv4(entry.address))) throw new Error("Push DNS refused");
    if (!await beforeSend()) return { skipped: true };
    const currentTtl = Math.min(ttl, remainingTtl());
    if (!Number.isInteger(currentTtl) || currentTtl <= 0 || currentTtl > 900) return { skipped: true };
    const details = webPush.generateRequestDetails(subscription, JSON.stringify(payload), {
      vapidDetails, TTL: currentTtl, urgency: "normal", topic, contentEncoding: "aes128gcm",
    });
    return new Promise((resolveRequest, reject) => {
      const req = request(url, { method: details.method, headers: details.headers, agent: false,
        lookup: (_host, options, done) => done(null, options.all ? [addresses[0]] : addresses[0].address, 4),
      }, (response) => {
        let bytes = 0;
        response.on("data", (chunk) => { bytes += chunk.length; if (bytes > 4096) req.destroy(new Error("Push response too large")); });
        response.on("error", reject);
        response.on("end", () => resolveRequest({ statusCode: response.statusCode, retryAfter: response.headers["retry-after"] }));
      });
      const timer = setTimeout(() => req.destroy(new Error("Push timeout; acceptance unknown")), 10000);
      req.once("close", () => clearTimeout(timer));
      req.once("error", reject);
      req.end(details.body);
    });
  };
}
