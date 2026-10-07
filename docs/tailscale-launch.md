# User-run private UAT launcher

From a **clean, committed, operator-approved local UAT checkout**:

```bash
FM_HOME=/absolute/path/to/firstmate node prototype/scripts/tailscale-launch.mjs
# Help (no network or configuration operations):
node prototype/scripts/tailscale-launch.mjs --help
```

Requires Node 18+, Git, a readable absolute Firstmate home, and an installed/authenticated Tailscale CLI with HTTPS certificates and Serve enabled for the device. Restrict tailnet ACLs/grants to intended reviewers: all preview read APIs are exposed to them. No package installation is needed. The launcher discovers the device's exact `https://<device>.<tailnet>.ts.net` origin; it never enables Funnel or changes a firewall.

The script stays **in the foreground**, imports the existing app directly and atomically binds only `127.0.0.1:4173`. Optional `PORT` changes that loopback port; `HOST=0.0.0.0` is rejected. Set `TAILSCALE_BIN` to an executable path if needed (otherwise `tailscale`, then `tailscale.exe` on PATH). Serve must reach the same network namespace. For Windows/WSL, the raw external request must demonstrably arrive at this owned listener; no relay, Host rewrite, or assumed localhost forwarding is added. A namespace mismatch fails verification and rolls back.

It sets `FM_DEPLOYMENT_TIER=uat` and `FM_REVIEW_ALLOWED_ORIGIN` to the discovered exact origin. Optional `FM_REVIEW_STATUS_PATH` is passed through; review receipt/intake behavior remains the [existing contract](../README.md#private-tailscale-serve-review-optional). Registry/preview-root and Lavish configurations are rejected: this is standalone UAT, not a new preview controller. It does not publish, change a branch, or imply Main approval. Avoid inherited Git environment overrides.

## Safety and verification

Any existing HTTPS root route on port 443 is **unowned**, even if it points to the same port or SHA. The launcher refuses it rather than adopting or replacing it. Likewise, an occupied app port is never killed or adopted. Existing paths such as `/other` and other Serve ports are preserved. Funnel, TCP forwarding on 443, unknown Serve configuration shapes and ambiguous hostnames are rejected. Do not concurrently edit Serve configuration; the CLI offers no compare-and-swap transaction. Snapshots are checked before and after changes, and cleanup refuses a changed configuration.

Before printing **ready**, it checks local and real HTTPS health (`ok:true`, service `fm-quarterdeck`) and `/api/review` against the exact clean checkout SHA. An external non-JSON review POST must arrive on the owned server with the original exact Host and Origin and return 415. This proves the origin guard without creating a receipt or sending a note. A proxy that rewrites evidence, or another service in a different namespace with the same SHA, cannot pass. Requests use verified HTTPS certificates, not insecure TLS. Keep this terminal open and use the reported URL from an authorized tailnet browser.

Repeat while a copy is running: refusal, no reconfiguration. Repeat after orderly shutdown: starts fresh and verifies again. UAT retains its established clean-fast-forward revision behavior; the printed revision is launch-time evidence, so recheck `/api/review` after later checkout updates.

## Exact stop and removal procedure

**Normal:** press Ctrl-C in this terminal (or send SIGTERM to this exact foreground launcher). It removes only its unchanged `:443` root handler using:

```bash
tailscale serve --https=443 --set-path=/ off
```

It verifies the prior Serve routes are restored, then closes its own server object. On startup failure it follows the same rollback. If removal fails or the configuration changed, it leaves the route untouched, stops only its own app, exits with an error, and asks for inspection. Never use `tailscale serve reset`, broad `serve off`, kill-by-port, or kill-by-name.

**Crash/SIGKILL/terminal loss:** there is no daemon or PID-file adoption. The app exits with its foreground process, but the background Serve route may remain. A new run refuses that route. Inspect `tailscale serve status --json` on the **owning device** (substitute the same `TAILSCALE_BIN` executable). Independently confirm the failed launcher is gone and that `Web["<device>.<tailnet>.ts.net:443"].Handlers["/"].Proxy` is exactly its printed `http://127.0.0.1:<port>`, not a route now owned by another service. Only then, explicitly remove that one handler with the scoped command above. Inspect status again to verify unrelated paths/ports remain. If ownership is uncertain, do not remove it; ask the operator. Retry only after the root route and app port are free.

The current private UAT deployment already occupies 4173 and its root Serve route: this script intentionally **cannot take it over**. Arrange an approved maintenance window and use that deployment's own stop/removal procedure before launch. Implementation/tests did not change it.

## Package-free validation

```bash
node --test prototype/test/tailscale-launch.test.mjs
cd prototype && npm test
```

Launcher tests double commands, local probes, the server, and external HTTPS; they never mutate live Serve or use port 4173. CLI syntax/config shape was inspected read-only with installed Tailscale 1.102.4 (`serve --help`, `serve status --help`, `status --help`, `serve status --json`). Live launch acceptance must be performed by the operator after approved route/listener clearance; unit tests are not running-deployment evidence.
