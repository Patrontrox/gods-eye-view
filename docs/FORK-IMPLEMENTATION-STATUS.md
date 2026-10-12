# Patrontrox implementation status — 13 October 2026

The first hardening set from 12 October is now bundled with the **optional Analyst Desk integration source and Enterprise sidecar**. It has not been applied to GitHub because this session cannot write to the repository and does not have the full checkout/dependencies. Read `PATRONTROX-ANALYST-DESK.md` for detailed capabilities and limits. The installer adds an entry to `src/app/tools.js` and registers the UI in the application's lifecycle.

## Locally coded, partially verified

- Phase-one coordinate, Cesium zero-framebuffer, aircraft provider budget and Director observer safeguards.
- In-app **GIS**: GeoJSON/KML/GPX import → Cesium `GeoJsonDataSource`, styling/opacity, zoom, visibility, export/delete.
- In-app **History**: explicitly opted-in IndexedDB recording (manual or user-enabled periodic sampling), bounded seven-day retention on prune, replay slider/points and CSV export.
- In-app **Geofence**: local polygon rules, saved locally, optional monitoring and browser notifications.
- In-app **Analysis**: bounded non-causal proximity matches between loaded source records and local history.
- In-app **Workspaces**: local save, restore and JSON export/import of safe camera/layer/visual state.
- In-app **Reports**: escaped standalone HTML report, print-to-PDF option via browser.
- In-app **Weather**: one-time Open-Meteo forecast at camera coordinates (not official AEMET/EUMETSAT warnings).
- In-app **Cyber/OT**: offline aggregate zone/conduit import, no device-level topology or production network access.
- Optional **Enterprise**: real OIDC authorization-code + PKCE implementation, ID-token RS256 checks, in-memory secure sessions and role-gated APIs; requires a provisioned identity tenant and secure full-site deployment.
- Optional **official AEMET** weather alerts: two-stage bounded CAP retrieval and typed UI, secret on backend; availability and live schema not yet verified.
- Optional **enterprise connectors**: reviewed declarative HTTPS JSON sources, pinned DNS-to-TLS transport, time/size limits and RBAC.
- Optional **PDF signing**: Ed25519 detached integrity receipts and pyHanko CLI integration for embedded X.509 PDF signing. Real PKI and pyHanko signing not run in this environment.
- In-app **Performance**: manual Cesium resolution scale preset and opt-in adaptive frame-timing mode.
- Source status listing for enabled layers, test harnesses and modified package-boundary/format configuration.

## Still not fully implemented, signed off or deployed

- Actual repository integration: installer **must be applied** to exact base checkout and reviewed; `main` is unchanged.
- CI `npm ci`, full test suite, browser tests with actual Cesium, and real GPU performance regression evidence.
- OIDC/RBAC backend is implemented as an opt-in sidecar, **not** provisioned or externally tested. Production setup still requires tenant, full-site proxy authentication, shared sessions, auditing, deployment reviews and authenticated sharing.
- An opt-in read-only corporate gateway for locally approved aggregates is implemented, but actual authorized OT feeds and corporate telemetry ingestion are not configured or deployed. Any SIS/DCS/PLC access remains strictly excluded.
- An AEMET CAP adapter is implemented, but a live API key and end-to-end testing are pending. EUMETSAT authenticated services and wider European radar/alert data remain unimplemented.
- A bounded declarative connector system is implemented; arbitrary executable plugin sandbox, automatic multiuser sync and large-scale streaming ingestion are not.
- PDF signing is implemented via a pyHanko CLI integration (not installed/tested here) and detached Ed25519 receipts; PKI/TSA/revocation assurance, advanced case lifecycle and per-provider retention policies remain.
- Full GIS editing, KML extended styles, GPX styling, Shapefile/GeoPackage, geofence antimeridian cases and guaranteed route safety.

The project remains experimental, local-first and not suitable for safety-critical or public production deployment without independent security validation.
