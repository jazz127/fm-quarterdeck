import { open, mkdir, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { configuredStatePath } from "./agent-state.js";

export const healthPreferenceDefaults = Object.freeze({ awayCheckInMinutes: 10, openNoteAlarmMinutes: 15 });
export const healthPreferencesPath = (env = {}) => path.join(path.dirname(configuredStatePath(env)), "quarterdeck-preferences.json");
export function validHealthPreferences(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "awayCheckInMinutes,openNoteAlarmMinutes" &&
    Object.keys(healthPreferenceDefaults).every((key) => Number.isInteger(value[key]) && value[key] >= 1 && value[key] <= 1440);
}
export async function readHealthPreferences(env = {}) {
  let handle;
  try {
    handle = await open(healthPreferencesPath(env), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4096) return { ...healthPreferenceDefaults };
    const value = JSON.parse(await handle.readFile("utf8"));
    return Object.fromEntries(Object.entries(healthPreferenceDefaults).map(([key, fallback]) =>
      [key, Number.isInteger(value?.[key]) && value[key] >= 1 && value[key] <= 1440 ? value[key] : fallback]));
  } catch { return { ...healthPreferenceDefaults }; }
  finally { await handle?.close(); }
}
export async function saveHealthPreferences(env, value) {
  if (!validHealthPreferences(value)) throw new Error("Expected two integer minute values from 1 to 1440");
  const file = healthPreferencesPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
    const directory = await open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return value;
  } finally { await unlink(temp).catch(() => {}); }
}
