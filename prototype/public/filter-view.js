// Lane + kind filter presentation: markup builders and bulk sync. No app state ownership.
// One Select all ↔ Clear smart toggle via bulkControls (desktop + mobile).
window.filterView = (() => {
  function kindGlyph(type, escapeHtml) {
    // H4 — Lucide-like stroke SVGs from messageKinds; never emoji / blank wells.
    const mark = type.svg || window.messageKinds?.svg?.(type.id) || window.messageKinds?.ICONS?.help || "";
    return `<span class="message-kind-glyph" data-kind="${escapeHtml(type.id)}" aria-hidden="true">${mark}</span>`;
  }

  function kindFiltersHtml(types, selectedIds, escapeHtml) {
    return types.map((type) => `
    <label class="message-type-option" title="${escapeHtml(type.label)}">
      <input type="checkbox" value="${escapeHtml(type.id)}" aria-label="${escapeHtml(type.label)}" ${selectedIds.has(type.id) ? "checked" : ""}>
      ${kindGlyph(type, escapeHtml)}<span class="message-kind-label">${escapeHtml(type.label)}</span>
    </label>`).join("");
  }

  function syncKindsBulk({ types, selectedIds, syncBulk, nodes }) {
    const all = types.length > 0 && types.every((type) => selectedIds.has(type.id));
    const none = selectedIds.size === 0;
    syncBulk({
      all,
      none,
      disabled: types.length === 0,
      toggle: nodes.toggle,
      noun: "message kinds",
    });
  }

  function renderKindFilters({ types, selectedIds, escapeHtml, syncBulk, root, nodes }) {
    if (root) root.innerHTML = kindFiltersHtml(types, selectedIds, escapeHtml);
    syncKindsBulk({ types, selectedIds, syncBulk, nodes });
  }

  function laneShortName(name) {
    const raw = String(name || "").trim();
    if (!raw) return "?";
    const parts = raw.split(/[\s/_-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0].slice(0, 2) + parts[1].slice(0, 1)).slice(0, 4);
    return raw.slice(0, 4);
  }

  function laneOptionHtml(lane, checked, escapeHtml, stateLabel) {
    return `<label class="lane-option${checked ? " is-selected" : ""}${lane.id === "general" ? " pinned" : ""}" data-lane-id="${escapeHtml(lane.id)}">
    <input type="checkbox" data-filter-lane="${escapeHtml(lane.id)}" ${checked ? "checked" : ""}>
    <span class="toggle-check" aria-hidden="true"></span>
    <span class="lane-option-copy" title="Solo ${escapeHtml(lane.name)}"><strong>${escapeHtml(lane.name)}</strong><small>${escapeHtml(stateLabel(lane.status))}</small></span>
    ${lane.id === "general" ? '<span class="pin-label">Pinned</span>' : ""}
  </label>`;
  }

  function laneFiltersHtml(lanes, checkedIds, escapeHtml, stateLabel) {
    return lanes.map((lane) => laneOptionHtml(lane, checkedIds.has(lane.id), escapeHtml, stateLabel)).join("");
  }

  function statusOptionsHtml(statuses, escapeHtml, stateLabel) {
    return '<option value="all">All live statuses</option>' + statuses.map((status) =>
      `<option value="${escapeHtml(status)}">${escapeHtml(stateLabel(status))}</option>`).join("");
  }

  function syncLanesBulk({ all, none, disabled, syncBulk, nodes }) {
    syncBulk({
      all,
      none,
      disabled,
      toggle: nodes.toggle,
      noun: "fleets",
    });
  }

  function collapsedRailHtml(lanes, checkedIds, escapeHtml, all = lanes.length > 0 && lanes.every((lane) => checkedIds.has(lane.id))) {
    const pinned = `<button type="button" class="lane-rail-item lane-rail-all" data-filter-all="true" aria-label="Select all live fleets" aria-pressed="${all}"${lanes.length ? "" : " disabled"}><span>All</span></button>`;
    return pinned + lanes.map((lane) => {
      const short = escapeHtml(laneShortName(lane.name));
      const selected = checkedIds.has(lane.id);
      return `<button type="button" class="lane-rail-item${selected ? " is-selected" : ""}" data-lane-id="${escapeHtml(lane.id)}" aria-pressed="${selected}" aria-label="${escapeHtml(lane.name)} · solo fleet" title="${escapeHtml(lane.name)} · tap to solo"><svg class="lane-rail-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v5a4 4 0 0 0 4 4h5"/></svg><span aria-hidden="true">${short}</span></button>`;
    }).join("");
  }

  // Pure presentation of the lane filter panel. Caller owns statusFilter mutation.
  function renderLaneFilters({
    filterLanes, liveStatuses, statusFilter, checkedIds, selectionAll, checkedCount, liveCount,
    escapeHtml, stateLabel, syncBulk, statusSelect, rowsRoot, railRoot, nodes,
  }) {
    let nextStatus = statusFilter;
    if (nextStatus !== "all" && !liveStatuses.includes(nextStatus)) nextStatus = "all";
    if (statusSelect) {
      statusSelect.innerHTML = statusOptionsHtml(liveStatuses, escapeHtml, stateLabel);
      statusSelect.value = nextStatus;
    }
    if (rowsRoot) rowsRoot.innerHTML = laneFiltersHtml(filterLanes, checkedIds, escapeHtml, stateLabel);
    if (railRoot) railRoot.innerHTML = collapsedRailHtml(filterLanes, checkedIds, escapeHtml, selectionAll);
    syncLanesBulk({
      all: selectionAll,
      none: liveCount === 0 || checkedCount === 0,
      disabled: liveCount === 0,
      syncBulk,
      nodes,
    });
    return { statusFilter: nextStatus };
  }

  return {
    kindGlyph,
    kindFiltersHtml,
    syncKindsBulk,
    renderKindFilters,
    laneShortName,
    laneOptionHtml,
    laneFiltersHtml,
    statusOptionsHtml,
    syncLanesBulk,
    collapsedRailHtml,
    renderLaneFilters,
  };
})();
