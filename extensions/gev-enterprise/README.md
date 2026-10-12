# GEV Enterprise extensions — optional local HTTPS/OIDC sidecar

**Scope.** Real server-side OIDC authorization-code + PKCE flow with RS256 ID token validation, in-memory Secure/HttpOnly/SameSite=Lax browser sessions, four hierarchical RBAC roles, real two-stage AEMET OpenData CAP retrieval (server-side secret), an approved read-only aggregate OT file, a bounded HTTPS JSON connector registry, and PDF integrity/signing tools. Default open-source GEV is unchanged until the administrator enables this sidecar. No direct PLC, SIS or DCS access exists.

**Not a turnkey production deployment:** This code cannot authenticate against a real identity provider without its tenant configuration, cannot supply an AEMET API key, cannot obtain approved industrial data, and cannot configure your corporate reverse proxy or security policy. It has unit/integration tests with simulated IdP/provider responses but **no third-party end-to-end or production security audit**. Do not expose Vite or the sidecar to the Internet. Place the full application behind an externally secured HTTPS reverse proxy. Only allow the proxy to reach the loopback sidecar. Reverse proxy MUST preserve the external Host header, route `/api/enterprise/*` to `http://127.0.0.1:4474`, and protect the rest of the app with the organization's established access policy. The sidecar does not authenticate other existing GEV `/api/*` endpoints. Multiple-process/load-balanced deployments need a shared, hardened session store; the example uses memory per instance.

## Requirements

- Node.js **24.14.x** or supported Node.js 26, as required by upstream GEV. (Isolated extension tests also execute on Node 22.)
- Approved identity provider using RS256-signed ID tokens. Register a confidential or PKCE public OIDC client with callback `https://gev.example.org/api/enterprise/auth/callback`. Configure a `roles` array claim containing viewer, analyst, operator or admin; if absent, access is denied. The JWKS host must share the verified issuer's origin; cross-host keys are intentionally not admitted.
- A dedicated HTTPS reverse proxy, identity tenant and enterprise host, and reviewed organization access policies.
- To use AEMET, an administrator-issued API key **stored only in the sidecar environment**.
- To use OT, a prepared allowlisted aggregate JSON *local file* with no addresses, usernames or detailed asset metadata. It is explicitly not SCADA data acquisition or a safety-critical monitoring system.

## Environment (use your own, never commit secrets)

```sh
export GEV_PUBLIC_ORIGIN='https://gev.example.org'
export GEV_OIDC_ISSUER='https://id.example.org/realms/my-realm'
export GEV_OIDC_CLIENT_ID='gods-eye-view'
export GEV_OIDC_JWKS_URI='https://id.example.org/realms/my-realm/protocol/openid-connect/certs'
export GEV_OIDC_AUTHORIZATION_ENDPOINT='https://id.example.org/realms/my-realm/protocol/openid-connect/auth'
export GEV_OIDC_TOKEN_ENDPOINT='https://id.example.org/realms/my-realm/protocol/openid-connect/token'
export GEV_OIDC_CLIENT_SECRET='set-via-secret-manager-not-git'
export GEV_OIDC_ROLES_CLAIM='realm_access.roles'
export AEMET_API_KEY='set-via-secret-manager-not-git'
export GEV_OT_AGGREGATE_FILE='/absolute/approved/read-only/ot-summary.json'
export GEV_CONNECTOR_MANIFEST='/absolute/approved/connectors.json'
node extensions/gev-enterprise/start.mjs
```

**OIDC roles:** `viewer` can read weather; `analyst` can list/consult approved connectors; `operator` can read the approved OT aggregate; `admin` inherits all. GET endpoints use a read-only security model; no actuator or write OT endpoints. OIDC sessions are 60 minutes in-memory, 200 max; the browser receives an opaque Secure HttpOnly cookie, not an ID or access token. Logout invalidates the session. Authorization-code callback requires a matching secure same-site state cookie and PKCE verifier.

**AEMET:** `/api/enterprise/aemet/alerts?area=esp` responds with bounded CAP XML, attribution and retrieval timestamp; cached for 10 minutes. AEMET keys issued without expiry cease to work on **15 October 2026**; obtain a new expiring key and plan rotation. The frontend renders CAP fields as untrusted text, not HTML. It is not a forecasting or operational safety system.

**Connectors:** deploy a reviewed JSON manifest of up to 20 `id`, `title`, `url`, `minRole`, optional `tokenEnv` with a corresponding `GEV_CONNECTOR_...` secret variable. The configured URL must be absolute HTTPS with a public DNS host and no credentials, fragments or query strings. The default Node HTTPS transport pins the TLS connection to a vetted public DNS answer, denies redirects, enforces TLS certificate validation, a 6s deadline, a 256 KiB body ceiling and a per-connector 60s cache. Operators must still enforce host-level egress policy and review data licenses. No remote executable code/plugins are loaded.

**OT summary:** the gateway accepts only `zones: [{id,classification,label?}]` and `conduits: [{from,to,status,observedAt?}]` with bounded collections. This file must be produced independently by an authorized, segregated system: no collector or firewall tunneling into OT is included.

## Evidence PDF signing

1. From Analyst Desk Reports, export the offline HTML report, open it and print/save to `report.pdf`.
2. To produce a **real embedded PDF digital signature**, install pyHanko and provide an X.509 certificate and private key **outside this repository**:

   ```sh
   python -m pip install pyHanko
   python extensions/gev-enterprise/sign-pades.py report.pdf report-signed.pdf --key signer-key.pem --cert signer-cert.pem
   pyhanko sign validate --pretty-print report-signed.pdf
   ```

   No key/certificate is generated or installed automatically. Trust chain and PAdES/LTV assurance depend on real PKI, policy, timestamps, revocation status and signature validation. A self-signed testing certificate does **not** establish trusted identity.
3. An independent detached Ed25519 evidence signature is also supported without extra packages:

   ```sh
   node extensions/gev-enterprise/sign-pdf.mjs sign report.pdf ed25519-private-key.pem
   node extensions/gev-enterprise/sign-pdf.mjs verify report.pdf report.pdf.sig.json ed25519-public-key.pem
   ```

   Detached receipts do not constitute PAdES and should never be described as embedded PDF signatures. Keep private keys outside client or web-serving roots.

## Tests

```sh
node --test extensions/gev-enterprise/enterprise.test.mjs
node --test extensions/gev-intel-core/intel-core.test.mjs src/ui/intelligenceRuntime.test.mjs
npm run format
npm run check:boundaries
npm test
npm run build
```

No credentials, client secrets or signed PDF private keys should appear in browser JavaScript or in Git. See `docs/FORK-ENTERPRISE-DEPLOYMENT.md` and the project `SECURITY.md` for deployment responsibilities.
