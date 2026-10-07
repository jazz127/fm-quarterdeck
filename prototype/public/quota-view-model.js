// Projection of the server-sanitized quota reading. No network or DOM; callers
// can supply now for freshness calculations, otherwise the current clock is used.
// Window IDs and reset timestamps remain source values; a low percentage never
// creates a source-reported limiting relationship.
window.quotaViewModel = (() => {
  const valid = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
  const ageOf = (provider, reading) => {
    const captured = Date.parse(provider.refreshedAt || "");
    return Number.isFinite(captured) ? Math.max(0, reading.now - captured) : null;
  };
  const ageLabel = (ageMs) => {
    if (!Number.isFinite(ageMs)) return "age unknown";
    if (ageMs < 120000) return `${Math.floor(ageMs / 1000)}s`;
    return `${Math.floor(ageMs / 60000)}m`;
  };
  const remaining = (provider) => {
    const known = (provider.scopes || []).map((scope) => scope.percentRemaining).filter(valid);
    return known.length ? Math.min(...known) : null;
  };
  const active = (provider) => Boolean(provider.scopes?.length || provider.windows?.length);
  // Scope ownership comes only from source-reported boundedBy IDs. Ambiguous
  // overlaps remain at provider level rather than implying a shared allowance.
  const groups = (provider) => {
    const owners = new Map();
    for (const scope of provider.scopes || []) for (const id of scope.boundedBy || []) {
      const list = owners.get(id) || [];
      list.push(scope.scope);
      owners.set(id, list);
    }
    const result = new Map();
    for (const window of provider.windows || []) {
      const names = owners.get(window.id) || [];
      // Grok reports credits plus independently measured product windows. Its
      // overlapping scope bounds do not establish a shared allowance; keep all
      // source windows as separate rows in one provider card, never merge data.
      // Claude's account and model windows likewise share a visual card only.
      const scope = ["grok", "claude"].includes(provider.provider) ? null : names.length === 1 ? names[0] : null;
      const key = scope ? `scope:${scope}` : "provider";
      if (!result.has(key)) result.set(key, { name: scope ? `${provider.provider} · ${scope.replaceAll("_", " ")}` : provider.provider, provider: provider.provider, scope, windows: [] });
      result.get(key).windows.push(window);
    }
    return [...result.values()];
  };
  // Abbreviate only an explicit source label's period suffix for compact cards.
  // This is presentation, never duration evidence or a grouping decision. If
  // abbreviating would collide with another row, retain the original labels.
  const windowLabel = (label) => String(label ?? "").replace(/\b(?:week|weekly)\b/gi, "7d");
  const windowLabels = (family) => {
    const labels = family.windows.map((window) => window.label || window.scope || "Unknown");
    if (family.provider === "grok") {
      const short = family.windows.map((window) => window.id === "credits" && window.label === "week" ? "Credits" : windowLabel(window.label?.replace(/^Grok /i, "") || "Unknown"));
      return short.map((label, index) => short.indexOf(label) === short.lastIndexOf(label) ? label : windowLabel(labels[index]));
    }
    if (!family.scope) return labels.map(windowLabel);
    const short = labels.map((label) => /(?:^| )5-hour$/i.test(label) ? "5h" : /(?:^| )(?:week|weekly)$/i.test(label) ? "7d" : windowLabel(label));
    return short.map((label, index) => short.indexOf(label) === short.lastIndexOf(label) ? label : windowLabel(labels[index]));
  };
  // A notch marks the remaining fraction of a complete source interval, not
  // consumption. AGY's explicit period classification is retained with label
  // provenance by the sanitizer. Other sources can declare a start, or
  // its pace can explicitly validate the window_seconds basis (an implied
  // start from source duration and reset). Past resets never roll forward.
  const marker = (window, capturedAt) => {
    const end = Date.parse(window.resetsAt), captured = Date.parse(capturedAt);
    const duration = window.durationSeconds * 1000;
    if (!window.resetsAt || !capturedAt || !Number.isFinite(end) || !Number.isFinite(captured) || !Number.isFinite(duration) || duration <= 0) return null;
    const start = window.startsAt ? Date.parse(window.startsAt) : end - duration;
    if (!Number.isFinite(start) || Math.abs(end - start - duration) > 1 || captured < start || captured > end) return null;
    const remaining = (end - captured) / duration * 100;
    if (!window.startsAt && window.durationBasis !== "provider_label" && (window.pace?.cycleBasis !== "window_seconds" || window.pace.cycleSeconds !== window.durationSeconds ||
      typeof window.pace.timeRemainingPercent !== "number" || Math.abs(remaining - window.pace.timeRemainingPercent) > 0.001)) return null;
    return Math.max(0, Math.min(100, remaining));
  };
  // Runway ordering uses source pace reserve (remaining minus time remaining).
  // When pace is absent, source runway coverage of the bounded reset interval
  // supplies the same signed margin. Never extrapolate consumption ourselves.
  const runwayMargin = (scope, windows, now) => {
    if (windows.some((w) => w.resetsAt && Date.parse(w.resetsAt) <= now)) return null;
    if (scope?.pace?.status && scope.pace.status !== "unknown" && Number.isFinite(scope.pace.reservePercentPoints)) {
      return { value: scope.pace.reservePercentPoints, basis: "source pace" };
    }
    if (windows.length && windows.every((w) => w.pace?.status && w.pace.status !== "unknown" && Number.isFinite(w.pace.reservePercentPoints))) {
      return { value: Math.min(...windows.map((w) => w.pace.reservePercentPoints)), basis: "source pace" };
    }
    const runway = scope?.runway;
    const bounded = (scope?.boundedBy || []).map((id) => windows.find((w) => w.id === id));
    if (!bounded.length || bounded.some((w) => !w || !Number.isFinite(Date.parse(w.resetsAt)) || Date.parse(w.resetsAt) <= now)) return null;
    if (runway?.status === "through_reset") return { value: 0, basis: "source runway through reset" };
    if (runway?.status === "exhausted_now") return { value: -100, basis: "source runway exhausted" };
    if (runway?.status !== "projected_exhaustion" || !Number.isFinite(runway.seconds) || runway.seconds < 0) return null;
    const resetSeconds = Math.min(...bounded.map((w) => (Date.parse(w.resetsAt) - now) / 1000));
    return { value: (Math.min(1, runway.seconds / resetSeconds) - 1) * 100, basis: "source runway / reset coverage" };
  };
  const project = (reading, { hideInactive = false, lowestFirst = false, sidebarSort = "highest", now = Date.now() } = {}) => {
    const maxAgeMs = Number.isFinite(reading.maxAgeMs) && reading.maxAgeMs > 0 ? reading.maxAgeMs : 300000;
    const timedReading = { ...reading, now };
    const providers = (reading.providers || []).map((provider) => {
      const ageMs = ageOf(provider, timedReading);
      const stale = Boolean(reading.stale || provider.stale || provider.status === "stale" || (ageMs !== null && ageMs >= maxAgeMs));
      const reusedLabel = provider.reused && !stale ? `reused ${ageLabel(ageMs)}` : null;
      const staleLabel = stale ? `stale · ${ageLabel(ageMs)}` : null;
      const limitingIds = new Set((provider.scopes || []).flatMap((scope) => scope.limitingWindowIds || []));
      const windows = (provider.windows || []).map((window) => ({ ...window, pace: stale ? { ...window.pace, status: "unknown", reservePercentPoints: null } : window.pace, isLimiting: limitingIds.has(window.id) }));
      const limiting = windows.filter((window) => window.isLimiting);
      const scopes = (provider.scopes || []).map((scope) => stale ? { ...scope, percentRemaining: null,
        pace: { status: "unknown", reservePercentPoints: null },
        runway: { status: "unknown", seconds: null, exhaustedAt: null } } : scope);
      const knownScopes = scopes.filter((scope) => valid(scope.percentRemaining));
      const lowest = knownScopes.reduce((a, b) => !a || b.percentRemaining < a.percentRemaining ? b : a, null);
      const critical = stale ? { kind: "unknown" } : limiting.length
        ? { kind: "source-limiting", windows: limiting }
        : lowest ? { kind: "lowest-scope-binding-unknown", scope: lowest } : { kind: "unknown" };
      return { ...provider, stale, ageMs, reusedLabel, staleLabel, windows, scopes, critical };
    });
    const detail = providers.filter(active).sort((a, b) => {
      const left = remaining(a), right = remaining(b);
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      return lowestFirst ? left - right : right - left;
    });
    const inactive = hideInactive ? [] : providers.filter((provider) => !active(provider));
    const sidebar = providers.flatMap((provider, index) => {
      if ((provider.authStatus && provider.authStatus !== "usable") || ["auth_required", "unavailable", "error"].includes(provider.status)) return [];
      const source = reading.providers[index];
      const limits = source.windows?.length ? source.windows : source.scopes || [];
      if (!limits.some((limit) => valid(limit.percentRemaining))) return [];
      const families = provider.windows.length ? groups(provider) : provider.scopes.filter((_, scopeIndex) => valid(source.scopes[scopeIndex].percentRemaining)).map((scope) => ({ name: provider.provider, provider: provider.provider, scope: scope.scope, windows: [{ ...scope, label: scope.scope }] }));
      return families.map((family) => {
        const scopes = family.scope ? provider.scopes.filter((scope) => scope.scope === family.scope)
          : provider.scopes.filter((scope) => scope.boundedBy?.length && scope.boundedBy.every((id) => family.windows.some((w) => w.id === id)));
        const margins = scopes.length ? scopes.map((scope) => runwayMargin(scope, family.windows, now)) : [runwayMargin(null, family.windows, now)];
        const runway = !provider.stale && margins.every(Boolean) ? margins.reduce((a, b) => a.value <= b.value ? a : b) : null;
        const percentages = family.windows.map((w) => w.percentRemaining);
        const capacity = !provider.stale && percentages.length && percentages.every(valid) ? Math.min(...percentages) : null;
        return { ...family, status: provider.status, stale: provider.stale, staleLabel: provider.staleLabel, reusedLabel: provider.reusedLabel,
          sortRemaining: capacity, sortRunway: runway,
          windows: family.windows.map((window) => ({ ...window, stale: provider.stale })) };
      });
    }).sort((a, b) => {
      if (sidebarSort === "source") return 0;
      if (["az", "za"].includes(sidebarSort)) {
        const alphabetical = a.provider.localeCompare(b.provider, "en", { sensitivity: "base" });
        return sidebarSort === "za" ? -alphabetical : alphabetical;
      }
      const left = ["runway", "runway-lowest"].includes(sidebarSort) ? a.sortRunway?.value ?? null : a.sortRemaining;
      const right = ["runway", "runway-lowest"].includes(sidebarSort) ? b.sortRunway?.value ?? null : b.sortRemaining;
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      return ["lowest", "runway-lowest"].includes(sidebarSort) ? left - right : right - left;
    });
    return { detail, inactive, sidebar };
  };
  return { project, groups, marker, windowLabels, windowLabel, valid, remaining, active, ageLabel };
})();
