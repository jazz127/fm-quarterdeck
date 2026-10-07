// Pure projection of allowlisted server-owned billing snapshots. No network or DOM.
window.costViewModel = (() => {
  const state = (value) => value === null || value === undefined ? "Unknown" : String(value);
  function project(data) {
    return [
      { id: "azure", title: "Azure subscription · Cost Management", source: data?.azure },
      { id: "github", title: "GitHub Actions · signed-in user billing", source: data?.github },
    ].map(({ id, title, source }) => {
      const unavailable = !source || source.state === "unavailable";
      return { id, title, status: source?.state || "unavailable", reason: source?.reason || (unavailable ? "Billing source unavailable" : null),
        capturedAt: source?.capturedAt || null, period: source?.period || null, delayed: source?.delayed || "unknown",
        rows: id === "azure" ? [
          ["Actual cost", source?.actual ? `${source.actual.amount} ${source.actual.currency}` : "Unknown"],
          ["Forecast", source?.forecast ? `${source.forecast.amount} ${source.forecast.currency}` : "Unknown · not supplied"],
          ["Data lag", state(source?.delayed)],
          ...Object.entries(source?.attribution || { unclassified: null }).map(([key, value]) => [`${key} actual`, value ? `${value.amount} ${value.currency}` : "Unknown · not attributable"]),
        ] : [
          ["Consumed minutes (reported)", state(source?.actual?.minutes)],
          ["Included allowance", source?.included?.minutes ?? "Unknown · not supplied"],
          ["Billable minutes", source?.billable?.minutes ?? "Unknown · not supplied"],
          ["Billable amount", source?.billable?.amount === null || source?.billable?.amount === undefined ? "Unknown · not supplied" : `${source.billable.amount} ${source.billable.currency}`],
          ["Remaining allowance", source?.remaining?.minutes ?? "Unknown · not supplied"],
          ["Storage", source?.storage ? `${source.storage.quantity} ${source.storage.unit}` : "Unknown · not supplied"],
          ["Reset", source?.resetAt ?? "Unknown · not supplied"],
          ["Data lag", state(source?.delayed)],
        ], breakdowns: source?.breakdowns || [], stale: Boolean(source?.stale), partial: Boolean(source?.partial),
      };
    });
  }
  return { project };
})();
