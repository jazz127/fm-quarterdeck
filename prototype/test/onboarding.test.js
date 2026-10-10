import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { BASE_PREFERENCES, CURRENT_VERSION, OWNED_VERSIONS, ownedBlock, preferencePlan, previewOnboarding, applyOnboarding } from "../onboarding.js";
import { parsePreferences } from "../preferences.js";
import { parseArgs, runOnboarding } from "../scripts/onboard.mjs";

const fixtureRoot = fileURLToPath(new URL("../data/", import.meta.url));
function fixture(t, content) {
  // Task-isolated repository fixtures only; never an installed home or /tmp.
  const root = fs.mkdtempSync(path.join(fixtureRoot, "onboarding-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.mkdirSync(path.join(home, "state"));
  fs.writeFileSync(path.join(home, "data/projects.md"), "# Projects\n");
  const captain = path.join(home, "data/captain.md");
  if (content !== undefined) fs.writeFileSync(captain, content);
  return { root, home, captain };
}
function seed(home, options) {
  const preview = previewOnboarding(home, options);
  return applyOnboarding(preview, `${options?.remove ? "remove" : "seed"} ${home}`);
}

test("absent captain: preview is read-only, safe creation, idempotence, Preferences visibility", (t) => {
  const { home, captain } = fixture(t);
  const preview = previewOnboarding(home);
  assert.equal(fs.existsSync(captain), false);
  assert.deepEqual(fs.readdirSync(path.join(home, "data")), ["projects.md"]);
  assert.equal(preview.action, "seed");
  assert.equal(applyOnboarding(preview, `seed ${home}`).changed, true);
  const bytes = fs.readFileSync(captain, "utf8");
  assert.equal(bytes, ownedBlock(CURRENT_VERSION, BASE_PREFERENCES));
  assert.equal(fs.statSync(captain).mode & 0o777, 0o600);
  const inode = fs.statSync(captain).ino;
  assert.equal(seed(home).changed, false);
  assert.equal(fs.statSync(captain).ino, inode);
  assert.equal(parsePreferences(bytes).entries[0].title, "Quarterdeck base skill preferences");
  assert.equal(seed(home, { remove: true }).changed, true);
  assert.equal(fs.readFileSync(captain, "utf8"), "");
  assert.equal(seed(home, { remove: true }).changed, false);
});

test("existing user bytes, BOM, CRLF, no trailing newline, mode and suffix survive seed/removal", (t) => {
  const user = "\uFEFF# Working preferences\r\n## Mine\r\nMy decisions win. No automatic review.";
  const { home, captain } = fixture(t, user);
  fs.chmodSync(captain, 0o640);
  seed(home);
  assert.equal(fs.readFileSync(captain, "utf8"), user + ownedBlock(CURRENT_VERSION, BASE_PREFERENCES));
  assert.equal(fs.statSync(captain).mode & 0o777, 0o640);
  const suffix = "\n## Later user entry\nKeep this too.\n";
  fs.appendFileSync(captain, suffix);
  assert.equal(seed(home).changed, false);
  seed(home, { remove: true });
  assert.deepEqual(fs.readFileSync(captain), Buffer.from(user + suffix));
});

test("owned-block upgrade requires exact recognized historical template and preserves both sides", () => {
  // Simulate a next release retaining current defaults in its catalog. No fictional historical
  // preference is accepted by the production catalog.
  const nextBody = BASE_PREFERENCES + "\nFuture reviewed default.\n";
  const nextVersion = CURRENT_VERSION + 1;
  const versions = { ...OWNED_VERSIONS, [nextVersion]: nextBody };
  const input = "Before\n" + ownedBlock(CURRENT_VERSION, BASE_PREFERENCES) + "After\n";
  const plan = preferencePlan(input, { versions, currentVersion: nextVersion });
  assert.equal(plan.next, "Before\n" + ownedBlock(nextVersion, nextBody) + "After\n");
  assert.equal(preferencePlan(plan.next, { versions, currentVersion: nextVersion }).changed, false);
  assert.equal(preferencePlan(plan.next, { versions, currentVersion: nextVersion, remove: true }).next, "Before\nAfter\n");
  assert.throws(() => preferencePlan(plan.next), /unrecognized/);
});

test("Quarterdeck upgrades or removes shipped v1 preferences without changing user bytes", (t) => {
  const prefix = "\uFEFFUser choices\r\nNo global projection.";
  const suffix = "\r\nUser suffix without trailing newline";
  const legacy = ownedBlock(1, OWNED_VERSIONS[1]);
  const { home, captain } = fixture(t, prefix + legacy + suffix);
  const preview = previewOnboarding(home);
  assert.equal(preview.action, "update");
  assert.equal(fs.readFileSync(captain, "utf8"), prefix + legacy + suffix);
  assert.equal(preferencePlan(prefix + legacy + suffix, { remove: true }).next, prefix + suffix);
  applyOnboarding(preview, `seed ${home}`);
  assert.equal(fs.readFileSync(captain, "utf8"), prefix + ownedBlock(CURRENT_VERSION, BASE_PREFERENCES) + suffix);
  assert.equal(seed(home).changed, false);
  seed(home, { remove: true });
  assert.equal(fs.readFileSync(captain, "utf8"), prefix + suffix);
  assert.throws(() => preferencePlan(prefix + legacy.replace("AgentOS base", "Edited base") + suffix), /edited|unrecognized/);
});

test("skill prefix v3 retains shipped preference bytes and upgrades/removes intact v2 blocks", (t) => {
  assert.equal(CURRENT_VERSION, 3);
  const hashes = {
    1: "78911b668327b6f4a6b2551348c151989440585b1c8759ca23c322ddcbe55020",
    2: "06dc37a913a5a8d9a21987b94a8ff4c75917817f1672770824cd6f1ae26cb66c",
  };
  for (const [version, hash] of Object.entries(hashes)) assert.equal(createHash("sha256").update(OWNED_VERSIONS[version]).digest("hex"), hash);
  const legacy = ownedBlock(2, OWNED_VERSIONS[2]);
  const prefix = "User choices\r\n", suffix = "\nUser suffix";
  const { home, captain } = fixture(t, prefix + legacy + suffix);
  assert.equal(preferencePlan(prefix + legacy + suffix, { remove: true }).next, prefix + suffix);
  seed(home);
  assert.equal(fs.readFileSync(captain, "utf8"), prefix + ownedBlock(CURRENT_VERSION, BASE_PREFERENCES) + suffix);
  for (const name of ["lanes", "toolcheck", "quartermaster"]) {
    assert.ok(BASE_PREFERENCES.includes(`/fmqd-${name}`));
    assert.ok(!BASE_PREFERENCES.includes(`/fm-${name}`));
  }
  seed(home, { remove: true });
  assert.equal(fs.readFileSync(captain, "utf8"), prefix + suffix);
});

test("malformed, duplicate, edited, unknown or hash-spoofed markers refuse seed and removal", (t) => {
  const block = ownedBlock(CURRENT_VERSION, BASE_PREFERENCES);
  const invalid = [
    "<!-- fm-agentos-preferences:begin -->", block + block,
    block.replace(":end", ":finish"), block.replace(`v${CURRENT_VERSION} sha256`, "v99 sha256"),
    block.replace("User-authored", "Changed"), ownedBlock(1, "Edited but rehashed.\n"),
    block.replaceAll("\n", "\r\n"), block.trimEnd(),
  ];
  for (const content of invalid) {
    const { home, captain } = fixture(t, "User\n" + content);
    for (const remove of [false, true]) assert.throws(() => previewOnboarding(home, { remove }), /Malformed|ambiguous|edited|unrecognized/);
    assert.equal(fs.readFileSync(captain, "utf8"), "User\n" + content);
  }
});

test("confirmation binds exact home and operation; preview and cancellation never write", async (t) => {
  const { home, captain } = fixture(t, "My custom text");
  const output = [];
  const question = async () => { throw new Error("No prompt expected"); };
  await runOnboarding({ home, preview: true }, { env: {}, question, output: (s) => output.push(s) });
  assert.match(output.join("\n"), /skills\/fmqd-lanes.*skills\/fmqd-toolcheck.*skills\/fmqd-quartermaster/);
  assert.doesNotMatch(output.join("\n"), /My custom text/);
  assert.match(output.join("\n"), /nothing written or bound/);
  for (const confirmation of ["", "yes", `seed ${home}-other`, `remove ${home}`]) {
    assert.throws(() => applyOnboarding(previewOnboarding(home), confirmation), /Confirmation/);
  }
  await assert.rejects(runOnboarding({ home }, { env: {}, question: async () => "no", output: () => {} }), /Confirmation/);
  assert.equal(fs.readFileSync(captain, "utf8"), "My custom text");
  assert.deepEqual(fs.readdirSync(path.join(home, "data")).sort(), ["captain.md", "projects.md"]);
});

test("interactive selection supplies one authoritative startup binding without another ledger", async (t) => {
  const { home } = fixture(t);
  const answers = [home, `seed ${home}`];
  const output = [];
  await runOnboarding({}, { env: {}, question: async () => answers.shift(), output: (s) => output.push(s) });
  assert.equal(answers.length, 0);
  assert.match(output.join("\n"), /FM_HOME='.*' npm start/);
  assert.deepEqual(fs.readdirSync(path.join(home, "data")).sort(), ["captain.md", "projects.md"]);
});

test("relative, root, unnormalized and non-home paths are refused; wrong authority is checked before reading", (t) => {
  const { home, root } = fixture(t);
  for (const selected of ["relative/home", "/", `${home}/`, `${home}/../home`, root]) assert.throws(() => previewOnboarding(selected));
  assert.throws(() => previewOnboarding("/not-inspected-or-created/other-home", { authoritativeHome: home }), /differs from authoritative/);
  assert.throws(() => previewOnboarding(home, { authoritativeHome: `${home}-other` }), /differs from authoritative/);
  assert.doesNotThrow(() => previewOnboarding(home, { authoritativeHome: home }));
});

test("home, ancestor, data, state, projects and captain symlinks and hard links are refused", (t) => {
  const { root, home, captain } = fixture(t, "user");
  const alias = path.join(root, "alias");
  fs.symlinkSync(home, alias);
  assert.throws(() => previewOnboarding(alias), /symlink/);
  assert.throws(() => previewOnboarding(path.join(alias, "data")), /symlink/);
  for (const name of ["data", "state", "data/projects.md", "data/captain.md"]) {
    const original = path.join(home, name);
    fs.renameSync(original, `${original}.real`);
    fs.symlinkSync(`${original}.real`, original);
    assert.throws(() => previewOnboarding(home), /symlink/);
    fs.unlinkSync(original);
    fs.renameSync(`${original}.real`, original);
  }
  fs.linkSync(captain, path.join(root, "hardlink"));
  assert.throws(() => previewOnboarding(home), /hard-linked/);
});

test("changed snapshots, replaced parents, symlink races and concurrent locks are refused", (t) => {
  const { home, captain } = fixture(t, "user");
  const stale = previewOnboarding(home);
  fs.writeFileSync(captain, "changed by editor");
  assert.throws(() => applyOnboarding(stale, `seed ${home}`), /changed since preview/);
  assert.equal(fs.readFileSync(captain, "utf8"), "changed by editor");
  const lock = path.join(home, "data/.agentos-preferences.lock");
  const current = previewOnboarding(home);
  fs.writeFileSync(lock, "existing writer");
  assert.throws(() => applyOnboarding(current, `seed ${home}`));
  // A fresh snapshot sees the lock; O_EXCL is still mandatory, never stale recovery.
  assert.throws(() => seed(home), /EEXIST/);
  assert.equal(fs.readFileSync(lock, "utf8"), "existing writer");
  fs.unlinkSync(lock);
  const beforeSwap = previewOnboarding(home);
  fs.renameSync(path.join(home, "data"), path.join(home, "old-data"));
  fs.mkdirSync(path.join(home, "data"));
  fs.writeFileSync(path.join(home, "data/projects.md"), "# Projects\n");
  assert.throws(() => applyOnboarding(beforeSwap, `seed ${home}`), /changed since preview/);
  fs.symlinkSync(path.join(home, "old-data/captain.md"), captain);
  assert.throws(() => seed(home), /symlink/);
  assert.equal(fs.readFileSync(path.join(home, "old-data/captain.md"), "utf8"), "changed by editor");
});

test("replacement during staging is refused; cleanup stays in the pinned directory", (t) => {
  const { home, captain } = fixture(t, "user before");
  const preview = previewOnboarding(home);
  const original = fs.fsyncSync;
  let replaced = false;
  fs.fsyncSync = (fd) => {
    original(fd);
    if (!replaced) {
      replaced = true;
      fs.writeFileSync(captain, "concurrent winner");
    }
  };
  try { assert.throws(() => applyOnboarding(preview, `seed ${home}`), /Unsafe concurrent replacement/); }
  finally { fs.fsyncSync = original; }
  assert.equal(fs.readFileSync(captain, "utf8"), "concurrent winner");
  assert.deepEqual(fs.readdirSync(path.join(home, "data")).sort(), ["captain.md", "projects.md"]);

  const moved = path.join(home, "moved-data");
  const other = path.join(home, "other-data");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "captain.md"), "other home must not be touched");
  fs.writeFileSync(path.join(other, "projects.md"), "# Projects\n");
  const next = previewOnboarding(home);
  fs.fsyncSync = (fd) => {
    original(fd);
    fs.renameSync(path.join(home, "data"), moved);
    fs.symlinkSync(other, path.join(home, "data"));
  };
  try { assert.throws(() => applyOnboarding(next, `seed ${home}`), /symlink/); }
  finally { fs.fsyncSync = original; }
  assert.equal(fs.readFileSync(path.join(other, "captain.md"), "utf8"), "other home must not be touched");
  assert.deepEqual(fs.readdirSync(other).sort(), ["captain.md", "projects.md"]);
  assert.deepEqual(fs.readdirSync(moved).sort(), ["captain.md", "projects.md"]);
});

test("absent publication is atomic no-clobber even after its final snapshot", (t) => {
  const { home, captain } = fixture(t);
  const preview = previewOnboarding(home);
  const original = fs.linkSync;
  fs.linkSync = (from, to) => {
    fs.writeFileSync(captain, "late concurrent winner");
    return original(from, to);
  };
  try { assert.throws(() => applyOnboarding(preview, `seed ${home}`), /EEXIST/); }
  finally { fs.linkSync = original; }
  assert.equal(fs.readFileSync(captain, "utf8"), "late concurrent winner");
  assert.deepEqual(fs.readdirSync(path.join(home, "data")).sort(), ["captain.md", "projects.md"]);
});

test("absent-file race, unreadable encoding, NUL, oversized and nonregular records fail closed", (t) => {
  const { home, captain } = fixture(t);
  const preview = previewOnboarding(home);
  fs.writeFileSync(captain, "another writer won");
  assert.throws(() => applyOnboarding(preview, `seed ${home}`), /changed since preview/);
  for (const bytes of [Buffer.from([0xff]), Buffer.from("bad\0record"), Buffer.alloc(128 * 1024 + 1, 65)]) {
    fs.writeFileSync(captain, bytes);
    assert.throws(() => previewOnboarding(home));
    assert.deepEqual(fs.readFileSync(captain), bytes);
  }
  fs.unlinkSync(captain);
  fs.mkdirSync(captain);
  assert.throws(() => previewOnboarding(home), /unexpected path type/);
});

test("Quartermaster defaults preserve activation, cross-lane cohort and authority semantics", () => {
  for (const phrase of ["recurring failures", "regressions", "changed assumptions", "expanding machinery", "evidence-neutral retries", "material resource exposure", "labeled and unlabeled", "across lanes/epics", "individual workers are not automatic causal boundaries", "advisory", "then stops", "not a daemon, hook, scheduler", "User-authored preferences", "merges, signing, deployment, package execution, cloud mutation, cleanup"]) assert.ok(BASE_PREFERENCES.includes(phrase), phrase);
  assert.equal(parsePreferences(ownedBlock(CURRENT_VERSION, BASE_PREFERENCES)).withheld, 0);
  assert.doesNotMatch(BASE_PREFERENCES, /\/home\/|\/Users\/|api_key|password:|## Establish the review cohort/);
});

test("CLI requires deliberate interaction; noninteractive preview and help errors cannot write", (t) => {
  const { home, captain } = fixture(t);
  const script = fileURLToPath(new URL("../scripts/onboard.mjs", import.meta.url));
  const options = { env: { ...process.env, FM_HOME: home }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] };
  assert.match(execFileSync(process.execPath, [script, "--home", home, "--preview"], options), /Preview only/);
  assert.throws(() => execFileSync(process.execPath, [script, "--home", home], options), /interactive terminal/);
  assert.throws(() => parseArgs(["--yes"]), /No unattended/);
  assert.throws(() => parseArgs(["--home"]), /Usage/);
  assert.equal(fs.existsSync(captain), false);
});
