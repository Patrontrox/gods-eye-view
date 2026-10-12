# GEV intelligence foundation (Patrontrox extension)

**Status:** opt-in **backend/domain primitives only**. These primitives do not automatically enable panels, make upstream API calls or collect data; the optional `src/ui/intelligenceConsole.js` integration uses a subset to provide a user-invoked Analyst Desk within the main GEV application. It ships alongside the existing app for incremental integration.

All eight test assertions run with `node --test extensions/gev-intel-core/intel-core.test.mjs` on supported Node 24.14+ / 26. No external npm dependencies. Local history uses built-in `node:sqlite` and defaults **disabled**.

| File | Implemented, callable surface | Remaining for complete product |
| --- | --- | --- |
| `geojson.js` | Bounded local GeoJSON FeatureCollection validation and summary | Cesium renderer, styling, KML/GPX, UI drag/drop, attribution and worker offload |
| `history.js` | SQLite optional append/query/prune with strict shape, deduplication and retention | Source adapters, migrations, UI timeline, encryption, backups, commercial-data retention review |
| `geofence.js` | Polygon enter/exit on fresh, named-asset observations | Rule editor, antimeridian handling, persistence, notification routing and access controls |
| `correlation.js` | Spatiotemporal proximity matches explicitly noncausal | Scalable spatial index, authority metadata, entity disambiguation and analyst case workflow |
| `workspace.js` | Safe versioned JSON serialization excluding credential-shaped fields | UI workspace manager, migration, annotation capture, sharing, quotas |
| `otTopology.js` | Aggregate IEC 62443-inspired zones/conduits, read-only checks | Private authenticated gateway, RBAC, segregated read-only ingestion and UI visualization |
| `refinementScheduler.js` | Generation-aware optional refinement during viewport motion | Wiring to Recent Imagery and camera events, GPU headful A/B validation |
| `report.js` | Escaped, script-free HTML evidence table with provenance | Case store, screenshots with attribution, signed exports, PDF conversion |

## Safety and correctness boundaries

- All observations are infrastructure/equipment/events, **never person identification or tracking**.
- `geojson.js` supports only local text; it never fetches URLs. Downstream UIs must escape all data-derived strings.
- Geofencing is purely geometric and approximate: no "safe route", disaster-all-clear, or operational assurance can be inferred. Current implementation does not support polygons crossing the antimeridian; reject or preprocess such geometry until supported.
- SQLite local history is **off by default** and must never record sources unless their terms and user consent allow storage. Configure strict retention and storage access permissions for sensitive deployments.
- `otTopology.js` accepts only abstract zone/conduit labels. Never connect it to DCS/SIS/PLC networks, and never export actual OT network topology to a public globe.
- Nothing here is a hardened Internet-facing service; require an independently designed authenticated backend before remote multiuser sharing.

## Example: opt-in local history

```js
import { openHistoryStore } from './extensions/gev-intel-core/history.js';
const store = openHistoryStore({ enabled: true, filename: './local-observations.sqlite', retentionDays: 7 });
try {
  store.append([{ kind: 'aircraft', id: 'abc123', source: 'adsb', lat: 37.5, lon: -6.2, observedAt: Date.now() }]);
  const rows = store.query({ from: Date.now() - 3600000, to: Date.now(), kind: 'aircraft' });
  console.log(rows);
  store.prune();
} finally { store.close(); }
```

In practice, keep the file outside public/static folders and ensure opt-in policy and source license checks. **Do not enable this sample on a corporate or OT network without authorization.**
