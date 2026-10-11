// This server-owned view also works in a fresh tab, after a submitting tab closes.
(() => {
  const panel = document.getElementById("inbox-pending");
  const items = document.getElementById("inbox-pending-items");
  const status = document.getElementById("inbox-pending-status");
  const button = document.getElementById("inbox-pending-send");
  if (!panel || !items || !button) return;
  let busy = false, flushing = null, previous = "", count = 0;
  async function refresh() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const response = await fetch("/api/inbox/pending", { cache: "no-store" });
      if (response.status === 404) return;
      if (!response.ok) throw Error("unavailable");
      const data = await response.json();
      if (count !== data.items.length) {
        count = data.items.length;
        window.dispatchEvent(new Event("quarterdeck-inbox-pending"));
      }
      const signature = JSON.stringify(data.items);
      if (signature !== previous) {
        previous = signature;
        items.replaceChildren();
        for (const item of data.items) {
          const details = document.createElement("details");
          const summary = document.createElement("summary");
          summary.textContent = `Pending · ${item.key || "Captain note"}`;
          const text = document.createElement("pre");
          text.style.whiteSpace = "pre-wrap";
          text.style.overflowWrap = "anywhere";
          text.textContent = item.text;
          details.append(summary, text);
          items.append(details);
        }
      }
      panel.hidden = !data.items.length;
      status.textContent = data.items.length ? "Saved in Quarterdeck; waiting for inbox delivery. Send now also retries retained submissions." : "";
    } catch {
      panel.hidden = false;
      status.textContent = "Pending inbox state unavailable; saved items are retained. Reload or retry when the server is available.";
    } finally { busy = false; }
  }
  function flush() {
    if (flushing) return flushing;
    button.disabled = true;
    flushing = (async () => {
      try {
        const response = await fetch("/api/inbox/send-now", { method: "POST" });
        if (!response.ok) throw Error("unconfirmed");
        await refresh();
      } catch { status.textContent = "Delivery unconfirmed; saved items retained. Retry sends the same batch once."; }
      finally { button.disabled = false; flushing = null; }
    })();
    return flushing;
  }
  window.quarterdeckInboxPending = { count: () => count, flush };
  button.addEventListener("click", flush);
  window.addEventListener("quarterdeck-sent", refresh);
  document.addEventListener("visibilitychange", refresh);
  void refresh();
  setInterval(refresh, 2000);
})();
