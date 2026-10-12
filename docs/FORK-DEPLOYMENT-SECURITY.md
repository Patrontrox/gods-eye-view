# Deployment boundary — Patrontrox fork

This patch **does not** make the existing Vite server safe for public multiuser production use. The original system is local-first. Until the optional gateway has been configured, deployed and independently reviewed, keep the app bound to loopback and protected from untrusted networks.

## Production target (partially implemented in optional Enterprise sidecar)

1. Reverse proxy with TLS, strict origin/host policy, and explicitly configured trusted-proxy networks only.
2. OIDC login, short-lived sessions, roles, anti-CSRF for state-changing endpoints and purpose-specific API rate limits.
3. Per-provider budgets and finite request concurrency across **all** API families, not just the aircraft trace hardening patch.
4. Structured server logs with redaction, audit events and safe error surfaces; alert on quota or credential abuse.
5. Secrets in a server-side store, restricted browser keys by referrer/API, no credentials in workspace or share URLs.
6. Separate public OSINT and private OT data planes; only aggregate, approved, read-only OT observations may reach a private authorized UI.
7. No routable path from a public web app into any DCS/SIS/PLC, no automatic ICS scanning or operational commands.

Security review must include SSRF, unsafe URL redirects, WebSocket/MCP access, stream and JSON body caps, login-session fixation, CORS/CSRF, license/source terms and emergency-stop availability. Do not treat 'localhost' origin checks as user authentication.
