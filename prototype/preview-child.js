// Fixed controller-owned launcher, never registry argv. The IPC lifetime binds this
// child to its launching controller; a crash cannot leave a serving orphan.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { proveCheckout } from "./preview-lifecycle.js";

let server;
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 2500);
  deadline.unref();
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
}
process.on("disconnect", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
try {
  if (!process.send || !process.connected || !/^[0-9a-f-]{36}$/.test(process.env.FM_PREVIEW_GENERATION || "")) throw new Error("Controller IPC required");
  const checkout = process.cwd();
  await proveCheckout(path.dirname(checkout), path.basename(checkout), process.env.FM_PREVIEW_COMMIT, "");
  const { createServer } = await import(pathToFileURL(path.join(checkout, "prototype/server.js")));
  // Quota is a shared stable-host read. Do not spawn account/provider helpers
  // from an isolated preview (including on direct loopback requests).
  server = createServer(process.env, { quotaReader: async () => ({ available: false, subscriptions: [], providers: [], error: "Quota is served by the stable gateway" }) });
  server.on("error", close);
  server.listen(Number(process.env.PORT), "127.0.0.1", () => {
    if (!process.connected) return close();
    process.send({ generation: process.env.FM_PREVIEW_GENERATION, port: server.address().port, commit: process.env.FM_PREVIEW_COMMIT });
  });
} catch { close(); }
