// Expense ledger rollups: exact BigInt cents, readable labels and the public/private/demo ledger selection.
// Currencies are never converted or combined; billing snapshots live in costs.js and are never added here.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readExpenseOverlay } from "./private-runtime.js";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEMO_LEDGER_PATH = path.join(APP_DIR, "data", "demo-ledger.json");
const CANONICAL_LEDGER_PATH = path.resolve(APP_DIR, "..", "expenses", "ledger.json");

function parseCents(amount) {
  if (typeof amount !== "string" || !/^-?\d+\.\d{2}$/.test(amount)) {
    throw new Error(`invalid ledger amount: ${amount}`);
  }
  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;
  const [units, decimals] = unsigned.split(".");
  const cents = BigInt(units) * 100n + BigInt(decimals);
  return negative ? -cents : cents;
}

function formatCents(cents) {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function displayLabel(value) {
  const titleWord = (word) => {
    const upper = word.toUpperCase();
    return ["AI", "API", "DNS", "SaaS"].includes(upper) ? upper : word[0].toUpperCase() + word.slice(1).toLowerCase();
  };
  return String(value).trim().split(/[-_\s]+/).filter(Boolean)
    .map((word) => word.split("/").map(titleWord).join("/"))
    .join(" ");
}

function expenseCategory(entry) {
  if (typeof entry.category === "string" && entry.category.trim()) return displayLabel(entry.category);
  const text = `${entry.project_id || ""} ${entry.project_name || ""} ${entry.description || ""} ${entry.note || ""}`.toLowerCase();
  if (typeof entry.amount === "string" && entry.amount.startsWith("-")) return "Credits";
  if (/\b(hosting|cloudflare)\b/.test(text)) return "Hosting";
  if (/\b(domain|dns|porkbun|registrar)\b/.test(text)) return "Domains & DNS";
  if (/\b(model|openai|codex|xai|google ai|anthropic)\b/.test(text)) return "AI & model services";
  if (/\bgithub\b/.test(text) || (/\bartifact signing\b/.test(text) && !/\busage beyond\b/.test(text))) return "Developer tools";
  if (/\b(azure|aws|gcp|cloud usage)\b/.test(text)) return "Cloud services";
  if (/\b(m365|microsoft 365|software|subscription|saas)\b/.test(text)) return "Software subscriptions";
  return "Uncategorized";
}

function expenseDescription(entry) {
  const description = entry.description || entry.note || "No description provided";
  return typeof description === "string" ? description.replace(/^\[[^\]]+\]\s*/, "") : String(description);
}

function expenseConfidence(entry) {
  if (entry.confidence !== undefined && entry.confidence !== null && String(entry.confidence).trim()) return displayLabel(entry.confidence);
  const tag = typeof entry.note === "string" ? entry.note.match(/^\[([^\]]+)\]/)?.[1] : null;
  return tag ? displayLabel(tag) : null;
}

export function rollupLedger(ledger) {
  if (!ledger || !Array.isArray(ledger.entries) || typeof ledger.default_currency !== "string" || !ledger.default_currency) {
    throw new Error("ledger must include default_currency and an entries array");
  }

  const overall = ledger.entries.length === 0 ? new Map([[ledger.default_currency, 0n]]) : new Map();
  const projects = new Map();
  const categories = new Map();
  const entries = [];
  for (const entry of ledger.entries) {
    const currency = entry.currency || ledger.default_currency;
    const cents = parseCents(entry.amount);
    overall.set(currency, (overall.get(currency) || 0n) + cents);
    const projectId = entry.project_id;
    if (typeof projectId !== "string" || !projectId) throw new Error("ledger entry is missing project_id");
    if (!projects.has(projectId)) {
      projects.set(projectId, { id: projectId, name: entry.project_name || projectId, totals: new Map() });
    }
    const project = projects.get(projectId);
    if (entry.project_name) project.name = entry.project_name;
    project.totals.set(currency, (project.totals.get(currency) || 0n) + cents);

    const category = expenseCategory(entry);
    if (!categories.has(category)) categories.set(category, new Map());
    const categoryTotals = categories.get(category);
    categoryTotals.set(currency, (categoryTotals.get(currency) || 0n) + cents);
    entries.push({
      id: entry.id || "",
      date: entry.date || "",
      projectId,
      projectName: entry.project_name || projectId,
      category,
      amount: entry.amount,
      currency,
      description: expenseDescription(entry),
      confidence: expenseConfidence(entry),
    });
  }

  const money = ([currency, cents]) => ({ currency, amount: formatCents(cents) });
  return {
    entryCount: entries.length,
    overall: [...overall.entries()].sort().map(money),
    projects: [...projects.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({ ...project, totals: [...project.totals.entries()].sort().map(money) })),
    categories: [...categories.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, totals]) => ({ name, totals: [...totals.entries()].sort().map(money) })),
    entries,
  };
}

export async function loadExpenses(env = {}, { canonicalPath = CANONICAL_LEDGER_PATH, demoPath = DEMO_LEDGER_PATH } = {}) {
  try {
    const overlay = await readExpenseOverlay(env);
    if (overlay) return { ...rollupLedger(overlay.ledger), source: "private overlay (selected FM_HOME)", demo: false };
  } catch {
    return { entryCount: 0, overall: [], projects: [], categories: [], entries: [], source: "private overlay (selected FM_HOME)", demo: false, error: "Private expense overlay could not be read." };
  }
  try {
    const ledger = JSON.parse(await readFile(canonicalPath, "utf8"));
    return { ...rollupLedger(ledger), source: "expenses/ledger.json", demo: false };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return { entryCount: 0, overall: [], projects: [], categories: [], entries: [], source: "expenses/ledger.json", demo: false, error: "Expense ledger could not be read." };
    }
    const demoLedger = JSON.parse(await readFile(demoPath, "utf8"));
    return { ...rollupLedger(demoLedger), source: "demo fixture (expenses/ledger.json not found)", demo: true };
  }
}
