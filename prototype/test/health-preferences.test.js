import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { healthPreferencesPath, readHealthPreferences, saveHealthPreferences, validHealthPreferences } from "../health-preferences.js";
import { createServer } from "../server.js";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "quarterdeck-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { FM_QUARTERDECK_STATE_PATH: path.join(directory, "agent-state.json") };
}
const defaults = { awayCheckInMinutes: 10, openNoteAlarmMinutes: 15 };
test("health preference storage defaults, saves atomically, and shares legacy resolution", async t => {
  const env = await fixture(t);
  const file = healthPreferencesPath(env);
  assert.deepEqual(await readHealthPreferences(env), defaults);
  const value = { awayCheckInMinutes: 1, openNoteAlarmMinutes: 1440 };
  await saveHealthPreferences(env, value);
  assert.deepEqual(await readHealthPreferences(env), value);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const legacy = { FM_AGENTOS_STATE_PATH: env.FM_QUARTERDECK_STATE_PATH };
  assert.equal(healthPreferencesPath(legacy), file);
  assert.deepEqual(await readHealthPreferences(legacy), value);
  assert.throws(() => healthPreferencesPath({ ...env, FM_AGENTOS_STATE_PATH: "/synthetic/other.json" }));
  await writeFile(file, '{malformed');
  assert.deepEqual(await readHealthPreferences(env), defaults);
  await writeFile(file, JSON.stringify({ awayCheckInMinutes: 2, openNoteAlarmMinutes: false }));
  assert.deepEqual(await readHealthPreferences(env), { ...defaults, awayCheckInMinutes: 2 });
  await rm(file); await writeFile(`${file}.target`, JSON.stringify(value));
  await symlink(`${file}.target`, file);
  assert.deepEqual(await readHealthPreferences(env), defaults);
});
test("invalid or extra saved fields are rejected without replacing existing settings", async t => {
  const env = await fixture(t);
  await saveHealthPreferences(env, defaults);
  for (const value of [0, -1, 1441, 1.1, "1", true, null]) {
    assert.equal(validHealthPreferences({ ...defaults, awayCheckInMinutes: value }), false);
    await assert.rejects(saveHealthPreferences(env, { ...defaults, awayCheckInMinutes: value }));
  }
  for (const value of [null, [], {}, { ...defaults, extra: 1 }]) assert.equal(Boolean(validHealthPreferences(value)), false);
  assert.deepEqual(JSON.parse(await readFile(healthPreferencesPath(env))), defaults);
});
test("health preferences API guards writes, validates narrowly, persists across server reload", async t => {
  const env = await fixture(t);
  const revision = "a".repeat(40);
  async function start() {
    const server = createServer(env, { revisionResolver: { initial: revision, snapshot: async () => revision } });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
  }
  const base = await start(); const url = `${base}/api/preferences/health`;
  assert.deepEqual(await (await fetch(url)).json(), defaults);
  const post = (body, origin = base) => fetch(url, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
  assert.equal((await post(defaults, "https://untrusted.invalid")).status, 403);
  assert.equal((await post({ ...defaults, extra: true })).status, 400);
  assert.equal((await post({ ...defaults, openNoteAlarmMinutes: 0 })).status, 400);
  const value = { awayCheckInMinutes: 30, openNoteAlarmMinutes: 5 };
  assert.equal((await post(value)).status, 200);
  assert.deepEqual(await (await fetch(`${await start()}/api/preferences/health`)).json(), value);
  assert.equal((await fetch(`${base}/api/preferences`, { method: "POST" })).status, 404);
});
