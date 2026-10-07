// Evaluate through the authorized headless browser tool. Returns booleans only:
// never DOM snapshots, screenshots, amounts, labels, source paths or private text.
export async function expenseAssertions(expectedRevision, mode) {
  try {
    const get = async (url) => { const response = await fetch(url, { cache: "no-store" }); if (!response.ok) throw new Error(); return response.json(); };
    const [dashboard, costs, review] = await Promise.all([get("/api/dashboard"), get("/api/costs"), get("/api/review")]);
    const expense = dashboard.expenses;
    for (let i = 0; i < 100 && (!document.querySelector("#expense-source")?.textContent || document.querySelectorAll("#cost-panels article").length !== 2); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const text = (node) => node.textContent.trim();
    const rows = [...document.querySelectorAll("#expense-entries tr[data-review-id]")].map((row) => [...row.querySelectorAll("td")].map(text));
    const expectedRows = expense.entries.map((row) => [row.date, row.projectName, row.category, row.amount, row.currency, row.description, row.confidence || "—"]);
    const canonical = (rows) => rows.map((row) => JSON.stringify(row)).sort();
    const totals = [...document.querySelectorAll("#overall-total strong")].map(text);
    const expectedTotals = expense.overall.length ? expense.overall.map((row) => `${row.currency} ${row.amount}`) : ["—"];
    const breakdown = (id, groups) => same([...document.querySelectorAll(`${id} .expense-row`)].map((row) => [text(row.querySelector("span")), text(row.querySelector("strong"))]), groups.map((row) => [row.name, row.totals.map((total) => `${total.currency} ${total.amount}`).join(" · ")]));
    const cards = window.costViewModel.project(costs);
    const actualCards = [...document.querySelectorAll("#cost-panels article")];
    const checks = {
      revision: review.version === expectedRevision && window.FM_STANDALONE_UAT?.revision === expectedRevision,
      route: location.hash === "#expenses" && document.querySelector("#expenses-view").classList.contains("active"),
      source: text(document.querySelector("#expense-source")) === expense.source && !expense.demo && !expense.error,
      defaults: mode === "empty" ? expense.entryCount === 0 && text(document.querySelector("#expense-entries")).includes("No expenses recorded") : expense.source === "private overlay (selected FM_HOME)",
      entries: rows.length === expense.entryCount && same(canonical(rows), canonical(expectedRows)),
      totals: same(totals, expectedTotals),
      categories: breakdown("#category-expenses", expense.categories),
      projects: breakdown("#project-expenses", expense.projects),
      unavailableAttribution: cards.every((card, i) => card.status === "unavailable" && same([...actualCards[i].querySelectorAll("dl > div")].map((row) => [text(row.querySelector("dt")), text(row.querySelector("dd"))]), card.rows)),
    };
    return { pass: Object.values(checks).every(Boolean), checks };
  } catch { return { pass: false }; }
}
