// Complete neutral producer-shaped record; no runtime transcript values.
export const awaySummary = (content = "The sample checks completed.", extra = {}) => ({
  parentUuid: "synthetic-parent", isSidechain: false, type: "system", subtype: "away_summary",
  content, timestamp: "2030-01-02T10:00:00.000Z", uuid: "synthetic-recap", isMeta: false,
  sessionKind: "interactive", userType: "external", entrypoint: "cli", cwd: "/synthetic/home",
  sessionId: "synthetic-primary", version: "2.1.296", gitBranch: "main", ...extra,
});
