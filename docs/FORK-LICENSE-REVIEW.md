# Data and asset licensing review (preliminary)

Based on the original repository's `DATA_SOURCES.md`, `SECURITY.md`, and `LICENSE` as reviewed on 2026-10-12. This is not legal advice, and each upstream provider's latest terms must be rechecked before redistribution or commercial operation.

| Resource | Reported license / conditions | Fork action |
| --- | --- | --- |
| Original application source | MIT | Preserve notices and original copyright; attribute upstream modifications clearly. |
| TeleGeography submarine cable bundle | CC BY-NC-SA 3.0 | NonCommercial; remove `src/data/local_data/telegeography_submarine_cables/` or secure commercial permission before commercial distribution. Update import registration and validate the build. |
| Bhote Koshi event pack and derived coordinates | CC BY-NC 4.0 for relevant media and derived data | NonCommercial; exclude **both** `public/events/bhote-koshi-2026/` and linked derived datasets (including `src/data/bhoteKoshiFloodPath.js`) plus registrations/imports, or obtain appropriate rights. |
| OSM-derived datacenters, dams, military names, ALPR | ODbL 1.0 | Respect database attribution and share-alike/availability where relevant. |
| Natural Earth and US Census geographic snapshots | Public domain | Retain source provenance for analyst reproducibility. |
| Google photorealistic maps / Cesium ion imagery | Provider usage plans and key restrictions | Verify noncommercial eligibility, quotas, browser referrer / server IP API restrictions, and retention/caching rules. |
| AIS / ADS-B / weather / street-level providers | Provider-specific usage and attribution requirements | Revalidate caching, historical retention, display credits, redistribution and rate limits separately. |

The new SQLite historian **must remain opt-in** until the operator has assessed retention/reuse rights for each incoming data source. No provider data is ingested by the extension by default.

Before a paid or hosted version is deployed, perform a software composition audit (`npm audit`, license inventory, known-vulnerability scan), human license review, secrets-scanning, and validation of the released artifacts rather than only the repository source.
