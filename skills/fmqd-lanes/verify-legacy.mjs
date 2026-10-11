// Read-only preflight, not an installer or an approval to activate a skill.
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function verifyLegacySkill(directory, expectedSha256) {
  const entry = await lstat(directory); // Do not follow a replaced global entry.
  if (!entry.isDirectory() || entry.isSymbolicLink()) return { ok: false, reason: "legacy entry is not a standalone directory" };
  const names = await readdir(directory);
  if (names.length !== 1 || names[0] !== "SKILL.md") return { ok: false, reason: "legacy directory contents changed" };
  const skillPath = path.join(directory, "SKILL.md");
  const skill = await lstat(skillPath);
  if (!skill.isFile() || skill.isSymbolicLink()) return { ok: false, reason: "legacy skill is not a regular file" };
  const hash = createHash("sha256").update(await readFile(skillPath)).digest("hex");
  return hash === expectedSha256 ? { ok: true, hash } : { ok: false, reason: "legacy skill bytes changed", hash };
}
