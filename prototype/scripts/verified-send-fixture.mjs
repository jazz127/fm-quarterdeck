// Synthetic verified Quarterdeck sends for offline browser passes: the note and request
// reservation stock `fm-inbox.sh note --request-id` writes for a review batch.
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { formatReviewNote } from "../review-note.js";

export async function writeVerifiedReviewNote(home, { at, prompt, route = "#lanes", handled = false }) {
  const hex = createHash("sha256").update(`${at}\n${prompt}`).digest("hex");
  const batchId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const id = `${Math.floor(Date.parse(at) / 1000)}-${hex.slice(0, 6)}`;
  const requestId = `agentos-review:${batchId}`;
  const inbox = path.join(home, "state", "inbox");
  await mkdir(path.join(inbox, ".requests"), { recursive: true });
  await mkdir(path.join(inbox, "handled"), { recursive: true });
  const body = formatReviewNote({ schema: "fm-agentos-review.v2", batchId, version: "synthetic", route, end: false, entries: [{ prompt, tag: "message", selector: "", text: "" }] });
  await writeFile(path.join(inbox, ".requests", requestId), `${id}\n`);
  await writeFile(path.join(inbox, ...(handled ? ["handled"] : []), `${id}.note`), `id=${id}\nat=${at}\nsource=text\nannounce_marker=1\nrequest_id=${requestId}\n--\n${body}\n`);
  return { id, batchId, requestId };
}
