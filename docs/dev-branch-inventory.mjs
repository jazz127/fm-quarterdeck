// Read-only inventory. No checkout, ref update, filesystem mutation or push.
import { execFileSync } from "node:child_process";
const output = execFileSync("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/fm"], { encoding: "utf8" });
const rows = output.trim().split("\n").filter(Boolean).map((line) => {
  const [source, sha] = line.split(" ");
  const suffix = source.startsWith("fm/fm-agentos-") ? source.slice("fm/fm-agentos-".length) :
    source.startsWith("fm/agentos-") ? source.slice("fm/".length) : null;
  if (!suffix || !/^[a-z0-9-]+$/.test(suffix) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error(`Unmapped or invalid source: ${source}`);
  return { source, sha, destination: `dev/${suffix}` };
});
const seen = new Set();
for (const row of rows) {
  if (seen.has(row.destination)) throw new Error(`Destination collision: ${row.destination}`);
  seen.add(row.destination);
  console.log(`${row.source}@${row.sha} -> ${row.destination} [source-ref-only; clean state unverified]`);
}
console.error(`${rows.length} refs mapped, zero refs published`);
