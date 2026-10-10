// Captain's Call presentation. The patcher owns card identity and drafts; the answer
// controller owns the answer phases. Cards no longer clamp, so the overflow controller stays idle.
window.bearingsView = (() => {
  const escape = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  function age(value, now = Date.now()) {
    const ms = now - Date.parse(value);
    if (!Number.isFinite(ms) || ms < 0) return "age unknown";
    return ms < 60000 ? "just now" : ms < 3600000 ? `${Math.floor(ms / 60000)}m ago` : `${Math.floor(ms / 3600000)}h ago`;
  }
  function clockText(clock, now = Date.now()) {
    const value = clock?.at;
    const label = clock?.label || "Created / updated";
    if (!value || !Number.isFinite(Date.parse(value))) return `${label}: unknown`;
    // A durable date is not a timestamp: preserve its precision, never invent midnight.
    if (/^\d{4}-\d\d-\d\d$/.test(value)) {
      const days = Math.floor((Date.UTC(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()) - Date.parse(value)) / 86400000);
      return `${label}: ${value} (time unknown) · ${days >= 0 ? `${days}d ago` : "age unknown"}`;
    }
    return `${label}: ${new Date(value).toLocaleString()} · ${age(value, now)}`;
  }
  // Stable, id-safe suffix per card key for aria-controls targets.
  function idFor(key) {
    let hash = 5381;
    for (const char of String(key)) hash = ((hash * 33) ^ char.codePointAt(0)) >>> 0;
    return `${String(key).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 48)}-${hash.toString(36)}`;
  }
  // Firstmate's snapshot shortens long text itself and marks the cut with "…" or "...".
  const sourceShortened = (text) => typeof text === "string" && /(?:…|\.{3,})\s*$/.test(text.trim());
  const collapsed = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  // A recorded string continues a shortened headline only when it starts with that cut.
  const continues = (shortened, full) => {
    if (!sourceShortened(shortened) || typeof full !== "string") return false;
    const cut = collapsed(shortened).replace(/(?:…|\.{3,})\s*$/, "").trim();
    const whole = collapsed(full);
    return Boolean(cut) && whole.length > collapsed(shortened).length && whole.startsWith(cut);
  };
  const fullest = (primary, extras) => {
    let best = primary;
    if (!sourceShortened(primary)) return best;
    for (const text of extras) if (continues(primary, text) && collapsed(text).length > collapsed(best).length) best = text;
    return best;
  };
  const RECORDED = [["backlogTitle", "Backlog title"], ["backlogReason", "Hold reason"], ["title", "Recorded title"], ["reason", "Recorded reason"], ["summary", "Recorded ask"]];
  const TASK_MARKER = /\[task:[A-Za-z0-9][A-Za-z0-9._-]{0,159}\]/g;
  // Display text for a linked chat line. The task marker is a link, not part of the ask.
  function visibleChatText(text) {
    return collapsed(String(text ?? "").replace(TASK_MARKER, " "));
  }
  function isLinkedChatLine(card, text) {
    const shown = visibleChatText(text);
    return Boolean(shown) && Array.isArray(card.chatAsks) && card.chatAsks.some((ask) => visibleChatText(ask.summary) === shown);
  }
  // A decision title is the filed hold's full reason: backlog hold reason, otherwise snapshot reason.
  // A reason that is only the linked chat line does not count.
  function decisionText(card) {
    for (const field of ["backlogReason", "reason"]) {
      const text = card[field];
      if (typeof text === "string" && text.trim() && !isLinkedChatLine(card, text)) return text;
    }
    return null;
  }
  function disclosureHtml(headingId, panelId, text, card, fields) {
    const shown = fullest(text, fields.map(([field]) => card[field]));
    if (!sourceShortened(shown)) return `<h3 id="${headingId}">${escape(shown)}</h3>`;
    const others = fields.filter(([field]) => typeof card[field] === "string" && collapsed(card[field]) && collapsed(card[field]) !== collapsed(shown));
    const body = others.length
      ? others.map(([field, label]) => `<p><span class="call-meta">${escape(label)}</span><br>${escape(card[field])}</p>`).join("")
      : `<p>This is the full text Quarterdeck received.</p>`;
    return `<h3 id="${headingId}" data-call-truncated><button type="button" class="call-text-toggle" data-call-text-toggle aria-expanded="false" aria-controls="${panelId}">${escape(shown)}</button></h3><div class="call-full" id="${panelId}" data-call-full hidden>${body}</div>`;
  }
  function headlineHtml(id, text, card) {
    return disclosureHtml(`call-decide-${id}`, `call-full-${id}`, text, card, RECORDED);
  }
  // Just landed uses the same continuation rule. The backlog title replaces a
  // shortened snapshot "what" only when it continues that cut.
  function landedHeadlineHtml(card) {
    const id = idFor(card.key || card.task || "landed");
    return disclosureHtml(`landed-what-${id}`, `landed-full-${id}`, card.what || "Landing not recorded", card, [["backlogTitle", "Backlog title"]]);
  }
  function lifecycleBadgeHtml() {
    return `<span class="call-lifecycle-dot" data-call-lifecycle-badge data-call-lifecycle="active" role="img" aria-label="Active" title="Active"></span>`;
  }
  function sentLabelHtml() {
    return `<p class="call-sent-label" data-call-sent-label hidden>Sent - waiting for Firstmate to read</p>`;
  }
  function replyBannerHtml() {
    return `<p class="call-reply-banner" data-fm-reply hidden></p>`;
  }
  // Filled by the answer controller from the sent-answer state. Hidden until that phase.
  function yourAnswerHtml() {
    return `<section class="call-your-answer" data-call-answer-summary hidden><h4>Your answer</h4><p class="call-your-answer-choice"><strong data-call-answer-summary-label hidden></strong><span class="call-your-answer-hint" data-call-answer-summary-hint hidden></span></p><p class="call-your-answer-note" data-call-answer-summary-note hidden></p><p class="call-meta"><time data-call-answer-summary-sent datetime=""></time></p></section>`;
  }
  function procrastinateHtml(id) {
    const item = (duration) => `<button type="button" role="menuitem" data-call-procrastinate-for="${duration}">${duration}</button>`;
    return `<div class="call-procrastinate" data-call-procrastinate><button type="button" class="call-head-pill" data-call-procrastinate-toggle aria-expanded="false" aria-controls="call-procrastinate-${id}">Procrastinate</button><div class="call-procrastinate-menu" id="call-procrastinate-${id}" data-call-procrastinate-menu role="menu" hidden>${["3h", "6h", "1d", "3d"].map(item).join("")}</div><p class="call-meta" data-call-procrastinate-until hidden></p><button type="button" data-call-procrastinate-return hidden>Bring back now</button><p class="call-answer-error" data-call-procrastinate-error role="alert" hidden></p></div>`;
  }
  // Suggested replies from chat asks linked to a filed call: offered as radios, relayed as
  // the captain's own words (never as a keyed option value), so intake is unchanged.
  function linkedReplies(card, options) {
    if (card.type === "chat" || !Array.isArray(card.chatAsks)) return [];
    const taken = new Set(options.map((option) => String(option.label).toLowerCase()));
    const replies = [];
    for (const ask of card.chatAsks) for (const reply of Array.isArray(ask.replies) ? ask.replies : []) {
      if (typeof reply === "string" && reply.trim() && !taken.has(reply.toLowerCase()) && replies.length < 8) { taken.add(reply.toLowerCase()); replies.push(reply); }
    }
    return replies;
  }
  // One text box per card. A checked option answers; text alone is a thread note.
  // The hint under the box is the captain's contract for that split (BEARINGS.md).
  const BOX_HINT = "Pick an option to answer, or just type - Firstmate replies in the thread.";
  function answerForm(card, label, body, thread = "") {
    return `<form class="call-answer" data-call-answer data-call-answer-label="${escape(label)}" novalidate aria-label="Answer: ${escape(label)}">
      <fieldset class="call-answer-fields" data-call-answer-fields>
        <legend class="call-answer-legend">Answer</legend>
        ${body}
        ${thread}
        <div class="call-answer-compose">
          <label class="call-answer-note"><span class="sr-only">Note for this call</span><textarea data-call-draft="answer" data-call-answer-text rows="1" placeholder="Write a note"></textarea></label>
          <div class="call-answer-actions call-answer-bar"><button type="submit" class="call-answer-queue" data-call-answer-compose>Queue</button><button type="button" class="call-answer-send" data-call-answer-send hidden>Send</button><button type="button" data-call-answer-edit hidden>Edit</button></div>
        </div>
        <p class="call-box-hint" data-call-box-hint>${BOX_HINT}</p>
      </fieldset>
      <p class="call-answer-error" data-call-answer-error role="alert" hidden></p>
      <div class="call-answer-confirm" data-call-answer-confirm role="group" aria-label="Queued answer" hidden>
        <p>Queued for Firstmate: <strong data-call-answer-preview></strong></p>
        <p class="call-meta" data-call-answer-confirm-note>Send sends this answer now; Send batch in the review queue sends every queued answer together. Edit takes it out of the queue.</p>
      </div>
      <div class="call-answer-receipt" data-call-answer-receipt tabindex="-1" hidden><p role="status" data-call-answer-receipt-text></p><button type="button" data-call-answer-again>Answer again</button></div>
    </form>`;
  }
  function answerHtml(card, label, thread = "") {
    const answer = card.answer;
    if (!answer) return `<p class="call-answer-hint">Answer in chat or on the /bearings lavish board.</p>
      <label class="call-note">Note to self <span>(saved in this tab · not sent)</span><textarea data-call-draft="note" rows="2" placeholder="Private reminder…"></textarea></label>
      ${answerForm(card, label, "", thread)}`;
    const id = idFor(card.key || label);
    const options = Array.isArray(answer.options) ? answer.options : [];
    const replies = linkedReplies(card, options);
    const radio = (value, text, hint, extra = "", recommended = false) => `<label class="call-opt"><input type="radio" name="call-selection-${id}" value="${escape(value)}" data-call-draft="selection" data-call-option-label="${escape(text)}"${extra}${recommended ? ` aria-describedby="call-rec-${id}"` : ""}><span class="call-opt-body"><span class="call-opt-label">${escape(text)}</span>${hint ? `<span class="call-opt-hint">${escape(hint)}</span>` : ""}</span>${recommended ? `<span class="call-opt-rec" id="call-rec-${id}">Recommended</span>` : ""}</label>`;
    const optionHtml = options.map((option) => radio(option.value, option.label, option.hint, "", answer.recommend === option.value)).join("")
      + replies.map((reply, index) => radio(`chat-reply-${index + 1}`, reply, "Suggested reply from chat · sent as your words", ` data-call-reply="${escape(reply)}"`)).join("");
    const choices = options.length + replies.length;
    const body = choices ? `<div class="call-opts">${optionHtml}</div>` : `<p class="call-answer-gap">No structured options for this call yet; any recorded choices are in the full ${card.type === "merge" ? "reason" : "ask"} above.</p>`;
    return answerForm(card, label, body, thread);
  }
  // History stays collapsed, above the one text box. The notice stays outside the history so a lone entry can still say a question was sent.
  const threadHistoryHtml = (id) => `<span class="call-meta sr-only" data-call-thread-replies role="status" aria-live="polite"></span><button type="button" class="call-thread-expand" data-call-thread-expand aria-expanded="false" aria-controls="call-thread-history-${id}" hidden><span data-call-thread-count>Thread</span></button><section class="call-thread-history" id="call-thread-history-${id}" data-call-thread-history hidden>
      <p class="call-meta" data-call-thread-status role="status"></p>
      <p class="call-meta" data-call-thread-earlier></p>
      <ol class="call-thread-log" id="call-thread-log-${id}" data-call-thread-log></ol>
      <button type="button" class="call-thread-history-toggle" data-call-thread-history-toggle aria-expanded="false" aria-controls="call-thread-log-${id}" hidden>Show earlier messages</button>
    </section><p class="call-meta" data-call-thread-notice role="status" hidden></p>`;
  const CHAT_LABELS = { approval: "Approval", action: "Action", decision: "Decision" };
  const repliesText = (replies) => (Array.isArray(replies) && replies.length ? replies.map((reply) => `“${reply}”`).join(" or ") : "No quoted reply");
  // A chat ask is one Firstmate made in conversation without filing a hold (BEARINGS.md "Chat asks").
  function chatCardHtml(card) {
    const label = CHAT_LABELS[card.kind] || "Ask";
    const id = idFor(card.key);
    const row = (name, text, extra = "") => `<div class="call-context-row"><dt>${name}</dt><dd${extra}>${escape(text)}</dd></div>`;
    const summary = card.summary || "Ask text not recorded";
    return `<div class="call-chrome"><header class="call-head"><span class="state-chip call-chat-chip">${label} · Chat ask</span>${lifecycleBadgeHtml()}<div class="call-head-actions"><button type="button" class="call-head-pill call-head-dismiss" data-call-dismiss>Review dismissal</button>${procrastinateHtml(id)}</div><span class="call-age" data-call-clock="${escape(card.clock?.at || "")}" data-call-clock-label="${escape(card.clock?.label || "Asked")}">${escape(clockText(card.clock))}</span></header>
      ${replyBannerHtml()}
      ${sentLabelHtml()}
      ${yourAnswerHtml()}
      ${headlineHtml(id, summary, card)}
      <dl class="call-context">${row("About", "Firstmate asked in chat; no captain hold is filed")}${row("Reply", repliesText(card.replies))}</dl>
      <p class="call-meta">Found by its <code>${escape(card.marker || "")}</code> line in the Firstmate transcript.</p>
      <p class="call-meta">Answering here, dismissing, or replying in chat with the quoted reply closes this card.</p>
      <div class="call-dismiss-confirm" data-call-dismiss-confirm role="group" aria-label="Confirm dismissal" hidden><p>Hide this ask from Captain's Call? Nothing is sent to Firstmate. Unsent text stays in this tab.</p><div class="call-answer-actions"><button type="button" data-call-dismiss-send>Dismiss this ask</button><button type="button" data-call-dismiss-cancel>Cancel</button></div></div>
      <p class="call-answer-error" data-call-dismiss-error role="alert" hidden></p></div>
      ${answerHtml(card, summary, threadHistoryHtml(id))}`;
  }
  const linkedAsksHtml = (card) => Array.isArray(card.chatAsks) && card.chatAsks.length
    ? `<div class="call-context-row call-context-ask"><dt>Also asked in chat</dt><dd>${card.chatAsks.map((ask) => `${escape(visibleChatText(ask.summary) || "Asked in chat")} · reply ${escape(repliesText(ask.replies))}`).join("<br>")}</dd></div>` : "";
  function cardHtml(card) {
    if (card.type === "chat") return chatCardHtml(card);
    const merge = card.type === "merge";
    let url = null;
    try { const parsed = new URL(card.url); if (parsed.protocol === "https:" && !parsed.username && !parsed.password) url = parsed.href; } catch {}
    // Firstmate holds credentials as ordinary captain-hold decisions, so the ask text decides the chip.
    const credential = !merge && /credential|authentication|access|login/i.test(`${card.verb || ""} ${card.summary || ""}`);
    const label = merge ? "Merge" : credential ? "Credentials" : "Decision";
    const id = idFor(card.key || card.task || label);
    const ask = card.summary || "";
    const decide = merge ? card.reason || "Merge requested; reason not recorded" : decisionText(card) || (ask && !isLinkedChatLine(card, ask) ? ask : "") || "Decision requested; ask not recorded";
    const shown = fullest(decide, RECORDED.map(([field]) => card[field]));
    const shortened = sourceShortened(shown);
    const row = (name, text, extra = "") => `<div class="call-context-row"><dt>${name}</dt><dd${extra}>${escape(text)}</dd></div>`;
    const about = [card.repo || "Repository not recorded", card.owner || "Owner not recorded", merge && card.kind].filter(Boolean).join(" · ");
    return `<div class="call-chrome"><header class="call-head"><span class="state-chip">${label}</span>${lifecycleBadgeHtml()}<div class="call-head-actions">${card.repo ? `<span class="call-repo">${escape(card.repo)}</span>` : ""}${procrastinateHtml(id)}</div><span class="call-age" data-call-clock="${escape(card.clock?.at || "")}" data-call-clock-label="${escape(card.clock?.label || "Created / updated")}">${escape(clockText(card.clock))}</span></header>
      ${replyBannerHtml()}
      ${sentLabelHtml()}
      ${yourAnswerHtml()}
      ${headlineHtml(id, decide, card)}
      <dl class="call-context">${row("About", about)}${linkedAsksHtml(card)}${merge ? row("Risk", "Not provided by the snapshot; see the full reason above.") : ""}</dl>
      <p class="call-id">Task <code>${escape(card.task || "unknown")}</code></p>
      ${shortened ? `<p class="call-shortened">Firstmate's snapshot shortened this ${merge ? "reason" : "ask"}; Quarterdeck shows everything it received. Ask Firstmate in chat for the full text of task <code>${escape(card.task || "unknown")}</code>.</p>` : ""}
      ${url ? `<a class="call-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(url)}</a>` : merge ? '<p class="call-meta">Merge link unavailable</p>' : ""}
      ${card.answer ? "" : `<p class="call-source-gap">Options, hints and recommendation are not structured in the snapshot; any recorded choices remain in the full ${merge ? "reason" : "ask"} above.</p>`}</div>
      ${answerHtml(card, `${label} ${card.task || ""}`.trim(), threadHistoryHtml(id))}`;
  }
  // Open or closed full-text panels are memory for this tab only.
  // Each toggle keeps its own panel, so a landing title and a landing link expand separately.
  function createTextController({ list, keyAttribute = "data-call-key" } = {}) {
    const open = new Map();
    const keyOf = (node) => node?.getAttribute?.(keyAttribute) || null;
    const panelIdOf = (toggle) => toggle.getAttribute("aria-controls") || "text";
    function panelFor(node, toggle, toggles) {
      const panelId = panelIdOf(toggle);
      const found = panelId !== "text" ? node.querySelector(`[id="${panelId}"]`) : null;
      return found || (toggles.length === 1 ? node.querySelector("[data-call-full]") : null);
    }
    function render(node) {
      if (!node?.querySelectorAll) return;
      const key = keyOf(node);
      const toggles = [...node.querySelectorAll("[data-call-text-toggle]")];
      for (const toggle of toggles) {
        const panel = panelFor(node, toggle, toggles);
        if (!panel) continue;
        const shown = Boolean(key && open.get(key)?.has(panelIdOf(toggle)));
        toggle.setAttribute("aria-expanded", String(shown));
        panel.hidden = !shown;
      }
    }
    const onClick = (event) => {
      const toggle = event.target?.closest?.("[data-call-text-toggle]");
      if (!toggle || !list.contains(toggle)) return;
      const node = toggle.closest(`[${keyAttribute}]`);
      const key = keyOf(node);
      if (!key) return;
      const panelId = panelIdOf(toggle);
      const set = open.get(key) || new Set();
      if (set.has(panelId)) set.delete(panelId);
      else set.add(panelId);
      if (set.size) open.set(key, set);
      else open.delete(key);
      render(node);
    };
    list.addEventListener("click", onClick);
    return {
      render,
      prune(keys) { const keep = new Set(keys); for (const key of [...open.keys()]) if (!keep.has(key)) open.delete(key); },
      destroy() { list.removeEventListener("click", onClick); },
    };
  }
  function emptyHtml(model) {
    if (model.state === "loading") return "Checking for Captain's Calls…";
    if (model.state === "unavailable") return `Captain's Call unavailable${model.error ? ` · ${escape(model.error)}` : ""}`;
    const text = model.coverage?.provenClear ? "Nothing needs your action right now" : `No decision is recorded · checked ${count(model.coverage?.checked)} of ${count(model.coverage?.known)}`;
    return `${model.stale || model.state === "stale" ? "Last known calls · " : ""}${text}`;
  }
  function coverageText(model) {
    const parts = [];
    if (model.state === "loading") parts.push("Checking Firstmate…");
    else if (model.state === "unavailable") parts.push(`Unavailable${model.error ? ` · ${model.error}` : ""}`);
    else parts.push(`${model.stale || model.state === "stale" ? "Stale · last known calls" : "Firstmate"} · checked ${count(model.coverage?.checked)} of ${count(model.coverage?.known)} · ${age(model.checkedAt)}`);
    if (model.stale && model.error) parts.push(model.error);
    for (const omitted of model.omitted || []) {
      if (omitted.kind === "deferred-holds" && count(omitted.count)) parts.push(`+${omitted.count} later-dated or blocked calls not shown`);
      if (omitted.kind === "decisions-bound") parts.push(`${count(omitted.shown)} of ${count(omitted.total)} decisions shown`);
      if (omitted.kind === "invalid-rows" && count(omitted.count)) parts.push(`${omitted.count} invalid calls withheld`);
    }
    if (count(model.coverage?.captainOmitted)) parts.push(`${model.coverage.captainOmitted} merge calls not shown`);
    if (count(model.coverage?.unmeasuredHomes)) parts.push(`${model.coverage.unmeasuredHomes} homes unmeasured`);
    if (model.chat?.state && model.chat.state !== "ready") parts.push(model.chat.error || "Chat asks unavailable");
    if (count(model.chat?.omitted)) parts.push(`${model.chat.omitted} older chat asks not shown`);
    if (model.chat?.behind) parts.push("Still reading the Firstmate transcript");
    return parts.join(" · ");
  }
  const heldText = (change) => `Call ${change} — updates when you're done`;
  const stubHtml = () => '<div class="call-chrome"><h3>Resolved by Firstmate — your unsent text</h3><p class="call-meta">This text was not sent. Copy it before dismissing.</p></div><pre data-call-stub-text></pre><div class="call-stub-actions"><button type="button" data-call-stub-copy>Copy</button><button type="button" data-call-stub-dismiss>Dismiss</button></div>';
  return { cardHtml, emptyHtml, coverageText, heldText, stubHtml, age, clockText, idFor, sourceShortened, landedHeadlineHtml, createTextController };
})();
