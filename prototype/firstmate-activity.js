import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { discoverTranscriptInventory } from "./transcript.js";

// Read file clocks, not event payloads. Discovery uses the same confined primary
// transcript resolver as Fleet Chats; never scan another home's sessions.
export async function readFirstmateActivity(home, options = {}) {
  const result = { lastTurnAt: null, lastWakeAt: null, watcherBeatAt: null, heartbeatAt: null, readAt: null };
  if (home) {
    try {
      const root = await realpath(home);
      const clock = async (name) => {
        try {
          const file = await realpath(path.join(root, "state", name));
          if (!file.startsWith(`${root}${path.sep}`)) return null;
          const info = await stat(file);
          return info.isFile() ? info.mtime.toISOString() : null;
        } catch { return null; }
      };
      [result.lastWakeAt, result.watcherBeatAt, result.heartbeatAt] = await Promise.all([
        clock(".wake-queue"), clock(".last-watcher-beat"), clock(".last-heartbeat"),
      ]);
      try {
        const { inventory, active } = await discoverTranscriptInventory(root, options);
        const primary = inventory.filter(({ file, source }) => active.has(file)
          && /^(claude-main-session|main-pi-session|state\/main-session)\//.test(source));
        if (primary.length) result.lastTurnAt = new Date(Math.max(...primary.map(({ changed }) => changed))).toISOString();
      } catch { /* Unreadable transcript evidence stays unknown. */ }
    } catch { /* Missing or unreadable home stays unknown. */ }
  }
  result.readAt = new Date().toISOString();
  return result;
}
