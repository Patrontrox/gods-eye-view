# Patrontrox fork: staged roadmap (2026-10-12)

This is a planning and acceptance document, not an assertion that the features exist.
The first hardening slice is deliberately narrow and does not change default-branch behavior until reviewed.

## Stage 1: security, reliability and quality
- Fix malformed coordinate parsing; test empty coordinate components and search fallback.
- Bound OpenSky track backfill and adsb.lol trace admission; coalesce duplicates; respect 429 cooldowns.
- Safely suspend Cesium rendering on zero-sized viewports and resume when visible.
- Isolate Director and scene-clock observers; preserve primary exceptions and release scenes once.
- Validate CI: Node 24/26, Windows onboarding, formatting, package boundaries, unit suite, production build.
- Introduce license inventories and secret-leak scanning; commercial releases must exclude restricted datasets.
- Establish an error/provenance convention: source, observed_at, received_at, modelled flag, expiry, confidence.

## Stage 2: performance and UX
- Camera-intent scheduler: defer optional data refinements while moving and collapse stale updates.
- Adaptive budgets (target FPS, text labels, imagery, 3D primitives, memory), with A/B GPU benchmarks.
- UI workspaces and persistence, search validation, recovery and provider-health states.
- Provider usage dashboard and per-source quotas, alerts on low credits.

## Stage 3: investigations and history
- Local, explicitly opt-in history database (SQLite, optional PostGIS), retention, encryption and replay.
- GIS imports (GeoJSON/KML/GPX first), attribution, bounded parsing and memory caps.
- Generalized geo-fence rules, event notifications, acknowledgments and deduplication.
- Source-aware entity correlation, audited evidence chains and PDF/HTML reporting.
- Extend weather source coverage to Spain/Europe via licensed authoritative data.

## Stage 4: extensibility and secure specialized modules
- Stable plugin interfaces for read-only registered data sources; signed manifests and isolation.
- Private OT/Cyber viewer with segregated read-only ingestion; model IEC 62443 zones/conduits.
- No direct Internet access to OT/ICS, no scanning of operational endpoints, no automated OT control.
- Authentication/RBAC and a separate production service architecture; avoid exposing a Vite dev server.

## Gates for all stages
- Changes start in a branch and land via reviewed PR, not direct edits to main.
- All tests and boundary checks pass on a compatible Node version.
- Source freshness, uncertainty and provenance are visible; no safety-critical usage claims.
- Explicit data-license review for every new source, especially commercial/non-commercial restrictions.
- Local-first and no named-person tracking or identification.
