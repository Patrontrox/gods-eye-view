# Optional enterprise extension: implementation and limitations

This fork's **Enterprise** tab in Analyst Desk works only when the additional Node sidecar is configured and placed behind a trusted HTTPS reverse proxy under the same origin. It is **OFF by default**. Original GEV `/api` routes remain untouched. Never publicly expose the Vite development server.

### Implemented

- OIDC authorization-code exchange with PKCE, validated issuer/audience/nonces/signature and secure browser session.
- Role-based access to official AEMET CAP alerts (server-side API key), to a read-only approved OT aggregate file, and to declarative HTTPS JSON connectors.
- Regional alerts rendered from CAP XML as text, with source attribution and timestamp. No false claim of global coverage.
- Deterministic PDF integrity receipts using Ed25519 and embedded X.509 PDF signing available through optional pyHanko CLI workflow.
- Optional enterprise tab integrated with the rest of the local-first Analyst Desk.

### Requires configuration and production review

- Actual OIDC client registration, role claims, real tenant testing, resilient session storage, logging/audit policy, reverse proxy, TLS and infrastructure security assessment.
- AEMET API key and source access, responsible attribution and rotation; no official notices are embedded offline.
- Authorization and independent production of sanitized OT aggregates. The app makes **zero requests to plant equipment**.
- Real X.509 signer/cert trust and optional TSA/validation information; no trust assurance without deploying PKI.
- Runtime QA with real Cesium/GPU and end-to-end E2E provider flows.

This is a built and tested **reference implementation of the integration**, not an externally deployed, accredited or independently audited industrial production system.
