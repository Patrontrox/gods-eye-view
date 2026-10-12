# Patrontrox Intelligence Desk — implementation notes

## Entry point

The integration is **in the main running application's lifecycle**, not a detached demo:

- `src/app/tools.js` instantiates `createIntelligenceConsole({ viewer, dataManager, signal })`, registers teardown through `defer`, and exposes a diagnostic handle on `window.__godsEyeView.intelligenceDesk`.
- `src/ui/intelligenceConsole.js` creates the launcher **ANALYST** and accessible `GIS`, `History`, `Alerts`, `Analyze`, `Workspaces`, `Reports`, `Weather`, `Cyber/OT`, `Settings` panels. All use the application's existing Cesium `Viewer` and `LayerLifecycle`.
- `src/ui/intelligenceFiles.js` converts bounded **GeoJSON, KML, GPX** local uploads to a GeoJSON collection; `Cesium.GeoJsonDataSource` renders the resulting overlays.
- `src/ui/intelligenceRuntime.js` transforms existing enabled layers' `getAnalystRecords()` into a bounded common record form, and manages **opt-in**, browser-local IndexedDB history. It does not import `node:sqlite` into the browser. The earlier `extensions/gev-intel-core/history.js` remains an optional Node-side, independently tested SQLite primitive.
- Core polygon/geofence, correlation, report, workspace, OT validation, and refinement modules are reused from `extensions/gev-intel-core/`.

## What an operator can do

1. Open **ANALYST**. Upload a local GeoJSON, KML, or GPX file; show/hide its draped Cesium layer, change opacity, zoom to it, export or delete it. Never pass a private network URL or credentials.
2. Enable browser-local seven-day history in `History` and explicitly **Capture visible analyst records** or opt into a bounded automatic sample every two minutes. Supported enabled layers are mapped by allowlist; use `Load 7 days` and the time slider to replay selected geolocated observations. `Play` advances the historical view; `Clear` requires confirmation. CSV export is available.
3. Add a geofence rule using an imported polygon; manually check or opt in to 30-second updates; optionally grant browser notification permission. Transitions are computed only from current layer records. No personal identification is supported.
4. Run bounded geographic/time correlation between current records and locally recorded observations. Output is explicitly noncausal.
5. Save, restore, download and import workspace snapshots. They carry a camera pose, enabled layer IDs and resolution scale, not credentials.
6. Export a secure HTML evidence report, or use the browser's Print → Save as PDF. Reports include source IDs and timestamps and note where an observation time was unknown.
7. Request a one-off **Open-Meteo** forecast for the current camera position. It is weather-model information, **not AEMET/EUMETSAT/official public warnings**.
8. Upload a **JSON summary** of authorized OT zones/conduits for offline validation and readout. Import intentionally forbids detailed addresses, asset inventories, credentials or network access.
9. Change Cesium resolutionScale (performance/balanced/high), optionally auto-adapt it using frame-time samples and inspect available enabled-layer health summaries.

## Limits / important security model

- Not a production authentication system; **OIDC, RBAC, public TLS ingress, multiuser sharing and authorized OT ingestion are NOT implemented**. Do not put the built-in local developer server on the Internet. An external audited gateway, end-to-end authorization and provider restrictions would be required before deployment.
- Historical archive is **not an automatic recorder**. Data is user-initiated and browser-local. Retention is seven days when enabled and `prune()` is invoked; it does not overwrite source licensing restrictions. The source timestamp may be a browser-received snapshot time, which is explicitly marked.
- Geofence input must not cross the antimeridian; first polygon in selected GIS layer is used as the watch zone. Alerts use only public/non-person asset source contracts and are not safety, navigation or access-control decisions.
- KML/GPX conversions cover points, lines, tracks and polygon geometries; they do not implement every vendor-specific extension, style or ground-altitude model. XML DTDs/entities are rejected. File upload cap 5 MiB, GeoJSON cap 2,000 features/100,000 vertices, 10 active imports.
- Playback time is based on the recorded source/receipt timestamps; it does not create historical provider data and is capped at 3,000 loaded observations and 400 marker primitives per selected frame.
- Current meteorology is supplied on explicit fetch from Open-Meteo; official meteorological alert feeds, regional radar and emergency-response decision support are still out of scope.
- Performance presets adapt **manually** via resolutionScale; a guaranteed automatic hardware-specific FPS governor and GPU benchmarking are still pending.
- Generated HTML reports are unsigned. Printing to PDF is provided by the user's browser, not a signed server-side PDF workflow.
- No module in this delivery connects to real OT equipment, polls Modbus/OPC, accesses SIS, or sends topology into public services. Authorize infrastructure data and architecture separately.

## Validation commands

```
npm ci
npm run format
npm run format:check
npm run check:boundaries
npm test
node --test extensions/gev-intel-core/intel-core.test.mjs
npm run build
```

Then run interactive browser checks (headful GPU) for: load/unload GIS, 7-day archive consent/revoke, history scrub/stop, alerts check, workspaces restore, harmless/hostile file imports, print/export, app destroy; verify source licenses and provider terms separately.

No `npm ci`/`npm run build` or real Chromium/Cesium integration proof can be performed by this delivery environment because the complete upstream repository/dependency tree is unavailable over the container network. **A successful isolated test is not a production signoff.**
