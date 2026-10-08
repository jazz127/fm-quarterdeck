(() => {
const statusLabels = { active: "Active", review: "In review", waiting: "Waiting / external delay", "captain-action": "Captain action", cleanup: "Retained / cleanup", unknown: "Unknown evidence", backlog: "Backlog", "newly-done": "Newly done", "previously-done": "Previously done" };
const statusConciseLabels = { active: "Active", review: "In review", waiting: "Waiting", "captain-action": "Captain action", cleanup: "Cleanup", unknown: "Unknown", backlog: "Backlog", "newly-done": "Newly done", "previously-done": "Previously done" };
const statusAbbreviations = { active: "A", review: "V", waiting: "W", "captain-action": "C", cleanup: "R", unknown: "U", backlog: "B", "newly-done": "N", "previously-done": "P" };
function groupHierarchy(items) {
  const repos = new Map();
  for (const item of items) {
    if (!repos.has(item.repositoryId)) repos.set(item.repositoryId, { id: item.repositoryId, name: item.repository, lanes: new Map(), items: [] });
    const repo = repos.get(item.repositoryId); repo.items.push(item);
    if (!repo.lanes.has(item.lane.id)) repo.lanes.set(item.lane.id, { ...item.lane, themes: new Map(), items: [] });
    const lane = repo.lanes.get(item.lane.id); lane.items.push(item);
    if (!lane.themes.has(item.theme.id)) lane.themes.set(item.theme.id, { ...item.theme, items: [] });
    lane.themes.get(item.theme.id).items.push(item);
  }
  return [...repos.values()];
}
function statusCounts(items) { return Object.fromEntries(Object.keys(statusLabels).map((status) => [status, items.filter((item) => ["newly-done", "previously-done"].includes(status) ? (item.completionAttention || item.status) === status : item.status === status || (status === "unknown" && item.completionAttention === "unknown")).length])); }
window.workHierarchy = { statusLabels, statusConciseLabels, statusAbbreviations, groupHierarchy, statusCounts };
})();
