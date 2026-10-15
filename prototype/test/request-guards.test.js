import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { exactHttpsOrigin, exactOriginRequest, isJsonRequest, readJsonBody, sameOriginAuthorized, sendNowRequested } from "../request-guards.js";

const request = (headers = {}) => ({ headers });
const body = (...chunks) => Readable.from(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"))));

test("exactHttpsOrigin accepts one bare HTTPS DNS origin and nothing looser", () => {
  assert.equal(exactHttpsOrigin("https://quarterdeck.example.ts.net"), true);
  assert.equal(exactHttpsOrigin("https://a.b"), true);
  for (const value of ["http://quarterdeck.example.ts.net", "https://quarterdeck.example.ts.net/", "https://quarterdeck.example.ts.net:443",
    "https://quarterdeck.example.ts.net/path", "https://user@quarterdeck.example.ts.net", "https://*.example.ts.net", "https://localhost",
    "https://-bad.example.net", "https://bad-.example.net", "", undefined, null, 42]) {
    assert.equal(exactHttpsOrigin(value), false, `${value} must be refused`);
  }
});

test("exactOriginRequest requires the wire Host and Origin to both match the configured origin", () => {
  const origin = "https://quarterdeck.example.ts.net";
  assert.equal(exactOriginRequest(request({ host: "quarterdeck.example.ts.net", origin }), origin), true);
  assert.equal(exactOriginRequest(request({ host: "quarterdeck.example.ts.net" }), origin), false, "absent Origin is not authority");
  assert.equal(exactOriginRequest(request({ host: "other.example.ts.net", origin }), origin), false);
  assert.equal(exactOriginRequest(request({ host: "quarterdeck.example.ts.net", origin: "http://quarterdeck.example.ts.net" }), origin), false);
  assert.equal(exactOriginRequest(request({ host: "quarterdeck.example.ts.net", origin, "x-forwarded-host": "quarterdeck.example.ts.net" }), ""), false, "no configured origin, no authority");
  assert.equal(exactOriginRequest(request({ host: "", origin: "https://" }), "https://"), false);
});

test("sameOriginAuthorized accepts loopback same-origin requests and the one configured HTTPS origin", () => {
  for (const host of ["127.0.0.1:4173", "localhost:4173", "[::1]:4173", "127.0.0.1", "localhost"]) {
    assert.equal(sameOriginAuthorized(request({ host, origin: `http://${host}` })), true, host);
  }
  assert.equal(sameOriginAuthorized(request({ host: "127.0.0.1:4173", origin: "http://127.0.0.1:4174" })), false, "origin must echo the exact host");
  assert.equal(sameOriginAuthorized(request({ host: "127.0.0.1:4173", origin: "https://127.0.0.1:4173" })), false, "loopback is plain HTTP");
  assert.equal(sameOriginAuthorized(request({ host: "127.0.0.1:4173" })), false, "absent Origin is refused");
  assert.equal(sameOriginAuthorized(request({ host: "127.0.0.1.evil.example", origin: "http://127.0.0.1.evil.example" })), false);
  assert.equal(sameOriginAuthorized(request({ host: "10.0.0.5:4173", origin: "http://10.0.0.5:4173", "x-forwarded-for": "127.0.0.1" })), false, "forwarding headers are not authority");
  const allowed = "https://quarterdeck.example.ts.net";
  assert.equal(sameOriginAuthorized(request({ host: "quarterdeck.example.ts.net", origin: allowed }), allowed), true);
  assert.equal(sameOriginAuthorized(request({ host: "quarterdeck.example.ts.net", origin: allowed })), false, "only when configured");
  assert.equal(sameOriginAuthorized(request({ host: "sub.quarterdeck.example.ts.net", origin: "https://sub.quarterdeck.example.ts.net" }), allowed), false);
});

test("isJsonRequest accepts application/json with optional parameters only", () => {
  for (const type of ["application/json", "application/json; charset=utf-8", "application/json ;charset=utf-8", "APPLICATION/JSON"]) {
    assert.equal(isJsonRequest(request({ "content-type": type })), true, type);
  }
  for (const type of ["text/plain", "application/jsonx", "application/json-patch+json", "application/x-www-form-urlencoded", undefined, ""]) {
    assert.equal(isJsonRequest(request({ "content-type": type })), false, String(type));
  }
});

test("sendNowRequested reads only the exact header value", () => {
  assert.equal(sendNowRequested(request({ "x-quarterdeck-send-now": "1" })), true);
  assert.equal(sendNowRequested(request({ "x-quarterdeck-send-now": "true" })), false);
  assert.equal(sendNowRequested(request({})), false);
});

test("readJsonBody decodes a multi-byte character split across chunks exactly once", async () => {
  const encoded = Buffer.from(JSON.stringify({ text: "Café ✓" }), "utf8");
  const split = encoded.indexOf(Buffer.from("é", "utf8")) + 1; // inside the two-byte é
  const result = await readJsonBody(body(encoded.subarray(0, split), encoded.subarray(split)), 1024);
  assert.deepEqual(result, { tooLarge: false, text: encoded.toString("utf8"), body: { text: "Café ✓" } });
});

test("readJsonBody bounds the upload in bytes, not UTF-16 code units", async () => {
  const text = JSON.stringify({ t: "é".repeat(4) }); // 12 code units, 16 bytes
  assert.equal(text.length, 12);
  assert.equal(Buffer.byteLength(text), 16);
  assert.equal((await readJsonBody(body(text), 16)).tooLarge, false);
  assert.equal((await readJsonBody(body(text), 15)).tooLarge, true);
  assert.deepEqual(await readJsonBody(body(text), 12), { tooLarge: true, text: null, body: null });
});

test("readJsonBody releases the upload as soon as the bound is crossed", async () => {
  const stream = body("{\"a\":\"", "x".repeat(64), "\"}");
  const result = await readJsonBody(stream, 32);
  assert.deepEqual(result, { tooLarge: true, text: null, body: null });
  assert.equal(stream.destroyed, true, "the remaining upload is discarded, not buffered");
  const whole = body("{\"a\":\"", "x".repeat(64), "\"}");
  assert.equal((await readJsonBody(whole, 128)).body.a, "x".repeat(64));
  assert.equal(whole.destroyed, true, "a fully read upload is finished too");
});

test("readJsonBody returns the raw text and a null body for non-JSON or empty uploads", async () => {
  assert.deepEqual(await readJsonBody(body("not json"), 64), { tooLarge: false, text: "not json", body: null });
  assert.deepEqual(await readJsonBody(body(), 64), { tooLarge: false, text: "", body: null });
  assert.deepEqual(await readJsonBody(body("null"), 64), { tooLarge: false, text: "null", body: null });
  assert.deepEqual((await readJsonBody(body("[1,", "2]"), 64)).body, [1, 2]);
});
