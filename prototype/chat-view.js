// Advisory UI snapshot only. Never parse it as a prompt or use it to choose a destination.
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...names].sort().join(",");
const label = (value, max) => typeof value === "string" && value.length <= max && !/[\x00-\x1f]/.test(value);
const date = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const anchor = (value) => value === null || (keys(value, ["id", "at"]) && label(value.id, 300) && value.id.length > 0 && date(value.at));
const routePattern = /^#(?:lanes(?:\/[^\s#?]*)?|overview|work|expenses|quota|preferences|closed)$/;
const kinds = new Set(["captain", "conversation", "supervision", "thinking", "steer", "crew", "branch", "tools", "harness", "input"]);

export function validChatView(view, route, branch, commit) {
  if (!keys(view, ["schema", "capturedAt", "route", "served", "lanes", "filters", "visible"]) ||
      JSON.stringify(view).length > 4096 || view.schema !== "fm-agentos-chat-view.v1" || !date(view.capturedAt) ||
      view.route !== route || !routePattern.test(view.route) ||
      !keys(view.served, ["branch", "commit"]) || view.served.branch !== branch || view.served.commit !== commit ||
      !Array.isArray(view.lanes) || view.lanes.length > 32 ||
      !view.lanes.every((lane) => keys(lane, ["id", "name"]) && label(lane.id, 100) && lane.id.length > 0 && label(lane.name, 120) && lane.name.length > 0) ||
      new Set(view.lanes.map((lane) => lane.id)).size !== view.lanes.length ||
      !keys(view.filters, ["kinds", "search", "searchTruncated", "session", "diskSession", "page"]) ||
      !Array.isArray(view.filters.kinds) || view.filters.kinds.length > kinds.size ||
      !view.filters.kinds.every((kind) => kinds.has(kind)) || new Set(view.filters.kinds).size !== view.filters.kinds.length ||
      !label(view.filters.search, 160) || typeof view.filters.searchTruncated !== "boolean" ||
      !label(view.filters.session, 160) || !label(view.filters.diskSession, 160) ||
      !(view.filters.page === null || (Number.isSafeInteger(view.filters.page) && view.filters.page >= 0)) ||
      !keys(view.visible, ["first", "last", "focused"]) ||
      !anchor(view.visible.first) || !anchor(view.visible.last) || !anchor(view.visible.focused) ||
      Boolean(view.visible.first) !== Boolean(view.visible.last)) return false;
  return true;
}
