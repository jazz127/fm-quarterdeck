// Chat asks belong to Quarterdeck, not Firstmate's hold ledger. Review locally,
// then dismiss explicitly. A dismissal never sends an inbox note or clears drafts.
window.bearingsDismiss = (() => {
  const keyOf = (node) => node?.getAttribute?.("data-call-key");
  function createDismissController({ list, doc = window.document, fetchImpl = (...args) => window.fetch(...args), focusTarget = null, onDismiss = () => {} } = {}) {
    const states = new Map();
    let destroyed = false;
    const nodeFor = (key) => [...list.querySelectorAll("[data-call-key]")].find((node) => keyOf(node) === key);
    const part = (node, name) => node.querySelector(`[data-call-dismiss-${name}]`);
    function render(node) {
      const key = keyOf(node);
      let state = states.get(key);
      if (state?.phase === "confirm" && state.rev !== node.getAttribute("data-call-rev")) {
        state = { phase: "compose", rev: node.getAttribute("data-call-rev"), error: "This call changed; review it before dismissing." };
        states.set(key, state);
      }
      const confirming = ["confirm", "sending"].includes(state?.phase);
      const button = node.querySelector("[data-call-dismiss]");
      if (!button) return;
      button.hidden = confirming;
      part(node, "confirm").hidden = !confirming;
      for (const name of ["send", "cancel"]) part(node, name).setAttribute("aria-disabled", String(state?.phase === "sending"));
      part(node, "send").textContent = state?.phase === "sending" ? "Dismissing…" : "Dismiss this ask";
      const error = part(node, "error");
      error.textContent = state?.error || "";
      error.hidden = !state?.error;
    }
    function update(node, state, focus) {
      states.set(keyOf(node), state);
      render(node);
      if (focus) (focus === "review" ? node.querySelector("[data-call-dismiss]") : part(node, focus))?.focus();
    }
    async function send(node, state) {
      const key = keyOf(node);
      update(node, { ...state, phase: "sending", error: null });
      try {
        const response = await fetchImpl("/api/bearings/dismiss", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, cardRev: state.rev }) });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || "Dismiss was not confirmed. Review and try again.");
        if (destroyed) return;
        states.delete(key);
        const current = nodeFor(key);
        // Do not steal focus if the captain moved to another card during delivery.
        if (current?.contains(doc.activeElement)) (typeof focusTarget === "function" ? focusTarget() : focusTarget)?.focus();
        onDismiss(key);
      } catch (failure) {
        if (destroyed) return;
        const current = nodeFor(key);
        const next = { phase: "compose", rev: state.rev, error: failure.message || "Dismiss failed" };
        states.set(key, next);
        if (current) {
          const focused = current.contains(doc.activeElement);
          render(current);
          if (focused) current.querySelector("[data-call-dismiss]")?.focus();
        }
      }
    }
    function click(event) {
      const control = event.target.closest?.("[data-call-dismiss], [data-call-dismiss-send], [data-call-dismiss-cancel]");
      const node = control?.closest("[data-call-key]");
      if (!node || node.getAttribute("data-call-type") !== "chat") return;
      const state = states.get(keyOf(node));
      if (state?.phase === "sending") return;
      if (control.hasAttribute("data-call-dismiss")) update(node, { phase: "confirm", rev: node.getAttribute("data-call-rev") }, "send");
      else if (control.hasAttribute("data-call-dismiss-cancel")) update(node, { phase: "compose", rev: node.getAttribute("data-call-rev") }, "review");
      else if (state?.phase === "confirm") void send(node, state);
    }
    list.addEventListener("click", click);
    return {
      render,
      prune(keys) { const open = new Set(keys); for (const key of states.keys()) if (!open.has(key)) states.delete(key); },
      destroy() { destroyed = true; states.clear(); list.removeEventListener("click", click); },
    };
  }
  return { createDismissController };
})();
