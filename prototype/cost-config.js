// Public defaults contain no operator projects. Selected-home costs.json owns attribution.
export const defaultAttribution = Object.freeze({});
export const validCostTag = (value) => typeof value === "string" && /^[A-Za-z][\w-]{0,50}$/.test(value);
const reserved = (value) => ["__proto__", "prototype", "constructor", "unclassified"].includes(value.toLowerCase());

export function validateCostConfiguration(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join() !== "attribution,azureTag,schema" || value.schema !== "fm-agentos-costs.v1" ||
      (value.azureTag !== null && !validCostTag(value.azureTag)) || !value.attribution || Array.isArray(value.attribution) || typeof value.attribution !== "object") throw new Error("Invalid cost configuration");
  const entries = Object.entries(value.attribution);
  if (entries.length > 100 || entries.some(([tag, label]) => !/^[a-z0-9][a-z0-9 .:/+-]{0,89}$/.test(tag) || reserved(tag) || typeof label !== "string" || !/^[\w .:/+-]{1,90}$/.test(label) || label.trim() !== label || reserved(label))) throw new Error("Invalid cost attribution");
  return value;
}

export function defaultCostConfiguration(env = {}) {
  return { schema: "fm-agentos-costs.v1", azureTag: validCostTag(env.FM_COST_ATTRIBUTION_TAG) ? env.FM_COST_ATTRIBUTION_TAG : null, attribution: { ...defaultAttribution } };
}

export function emptyAttribution(mapping = defaultAttribution, total = null) {
  return { ...Object.fromEntries(Object.values(mapping).map((name) => [name, null])), unclassified: total };
}
