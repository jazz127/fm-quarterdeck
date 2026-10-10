import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createServer } from "../server.js";
import { createAgentStateOwner, emptyAgentState, fingerprint } from "../agent-state.js";
import { verifyDurability } from "../work-model.js";
import { sanitizeQuota } from "../quota.js";
import { captureKpiGeometry, inspectKpiGeometry } from "./kpi-geometry.mjs";

export async function acceptance({ cmd, evaluate, until, wait, lab, head }) {
  const home = path.join(lab, "browser-home"), repoPath = path.join(lab, "synthetic-repository"), statePath = path.join(lab, "browser-state.json");
  await mkdir(path.join(home, "data"), { recursive: true }); await mkdir(path.join(home, "state/branch-session"), { recursive: true });
  const definitions = [["executing", "working"], ["wait", "paused"], ["decision", "needs-decision"], ["retained", "preserved"], ["dead", "working"], ["ready", "done"], ["remote-main", "done", "a"], ["remote-uat", "done", "b"], ["merged", "done", "c"], ["uat-live", "done", "d"], ["production-live", "done", "e"]];
  await writeFile(path.join(home, "data/projects.md"), `- synthetic-repository - Browser fixture work\n`);
  await writeFile(path.join(home, "data/backlog.md"), `## In flight\n${definitions.map(([id]) => `- [ ] ${id} - ${id} implementation slice (repo: ${repoPath})`).join("\n")}\n## Queued\n- [ ] legacy-unknown - Unclassified repository\n`);
  const stat = await readFile(`/proc/${process.pid}/stat`, "utf8"); const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  for (const [id, state, commit] of definitions) {
    await writeFile(path.join(home, "state", `${id}.status`), `${state} [at=1]: fixture recorded outcome\n`);
    await writeFile(path.join(home, "state", `${id}.meta`), `project=${repoPath}\n${id === "executing" ? `worker_pid=${process.pid}\nworker_start_ticks=${ticks}\nworker_boot_id=${boot}\n` : id === "dead" ? `worker_pid=${process.pid}\nworker_start_ticks=1\nworker_boot_id=${boot}\n` : ""}${commit ? `completion_commit=${commit.repeat(40)}\n` : ""}${id === "merged" ? "pull_request=1\n" : ""}`);
  }
  const state = { ...emptyAgentState(), repositories: [{ id: "product", name: "Product repository", path: repoPath, github: "fixture/product", destinations: [{ environment: "UAT", tier: "uat" }, { environment: "Production", tier: "production" }], lanes: [{ id: "ui", name: "Interface workstream", themes: [{ id: "iteration", name: "Review iteration", kind: "iteration" }] }] }] };
  state.completionRecords = {};
  for (const [id, sourceState, commit] of definitions) {
    const taskFingerprint = fingerprint("task.v1", repoPath, id);
    state.assignments[taskFingerprint] = { repositoryId: "product", laneId: "ui", themeId: "iteration" };
    if (commit) {
      const completionIdentity = { source: "status", line: `${sourceState} [at=1]: fixture recorded outcome`, occurrence: 0, doneDate: null };
      state.completionRecords[fingerprint("completion-source.v1", taskFingerprint, completionIdentity)] = { taskFingerprint, commit: commit.repeat(40), ...(id === "merged" ? { pullRequest: 1 } : {}) };
    }
  }
  await createAgentStateOwner(statePath).update((saved) => Object.assign(saved, state));
  await writeFile(path.join(home, "state/branch-session/fixture.jsonl"), JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: `[fm-lane synthetic-repository]\nFixture prose readable on desktop.\n\n\`\`\`text\n${"structured-evidence ".repeat(120)}\n\`\`\`\n[end synthetic-repository]` }] } }) + "\n");
  const mockAuthority = async (command, args) => {
    if (command === "git" && args[0] === "ls-remote") return { stdout: `${args.at(-1).endsWith("/main") ? "f".repeat(40) : "0".repeat(40)}\t${args.at(-1)}\n` };
    if (command === "git") { if ((args[2] === "a".repeat(40) && args[3] === "f".repeat(40)) || (args[2] === "b".repeat(40) && args[3] === "0".repeat(40))) return { stdout: "" }; throw new Error("Fixture not contained"); }
    if (args[1].includes("/pulls/")) return { stdout: JSON.stringify({ merged: true, merged_at: "2030-01-01T00:00:00Z", merge_commit_sha: "c".repeat(40), base: { repo: { full_name: "fixture/product" }, ref: "main" }, html_url: "https://github.com/fixture/product/pull/1" }) };
    if (args[1].includes("/deployments?")) { const production = args[1].includes("environment=Production"); return { stdout: JSON.stringify([{ id: production ? 2 : 1, sha: (production ? "e" : "d").repeat(40), environment: production ? "Production" : "UAT" }]) }; }
    return { stdout: JSON.stringify([{ id: 10, state: "success", environment: args[1].includes("/1/") ? "UAT" : "Production" }]) };
  };
  const deliveries = [];
  const windows = [ { id: "week", label: "Week", kind: "weekly", percentRemaining: 35, resetsAt: new Date(Date.now() + 8 * 3600000 + 20 * 60000).toISOString() }, { id: "long", label: "An exceptionally long quota bucket descriptor", kind: "daily", percentRemaining: 80, resetsAt: new Date(Date.now() + 35 * 60000).toISOString() }, { id: "days", label: "Multi-day", kind: "weekly", percentRemaining: 50, resetsAt: new Date(Date.now() + 3 * 86400000).toISOString() } ];
  const server = createServer({ FM_HOME: home, FM_QUARTERDECK_STATE_PATH: statePath, FM_DEPLOYMENT_TIER: "uat" }, {
    previewRegistry: [{ id: "uat", name: "UAT", branch: "uat", commit: head, remoteCheckpoint: null, validation: "captured" }],
    durabilityVerifier: (repo, commit, pr) => verifyDurability(repo, commit, pr, mockAuthority),
    quotaReader: async () => ({ readAt: new Date().toISOString(), stale: false, error: null, providers: sanitizeQuota({ schemaVersion: 5, providers: [{ provider: "codex", state: { status: "fresh", authStatus: "usable" }, windows, quotaSemantics: { status: "known", effectiveAvailability: [{ scope: "all_models", status: "known", effectivePercentRemaining: 35, boundedBy: ["week", "long", "days"], limitingWindowIds: ["week"] }] } }] }) }),
    costReader: async () => ({ azure: { status: "unavailable", error: "Synthetic fixture" }, github: { status: "unavailable", error: "Synthetic fixture" } }),
    chatDeliver: async (message) => { deliveries.push(message); return { receiptId: "fixture-primary" }; },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/preview/uat/`;
  const results = [];
  try {
    for (const width of [1920, 1440, 834, 390, 320]) {
      await cmd("Emulation.setDeviceMetricsOverride", { width, height: width <= 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width <= 390 });
      for (const view of ["work"]) {
        await cmd("Page.navigate", { url: `${url}#${view}` });
        await until("Boolean(document.querySelector('#tight-work .taxonomy-theme'))");
        assert.equal(await evaluate("fetch('/api/review').then(r=>r.json()).then(r=>r.version)"), head);
        const root = "#tight-work";
        const values = await evaluate(`(() => { const root=document.querySelector('${root}'); const rows=[...root.querySelectorAll('[data-task-fingerprint]')]; const kpis=[...document.querySelectorAll('#summary .metric-card')].map(n=>n.getBoundingClientRect().toJSON()); return { rows:rows.length, unique:new Set(rows.map(n=>n.dataset.taskFingerprint)).size, active:rows.filter(n=>n.dataset.status==='active').length, previous:rows.filter(n=>n.dataset.status==='previously-done').length, newly:rows.filter(n=>n.dataset.status==='newly-done').length, hierarchy:root.querySelectorAll('.taxonomy-repository .taxonomy-lane .taxonomy-theme').length, overflow:document.documentElement.scrollWidth>innerWidth, kpis, text:root.innerText }; })()`);
        assert.equal(values.rows, 12); assert.equal(values.unique, 12); assert.equal(values.active, 1); assert.equal(values.previous, 5); assert.equal(values.newly, 1); assert.ok(values.hierarchy >= 2); assert.equal(values.overflow, false);
        for (const label of ["Interface workstream", "Review iteration", "remote Main", "remote UAT", "merged PR", "Live UAT · ready for review", "Live production", "Repository unknown"]) assert.ok(values.text.includes(label), label);
        if (width <= 390) {
          const diagnostic = { head, requestedWidth: width, view, ...await evaluate(`(${captureKpiGeometry.toString()})()`) };
          const geometry = inspectKpiGeometry(diagnostic);
          await writeFile(path.join(lab, `kpi-${width}-${view}.json`), JSON.stringify({ diagnostic, geometry }, null, 2));
          assert.equal(diagnostic.viewport.width, width, JSON.stringify(diagnostic));
          assert.equal(geometry.applicable, view === "overview", JSON.stringify(diagnostic));
          assert.deepEqual(geometry.failures, [], JSON.stringify(diagnostic));
        }
        const expansion = await evaluate(`(() => { const detail=document.querySelector('${root} .taxonomy-repository'); detail.querySelector('summary').click(); const closed=!detail.open; detail.querySelector('summary').click(); return closed && detail.open; })()`); assert.equal(expansion, true);
        results.push({ width, view, rows: values.rows, active: values.active });
      }
      await evaluate("location.hash='#lanes'"); await until("Boolean(document.querySelector('#messages .message-content pre'))");
      assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth"), false);
      if (width > 1200) {
        const initial = await evaluate("Number(document.querySelector('#shell-panel-resize').getAttribute('aria-valuenow'))");
        const edge = await evaluate("document.querySelector('#shell-panel-resize').getBoundingClientRect().toJSON()");
        assert.equal(await evaluate("document.querySelector('#shell-panel-toggle').hidden"), true);
        assert.equal(edge.width, 24);
        const x = edge.right - 5, y = edge.top + edge.height / 2;
        for (const type of ["mousePressed", "mouseReleased"]) await cmd("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
        assert.equal(await evaluate("document.querySelector('.workspace').dataset.shellPanelCollapsed"), "true");
        await evaluate("document.querySelector('#shell-panel-resize').focus()");
        await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" }); await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
        assert.equal(await evaluate("Number(document.querySelector('#shell-panel-resize').getAttribute('aria-valuenow'))"), initial);
        await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 60, y, button: "left", buttons: 1 });
        await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 60, y, button: "left", clickCount: 1 });
        assert.equal(await evaluate("document.querySelector('.workspace').dataset.shellPanelCollapsed"), "false");
        assert.equal(await evaluate("Number(document.querySelector('#shell-panel-resize').getAttribute('aria-valuenow'))"), initial + 60);
        for (const key of ["ArrowLeft", "ArrowRight", "Home"]) { await evaluate(`document.querySelector('#shell-panel-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'${key}',bubbles:true}))`); }
        for (const size of [220, 440]) {
          await evaluate(`document.querySelector('#shell-panel-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})); for(let i=0;i<20;i++) document.querySelector('#shell-panel-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'${size === 220 ? "ArrowLeft" : "ArrowRight"}',bubbles:true}));`);
          const bounds = await evaluate(`(() => { const message=document.querySelector('#messages article.message'); const pane=document.querySelector('#messages').getBoundingClientRect(); const r=message.getBoundingClientRect(); const footer=document.querySelector('#desktop-review-footer').getBoundingClientRect(); const main=document.querySelector('.main-stage').getBoundingClientRect(); return {overflow:document.documentElement.scrollWidth>innerWidth, article:r.width,pane:pane.width, footerLeft:footer.left,mainLeft:main.left, quota:document.querySelector('#sidebar-quota').innerText}; })()`);
          assert.equal(bounds.overflow, false); assert.ok(bounds.article >= bounds.pane - 80, "desktop articles use available width"); assert.equal(bounds.footerLeft, bounds.mainLeft);
          assert.doesNotMatch(bounds.quota, /tick marks time left|time left at source read/);
        }
      }
    }
    await cmd("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cmd("Page.navigate", { url: `${url}#work` }); await until("Boolean(document.querySelector('#tight-work [data-ack-task]'))");
    await evaluate("document.querySelector('#tight-work [data-ack-task]').click()");
    await until("!document.querySelector('#tight-work [data-ack-task]') && document.querySelector('#tight-work').innerText.includes('acknowledged')");
    await cmd("Page.reload"); await until("document.querySelector('#tight-work')?.innerText.includes('acknowledged')");
    assert.equal(await evaluate("[...document.querySelectorAll('#tight-work [data-status]')].filter(n=>n.dataset.status==='previously-done').length"), 6);
    await writeFile(path.join(home, "state/ready.status"), "done [at=1]: fixture recorded outcome\nworking [at=2]: renewed\ndone [at=3]: second completion\n");
    await evaluate("document.querySelector('#refresh').click()"); await until("Boolean(document.querySelector('#tight-work [data-ack-task]'))");
    const taskSelector = `#tight-work .work-slice[data-task-fingerprint="${fingerprint("task.v1", repoPath, "ready")}"] a.crew-task`;
    await evaluate("location.hash='#work'"); await until(`Boolean(document.querySelector(${JSON.stringify(taskSelector)}))`);
    const target = await evaluate(`(() => { const href=document.querySelector(${JSON.stringify(taskSelector)}).getAttribute('href'); const parts=href.slice(1).split('/'); return { href, laneId:decodeURIComponent(parts[1]), taskId:decodeURIComponent(parts[3] || ''), kind:parts[2] }; })()`);
    assert.equal(target.kind, "session"); assert.equal(target.taskId, "ready");
    await evaluate(`document.querySelector(${JSON.stringify(taskSelector)}).click()`);
    await until(`location.hash===${JSON.stringify(target.href)} && document.querySelector('#conversations-view').classList.contains('active') && [...document.querySelectorAll('#session-history-list .session-row.active')].some(row=>row.dataset.sessionId===${JSON.stringify(target.taskId)} && row.dataset.laneId===${JSON.stringify(target.laneId)})`);
    assert.equal(await evaluate("document.querySelector('#task-filter-id').textContent"), target.taskId);
    assert.ok((await evaluate("document.querySelector('#conversation-subtext').textContent")).endsWith(target.taskId.slice(0, 24)));
    assert.equal(await evaluate("document.querySelector('.preview-chat textarea').placeholder"), "Message firstmate");
    const selected = await evaluate("fetch('/api/previews').then(r=>r.json()).then(r=>r.find(x=>x.id==='uat'))");
    await evaluate(`fetch('/preview/uat/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({schema:'fm-agentos-chat.v1',messageId:crypto.randomUUID(),route:location.hash,text:'Fixture primary-only routing',viewContext:window.fmChatViewContext({branch:'uat',commit:'${head}'})})}).then(r=>{if(!r.ok)throw new Error('chat '+r.status);return r.json()})`);
    assert.equal(deliveries.at(-1).destination, "primary-firstmate");
    return { results, acknowledgement: "persisted and renewed", delivery: "synthetic authoritative fixtures only", chat: "primary-firstmate", selected: selected.id };
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(home, { recursive: true, force: true }); }
}
