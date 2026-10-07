import { createGitIdentity } from "./git-identity.js";

// One bounded Git probe is shared by simultaneous requests. A dirty checkout is
// never published as a new revision (nor served under an old revision).
export function createRevisionResolver(root, initial, { intervalMs = 250, git } = {}) {
  const identity = createGitIdentity(root, { git });
  let next = 0;
  let pending;
  let result = initial;
  return {
    get initial() { return initial; },
    async snapshot(force = false) {
      if (pending) return pending;
      if (!force && Date.now() < next) return result;
      pending = (async () => {
        try {
          const head = await identity.snapshot();
          if (!head) throw new Error("Serving identity unavailable");
          // Imported backend modules belong to the startup commit. Even a clean
          // fast-forward needs a process restart, never a new badge on old code.
          if (head !== initial || !/^[a-f0-9]{40}$/.test(initial)) throw new Error("Serving revision changed; restart required");
          result = initial;
        } catch { result = null; }
        next = Date.now() + intervalMs;
        return result;
      })().finally(() => { pending = null; });
      return pending;
    },
  };
}
