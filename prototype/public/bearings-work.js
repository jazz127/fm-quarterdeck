// Read-only snapshot work sections. Uses the existing bearings stream and card vocabulary.
window.bearingsWork = (() => {
  const labels = { underway: "Underway", charted: "Charted Next" };
  const escape = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  function startedHtml(at) {
    const time = typeof at === "string" && /^\d{4}-\d\d-\d\dT/.test(at) && Number.isFinite(Date.parse(at)) ? new Date(at) : null;
    return time ? `Worker started: <time datetime="${escape(time.toISOString())}" title="Current worker spawn time: ${escape(time.toISOString())}">${escape(time.toLocaleString())}</time>`
      : "Worker started: unknown";
  }
  function pipelineText(pipeline) {
    const position = pipeline?.position || "unknown", notes = [];
    if (["validating", "validation decision"].includes(position)) notes.push(`substep ${pipeline?.substep || "unknown"}`);
    if (["checks", "PR open"].includes(position)) notes.push("check result unknown");
    if (pipeline?.milestones?.length) notes.push(`completed milestone: ${pipeline.milestones.join(", ")}`);
    return `Pipeline: ${position}${notes.length ? " · " + notes.join(" · ") : ""}`;
  }
  function cardHtml(card) {
    const underway = card.type === "underway";
    const badge = underway ? card.stage || "Stage unavailable" : card.kind === "warning" ? "Needs repair" : "Waiting";
    const detail = underway ? card.doing : card.reason;
    const clock = !underway ? window.bearingsView?.clockText?.(card.clock) : null;
    return `<div class="call-chrome"><header class="call-head"><span class="state-chip">${escape(badge)}</span>${card.repo ? `<span class="call-repo">${escape(card.repo)}</span>` : ""}${clock ? `<span class="call-age">${escape(clock)}</span>` : ""}</header>
      <h3>${escape(card.title)}</h3>
      ${underway ? `<p class="call-meta" data-work-home>Home: ${escape(card.home || "Home unavailable")}</p>` : ""}
      ${underway ? `<p class="call-meta" data-work-start>${startedHtml(card.startedAt)}</p><p class="call-meta" data-work-pipeline>${escape(pipelineText(card.pipeline))}</p>` : ""}
      ${detail ? `<p class="call-meta">${escape(detail)}</p>` : ""}
      ${card.blockedBy ? `<p class="call-meta">Blocked by: ${escape(card.blockedBy)}</p>` : ""}
      <p class="call-meta">${escape([underway ? card.kind : card.owner, card.task].filter(Boolean).join(" · "))}</p>
      ${window.bearingsView?.sourceShortened?.(card.title) || window.bearingsView?.sourceShortened?.(detail) ? '<p class="call-shortened">Firstmate’s snapshot shortened this row; Quarterdeck shows everything it received.</p>' : ""}</div>`;
  }
  function createController({ sections = {}, doc = document } = {}) {
    let model = { state: "loading" };
    const rows = name => Array.isArray(model[name]) ? model[name] : [];
    const count = name => rows(name).filter(row => row.kind !== "warning").length;
    function paintStatus(name, root) {
      const status = root.querySelector("[data-work-status]");
      if (!status) return;
      const notes = [];
      if (model.state === "stale" || model.stale) notes.push("Last good snapshot · stale");
      if (model.state === "unavailable" || (model.state !== "loading" && !model.workCoverage?.[name])) notes.push(`${labels[name]} unavailable`);
      for (const entry of model.omitted || []) if (entry.kind === `invalid-${name}`) notes.push(`${entry.count} invalid rows withheld`);
      notes.push(...(model.workCoverage?.disclosures || []));
      if (name === "underway") notes.push(...(model.workCoverage?.underwayDisclosures || []));
      status.textContent = notes.join(" · ");
      status.hidden = !notes.length;
    }
    function render() {
      for (const [name, root] of Object.entries(sections)) {
        if (!root) continue;
        const list = root.querySelector("[data-work-cards]");
        if (!list) continue;
        const cards = rows(name), keys = new Set(cards.map(card => card.key));
        for (const node of list.querySelectorAll("[data-work-key]")) if (!keys.has(node.getAttribute("data-work-key"))) node.remove();
        for (const [index, card] of cards.entries()) {
          let node = [...list.querySelectorAll("[data-work-key]")].find(node => node.getAttribute("data-work-key") === card.key);
          if (!node) {
            node = doc.createElement("article");
            node.className = "call-card";
            node.setAttribute("data-work-key", card.key);
          }
          if (node.getAttribute("data-work-rev") !== card.rev) {
            node.innerHTML = cardHtml(card);
            node.setAttribute("data-work-rev", card.rev);
          }
          const at = [...list.querySelectorAll("[data-work-key]")][index];
          if (at !== node) list.insertBefore(node, at || null);
        }
        let empty = list.querySelector("[data-work-empty]");
        if (!empty) { empty = doc.createElement("p"); empty.className = "call-empty"; empty.setAttribute("data-work-empty", ""); list.insertBefore(empty, list.firstChild || null); }
        empty.hidden = name === "charted" ? count(name) > 0 : cards.length > 0;
        empty.textContent = model.state === "loading" ? `Checking ${labels[name]}…`
          : model.state === "unavailable" || !model.workCoverage?.[name] ? `${labels[name]} unavailable`
          : model.state === "stale" || model.stale ? "No rows in the last good snapshot · stale"
          : name === "underway" && model.workCoverage?.underwayDisclosures?.length ? "No observed work rows; inventory coverage is incomplete."
          : name === "underway" ? "Nothing is underway in the current snapshot." : "Nothing is queued in the current snapshot.";
        const badge = root.querySelector("[data-work-count]");
        if (badge) { badge.textContent = String(count(name)); badge.hidden = count(name) === 0; }
        paintStatus(name, root);
      }
    }
    render();
    return { count, update(next) { model = next; render(); }, observe(freshness) { model = { ...model, ...freshness }; render(); } };
  }
  return { createController, cardHtml, startedHtml, pipelineText };
})();
