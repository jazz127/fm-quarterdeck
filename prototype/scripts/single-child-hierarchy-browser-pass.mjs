// Bounded offline acceptance of actual served renderers and controls, without a live home.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "../server.js";
const root = path.resolve(import.meta.dirname, "../..");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(), "", "serve only a clean exact candidate");
const lab = path.join(root, ".taxonomy-lab/single-child");
await mkdir(lab, { recursive: true });
const env = { ...process.env, HOME: lab, CHROME_DEVTOOLS_AXI_SESSION: `single-child-${process.pid}`, CHROME_DEVTOOLS_AXI_HEADED: "0", CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(lab, `profile-${process.pid}`) };
for (const name of ["CHROME_DEVTOOLS_AXI_AUTO_CONNECT", "CHROME_DEVTOOLS_AXI_BROWSER_URL", "CHROME_DEVTOOLS_AXI_MCP_SERVER_URL"]) delete env[name];
const exec = promisify(execFile);
let browser = async (...args) => (await exec("chrome-devtools-axi", args, { env, timeout: 40000, maxBuffer: 1024 * 1024 })).stdout;
const evaluate = async (js) => {
  const output = await browser("eval", js);
  if (/isError":\s*true|Error:|Exception:/.test(output)) throw Error(output);
  return output;
};
const item = (id, lane, theme, status = "active") => ({ id, name: `Synthetic ${id}`, taskFingerprint: id, repositoryId: "repo", repository: "Fixture repository", lane: { id: lane, name: lane }, theme: { id: theme, name: theme, kind: "theme" }, status, evidence: [], taxonomyOptions: [], chatLaneId: "fixture-lane" });
const items = [item("a", "one", "first"), item("b", "two", "first", "waiting"), item("c", "one", "second", "waiting")];
const fleet = JSON.parse(await readFile(path.join(root, "prototype/data/fleet.json"), "utf8"));
const fleetPath = path.join(lab, "fleet.json");
const fixture = async (selected) => {
  fleet.workSplit = { items: selected };
  await writeFile(fleetPath, JSON.stringify(fleet));
};
await fixture(items);
const server = createServer({ FM_STATUS_PATH: fleetPath }, {
  quotaReader: async () => ({ providers: [], stale: false, error: "Offline fixture" }),
  costReader: async () => ({ azure: { status: "unavailable" }, github: { status: "unavailable" } }),
  lanesReader: async () => ({ lanes: [], transcript: { sessions: [], warnings: [] } }),
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const results = [];
const deadline = setTimeout(() => { console.error("bounded acceptance expired"); process.exit(1); }, 180000);
try {
  const url = `http://127.0.0.1:${server.address().port}/#work`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await browser("open", url); break; }
    catch (error) {
      if (!/target appears to have gone away|Target closed/.test(error.stdout || error.message)) throw error;
      console.log(`Supported browser target loss ${attempt + 1}`);
      if (attempt === 1) {
        await browser("stop").catch(() => {});
        const { isolatedBrowser } = await import("./single-child-browser-fallback.mjs");
        browser = await isolatedBrowser(lab);
        console.log("Using authorized task-isolated Chromium fallback after repeated target loss");
        await browser("open", url);
      }
    }
  }
  await browser("wait", "1000");
  results.push(await evaluate(`fetch('/api/review').then(r=>r.json()).then(r=>{if(r.version!==${JSON.stringify(head)})throw Error('wrong served revision');return r.version})`));
  for (const width of [1440, 390]) {
    await browser("resize", String(width), "900");
    for (const view of ["work"]) {
      const selector = "#tight-work";
      const filters = "#work-phase-buttons";
      await evaluate(`location.hash='#${view}'`);
      await browser("wait", "100");
      for (const [indices, want] of [[[0], "0,0"], [[0, 1], "2,0"], [[0, 2], "0,2"], [[0, 1, 2], "2,2"]]) {
        await fixture(indices.map(i => items[i]));
        await evaluate("document.querySelector('#refresh').click()");
        await browser("wait", "350");
        results.push(await evaluate(`(() => {
          const check=(ok,msg)=>{if(!ok)throw Error(msg)};
          const root=document.querySelector('${selector}');
          const count=[root.querySelectorAll('.taxonomy-lane').length,root.querySelectorAll('.taxonomy-theme').length].join(',');
          check(count==='${want}','sibling counts '+count+' expected ${want}');
          check(root.querySelectorAll('.work-slice').length===${indices.length},'record loss');
          check(root.querySelectorAll('summary').length===${1 + want.split(",").reduce((a, n) => a + Number(n), 0) + indices.length},'duplicate/orphan controls');
          check([...root.querySelectorAll('.taxonomy-items')].every(n=>getComputedStyle(n).marginLeft==='0px'&&getComputedStyle(n).listStyleType==='none'),'blank list indent');
          check(document.documentElement.scrollWidth<=innerWidth,'obstructive overflow');
          return {width:innerWidth,view:'${view}',counts:count};
        })()`));
      }
      await evaluate(`document.querySelector('${selector} [data-tree-key="${view}:repo:one"] > summary').click();document.querySelector('${selector} [data-tree-key="${view}:repo:one:first"] > summary').click()`);
      await browser("wait", "100");
      await evaluate(`document.querySelector('${filters} [data-status-value="active"]').click()`);
      await browser("wait", "100");
      results.push(await evaluate(`(() => {
        const root=document.querySelector('${selector}');
        if(root.querySelector('.taxonomy-lane,.taxonomy-theme'))throw Error('filtered singleton wrapper');
        if(root.querySelector('.work-slice').dataset.taskFingerprint!=='a')throw Error('record identity lost');
        if(root.querySelector('a.crew-task').getAttribute('href')!=='#lanes/fixture-lane/session/a')throw Error('route changed');
        const box=root.querySelector('.work-slice').getBoundingClientRect();
        if(box.width<=0||box.right>innerWidth)throw Error('record obstructed');
        return {width:innerWidth,view:'${view}',recordWidth:box.width};
      })()`));
      await browser("screenshot", path.join(lab, `${width}-${view}.png`));
      await evaluate(`document.querySelector('${filters} [data-status-value="all"]').click()`);
      await browser("wait", "100");
      results.push(await evaluate(`(() => {
        const root=document.querySelector('${selector}');
        for(const key of ['${view}:repo:one','${view}:repo:one:first'])if(root.querySelector('[data-tree-key="'+key+'"]').open)throw Error('lost collapse state');
        return {width:innerWidth,view:'${view}',collapseRestored:true};
      })()`));
      // Leave both scopes expanded before exercising the next viewport.
      await evaluate(`document.querySelector('${selector} [data-tree-key="${view}:repo:one"] > summary').click();document.querySelector('${selector} [data-tree-key="${view}:repo:one:first"] > summary').click()`);
      await browser("wait", "100");
    }
  }
  await writeFile(path.join(lab, "acceptance.json"), JSON.stringify({ head, results }, null, 2));
  console.log(`PASS desktop/phone exact revision ${head}`);
} finally {
  clearTimeout(deadline);
  await browser("stop").catch(() => {});
  await new Promise(resolve => server.close(resolve));
}
