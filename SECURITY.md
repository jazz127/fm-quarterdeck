# Security policy

Quarterdeck is a source preview, not a supported hosted service or a promise of production readiness. There is no stable release support window or response-time guarantee yet; security fixes target the repository owner's current reviewed source candidate.

## Reporting

Once the public repository exists, the owner must enable **GitHub Private Vulnerability Reporting** before inviting security reports. Use that repository's **Security → Advisories → Report a vulnerability** flow. This document does not claim a repository or reporting channel is already available.

Do not post exploit details, credentials, private transcripts, expense data, home paths or runtime receipts in public issues, discussions or contribution requests. If private reporting is unavailable, use an already-established confidential channel to the repository owner to request a safe reporting route; do not invent an email address or send sensitive details publicly. Share only the minimum redacted reproduction and exact affected revision. Test only systems/data you are authorized to access.

## Runtime boundary

Use a maintained Node release and the documented [platform/validation baseline](docs/PORTABILITY.md). Keep actual Quarterdeck listeners loopback or private-tailnet. Account integrations run as the operator; read APIs can expose private information even when writes are origin-guarded. Source publication does not authorize a public deployment. Never include runtime homes or old Git history in an export; follow [history-free verification](docs/HISTORY-FREE-EXPORT.md).

The application has no per-user login, authorization or tenant isolation. Every client able to reach its listener is within the trusted operator boundary. Host/Origin write checks prevent unintended cross-origin requests; they are not authentication and do not protect read APIs from a reachable client. Public multi-user hosting requires a separate authentication and isolation design. Optional private proxies must restrict who can connect.
