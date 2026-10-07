import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { emptyAttribution, defaultAttribution, defaultCostConfiguration } from "./cost-config.js";
import { readExpenseOverlay } from "./private-runtime.js";

const exec = promisify(execFile);
const finite = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const iso = (v) => typeof v === "string" && /^\d{4}-\d\d-\d\d(?:T|$)/.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
const label = (v) => typeof v === "string" && /^[\w .:/+-]{1,90}$/.test(v) ? v : "Unclassified";
const safeError = (error, provider) => {
  const diagnostic = `${error?.stderr || ""} ${error?.stdout || ""} ${error?.message || ""}`; // Never return or log raw CLI diagnostics.
  if (provider === "azure" && /AuthorizationFailed|Forbidden|403|CostManagementReader|BillingReader/i.test(diagnostic)) return "Cost Management Reader or Billing Reader required";
  if (provider === "github" && /403|404|FORBIDDEN|NOT_FOUND/i.test(diagnostic)) return "GitHub billing access (Plan: read) required; enhanced billing may be unavailable";
  return `${provider === "azure" ? "Azure Cost Management" : "GitHub billing"} unavailable`;
};

// Cost Management Query column order is not stable. Validate every row before publishing anything.
export function azureRows(raw, dimension = null) {
  const table = raw?.properties;
  if (!Array.isArray(table?.columns) || !Array.isArray(table?.rows) || table.rows.length > 10000 || table.nextLink) throw new Error("schema");
  const columns = table.columns.map((c) => c?.name);
  const cost = columns.indexOf("Cost");
  const currency = columns.indexOf("Currency");
  const group = dimension ? columns.indexOf(dimension) : -1;
  if (cost < 0 || currency < 0 || (dimension && group < 0)) throw new Error("schema");
  return table.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length || typeof row[currency] !== "string" || !/^[A-Z]{3}$/.test(row[currency]) || typeof row[cost] !== "number" || !Number.isFinite(row[cost])) throw new Error("schema");
    return { amount: row[cost], currency: row[currency], ...(dimension ? { name: label(row[group]) } : {}) };
  });
}

const billingBody = (dimension, tag) => ({ type: "ActualCost", timeframe: "MonthToDate", dataset: {
  granularity: "None", aggregation: { totalCost: { name: "Cost", function: "Sum" } },
  ...(dimension ? { grouping: [{ type: dimension === "TagKey" ? "TagKey" : "Dimension", name: dimension === "TagKey" ? tag : dimension }] } : {}),
} });
const period = (now) => ({ start: new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)).toISOString().slice(0, 10), end: new Date(now).toISOString().slice(0, 10), basis: "Month to date (UTC); billing cycle unknown" });
const missing = (reason) => ({ state: "unavailable", reason, capturedAt: null, period: null, actual: null, forecast: null, included: null, billable: null, remaining: null, delayed: "unknown", partial: true, breakdowns: [] });

export function parseAzure(actual, dimensions, capturedAt, tag = null, mapping = defaultAttribution) {
  const rows = azureRows(actual);
  if (rows.length > 1) throw new Error("schema");
  const total = rows[0] || null;
  const breakdowns = [];
  let partial = !total;
  let attribution = emptyAttribution(mapping, total);
  for (const [name, raw] of Object.entries(dimensions)) {
    if (!raw) { partial = true; continue; }
    let items;
    try {
      items = azureRows(raw, name === "TagKey" ? tag : name);
      if (total && items.some((item) => item.currency !== total.currency)) throw new Error("schema");
    } catch { partial = true; continue; }
    if (name === "TagKey" && total) {
      const sum = items.reduce((n, item) => n + item.amount, 0);
      if (Math.abs(sum - total.amount) > 0.01) { partial = true; continue; }
      attribution = emptyAttribution(mapping);
      for (const item of items) {
        const tagValue = item.name.toLowerCase();
        const key = Object.hasOwn(mapping, tagValue) ? mapping[tagValue] : "unclassified";
        attribution[key] = { amount: (attribution[key]?.amount || 0) + item.amount, currency: total.currency };
      }
    } else if (name !== "TagKey") breakdowns.push({ kind: name === "ServiceName" ? "Service" : "Resource group", items: items.slice(0, 30) });
  }
  return { state: total ? partial ? "partial" : "actual" : "partial", reason: null, capturedAt, period: period(capturedAt),
    actual: total, forecast: null, included: null, billable: null, remaining: null, delayed: "unknown", partial,
    attribution, breakdowns };
}

// gh-axi emits a YAML envelope even for templated scalar output. Decode only its
// bounded body scalar; no arbitrary YAML parser or user-supplied template is needed.
function ghBody(output) {
  if (typeof output !== "string" || output.length > 500000) throw new Error("schema");
  const match = /^api_response:\n  body: (.*)\n  truncated: false\s*$/.exec(output.trimEnd());
  if (!match) throw new Error("schema");
  return match[1].startsWith('"') ? JSON.parse(match[1]) : match[1];
}
export function parseGitHub(rows, capturedAt) {
  if (!Array.isArray(rows) || rows.length > 5000) throw new Error("schema");
  const actions = rows.filter((item) => item?.product === "Actions" && item.unitType === "minutes");
  const storageRows = rows.filter((item) => item?.product === "Actions" && /^(gigabyte-hours|GB-hours)$/i.test(item.unitType));
  if (actions.some((item) => finite(item.quantity) === null && finite(item.grossQuantity) === null)) throw new Error("schema");
  const breakdowns = actions.map((item) => ({ sku: label(item.sku), repository: label(item.repositoryName), minutes: finite(item.quantity) ?? finite(item.grossQuantity),
    billableMinutes: finite(item.netQuantity), amount: finite(item.netAmount), currency: "USD" }));
  const sum = (field) => breakdowns.length && breakdowns.every((item) => item[field] !== null) ? breakdowns.reduce((n, item) => n + item[field], 0) : null;
  // A billing discount is not an included minutes allowance. No remaining
  // allowance can be calculated from usage/discount amounts alone.
  return { state: "partial", reason: actions.length ? null : "No Actions minute items reported; usage unknown",
    capturedAt, period: period(capturedAt), actual: { minutes: sum("minutes") }, forecast: null, included: null,
    billable: { minutes: sum("billableMinutes"), amount: sum("amount"), currency: "USD" }, remaining: null,
    storage: storageRows.length && storageRows.every((item) => finite(item.quantity) !== null) ? { quantity: storageRows.reduce((n, item) => n + item.quantity, 0), unit: storageRows[0].unitType } : null,
    resetAt: null, delayed: "unknown", partial: true, breakdowns: breakdowns.slice(0, 40) };
}

// Command output and auth metadata never escape this module. No credential refresh,
// shell interpolation, CLI logging, subscription IDs, or raw error serialization.
const command = (bin, args) => exec(bin, args, { timeout: 12000, maxBuffer: 1024 * 1024, windowsHide: true });
export async function readAzure({ run = command, now = Date.now, tag = process.env.FM_COST_ATTRIBUTION_TAG, mapping = defaultAttribution } = {}) {
  const unavailable = (error) => ({ ...missing(safeError(error, "azure")), attribution: emptyAttribution(mapping) });
  let id;
  try {
    const account = JSON.parse((await run("az", ["account", "show", "-o", "json"])).stdout);
    if (!/^[0-9a-f-]{36}$/i.test(account.id)) throw new Error("schema");
    id = account.id;
  } catch (error) { return unavailable(error); }
  const endpoint = `https://management.azure.com/subscriptions/${id}/providers/Microsoft.CostManagement/query?api-version=2025-03-01`;
  const query = async (dimension) => JSON.parse((await run("az", ["rest", "--method", "post", "--url", endpoint, "--body", JSON.stringify(billingBody(dimension, tag)), "-o", "json"])).stdout);
  try {
    const actual = await query();
    const dimensions = {};
    for (const dimension of ["ServiceName", "ResourceGroupName", ...(/^[A-Za-z][\w-]{0,50}$/.test(tag || "") ? ["TagKey"] : [])]) {
      try { dimensions[dimension] = await query(dimension); } catch { dimensions[dimension] = null; }
    }
    return parseAzure(actual, dimensions, new Date(now()).toISOString(), tag, mapping);
  } catch (error) { return unavailable(error); }
}

const GH_TEMPLATE = '{{range .usageItems}}{{printf "%q|%q|%v|%q|%v|%v|%v|%v|%q\\n" .product .sku .quantity .unitType .grossQuantity .netQuantity .netAmount .grossAmount .repositoryName}}{{end}}';
export async function readGitHub({ run = command, now = Date.now } = {}) {
  try {
    const login = ghBody((await run("gh-axi", ["api", "/user", "--template", "{{.login}}", "--full"])).stdout);
    if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login)) throw new Error("schema");
    const stamp = new Date(now());
    const path = `/users/${login}/settings/billing/usage?year=${stamp.getUTCFullYear()}&month=${stamp.getUTCMonth() + 1}`;
    const text = ghBody((await run("gh-axi", ["api", path, "--template", GH_TEMPLATE, "--full"])).stdout);
    const rows = text ? text.split("\n").filter(Boolean).map((line) => {
      const cells = line.split("|");
      if (cells.length !== 9) throw new Error("schema");
      const string = (s) => JSON.parse(s);
      const num = (s) => s === "<nil>" ? null : Number(s);
      return { product: string(cells[0]), sku: string(cells[1]), quantity: num(cells[2]), unitType: string(cells[3]), grossQuantity: num(cells[4]), netQuantity: num(cells[5]), netAmount: num(cells[6]), grossAmount: num(cells[7]), repositoryName: string(cells[8]) };
    }) : [];
    return parseGitHub(rows, stamp.toISOString());
  } catch (error) { return missing(safeError(error, "github")); }
}

// The selected home's configuration is authoritative, including an explicit null
// tag or empty map. Rebind the bounded provider cache when configuration changes.
export function createConfiguredCostReader(env = {}, { run = command, now = Date.now } = {}) {
  let key; let reader;
  return async () => {
    let config;
    try { config = (await readExpenseOverlay(env))?.costs ?? defaultCostConfiguration(env); }
    catch {
      key = undefined; reader = undefined;
      return { azure: { ...missing("Private expense configuration unavailable"), attribution: { unclassified: null } }, github: missing("Private expense configuration unavailable") };
    }
    const next = JSON.stringify(config);
    if (next !== key) {
      reader = createCostReader({ now, azure: () => readAzure({ run, now, tag: config.azureTag, mapping: config.attribution }), github: () => readGitHub({ run, now }) });
      key = next;
    }
    return reader();
  };
}

export function createCostReader({ azure = readAzure, github = readGitHub, now = Date.now, ttlMs = 300000 } = {}) {
  const sources = { azure, github };
  const cache = new Map();
  const ttl = Math.max(60000, Math.min(900000, ttlMs));
  return async () => {
    const fetchOne = (name) => {
      const old = cache.get(name);
      if (old?.pending) return old.pending;
      if (old && now() < old.next) return Promise.resolve(old.result);
      const pending = Promise.resolve().then(sources[name]).catch(() => missing(`${name} unavailable`)).then((result) => {
        const previous = cache.get(name)?.last;
        const fresh = result.state !== "unavailable";
        const reading = fresh ? { ...result, stale: false, ageMs: 0 } : previous
          ? { ...previous, state: "stale", stale: true, reason: result.reason, ageMs: Math.max(0, now() - Date.parse(previous.capturedAt)) }
          : { ...result, stale: false, ageMs: null };
        cache.set(name, { result: reading, last: fresh ? reading : previous, next: now() + ttl });
        return reading;
      });
      cache.set(name, { ...old, pending });
      return pending;
    };
    const [azureResult, githubResult] = await Promise.all([fetchOne("azure"), fetchOne("github")]);
    return { azure: azureResult, github: githubResult };
  };
}
