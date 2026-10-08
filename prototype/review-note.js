import { validV2Entry, validReviewRoute } from "./review-v2.js";

export function formatReviewNote(payload) {
  const preview = [...new Set([payload.provenance?.preview, payload.provenance?.branch, payload.provenance?.remoteCheckpoint].filter(Boolean))].join(" · ") || "standalone";
  const review = { schema: payload.schema, batch: payload.batchId, route: payload.route, version: payload.version, end: payload.end, preview };
  // Escape backticks in JSON so user-authored fences cannot terminate the envelope.
  const block = JSON.stringify({ review, prompts: payload.entries }).replace(/`/g, "\\u0060");
  return `Quarterdeck review: ${payload.entries.length} notes on ${payload.route}\n\n${payload.entries.map((entry, i) => `${i + 1}. ${entry.prompt}`).join("\n")}\n\n\`\`\`json fm-review\n${block}\n\`\`\``;
}

export function parseReviewNote(body) {
  if (typeof body !== "string" || body.length > 4_000_000) return null;
  try {
    if (body.startsWith("Quarterdeck review:")) {
      const block = body.match(/\n```json fm-review\n([^]*?)\n```\s*$/);
      if (!block) return null;
      const { review, prompts } = JSON.parse(block[1]);
      if (review?.schema !== "fm-agentos-review.v2" || !/^[0-9a-f-]{36}$/i.test(review.batch || "") || !validReviewRoute(review.route) || typeof review.version !== "string" || review.version.length > 100 || typeof review.end !== "boolean" || typeof review.preview !== "string" || review.preview.length > 1000 || !Array.isArray(prompts) || prompts.length < 1 || prompts.length > 30 || !prompts.every(validV2Entry)) return null;
      return { batch: review.batch, route: review.route, version: review.version, end: review.end, preview: review.preview, prompts };
    }
    const header = body.match(/^(?:Quarterdeck|Agent OS) review annotation batch ([0-9a-f-]{36})\nVersion: ([^\n]+)\nRoute: ([^\n]+)\nEnd: (true|false)\nPreview: ([^\n]*)\nEntries:\n([^]*)$/i);
    if (!header || !validReviewRoute(header[3])) return null;
    const chunks = [...header[6].matchAll(/^(\d+)\. (message|annotation|lane-message-annotation) · ([^\n]+?) · ([^\n]*)\n([^]*?)(?=\n\n\d+\. (?:message|annotation|lane-message-annotation) · |$)/gm)];
    if (!chunks.length || chunks.length > 30 || chunks.map((chunk) => chunk[0]).join("\n\n").trim() !== header[6].trim()) return null;
    const prompts = chunks.map((chunk, i) => {
      if (Number(chunk[1]) !== i + 1 || !validReviewRoute(chunk[3]) || !chunk[5].trim() || chunk[5].length > 4000) throw new Error("Invalid legacy prompt");
      const entry = { prompt: chunk[5].trimEnd(), tag: chunk[2] === "message" ? "message" : "element", selector: "", text: "" };
      if (chunk[3] !== header[3]) entry.route = chunk[3];
      if (chunk[4].startsWith("Lane Chat message quote ")) {
        const quote = JSON.parse(chunk[4].slice(24));
        if (typeof quote.text !== "string" || typeof quote.time !== "string" || !Array.isArray(quote.lanes) || quote.lanes.length > 30 || quote.lanes.some((lane) => typeof lane !== "string" || lane.length > 160)) throw new Error("Invalid legacy quote");
        entry.record = { quoteTime: quote.time.slice(0, 120), quoteLanes: quote.lanes, quoteExcerpt: quote.text.slice(0, 240) };
      } else if (chunk[4].startsWith("Lane Chat record ")) entry.record = { recordId: chunk[4].slice(17, 1017) };
      else if (entry.tag !== "message") {
        const region = chunk[4].match(/^([^]*) \(([^()]*)\)$/);
        entry.label = (region?.[1] || chunk[4]).slice(0, 160);
        entry.selector = (region?.[2] || "").slice(0, 512);
      }
      return entry;
    });
    return { batch: header[1], version: header[2].slice(0, 100), route: header[3], end: header[4] === "true", preview: header[5].slice(0, 1000), prompts };
  } catch { return null; }
}
