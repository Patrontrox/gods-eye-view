/** Analyst Desk — opt-in local GIS, observations, replay, alerts and evidence.
 * Built on existing GEV data-layer analyst contracts, not a replacement layer manager.
 * No telemetry collection, remote upload or OT network access is enabled by default.
 */
import * as Cesium from 'cesium';
import './intelligenceConsole.css';
import { parseLocalGis } from './intelligenceFiles.js';
import { mountEnterpriseDesk } from './intelligenceEnterprise.js';
import {
  collectAnalystObservations,
  openBrowserHistory,
  correlateObservations,
  createGeofenceEngine,
  serializeWorkspace,
  parseWorkspace,
  validateOtTopology,
} from './intelligenceRuntime.js';
import { renderEvidenceReport } from '../../extensions/gev-intel-core/report.js';
import { createRefinementScheduler } from '../../extensions/gev-intel-core/refinementScheduler.js';

const STORE = 'gev.analyst-desktop.v1';
const FIELD_LIMIT = 400;
const $ = (root, selector) => root.querySelector(selector);
const number = (value, fallback) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
const label = (value, max = FIELD_LIMIT) => String(value ?? '').slice(0, max);
function download(filename, contents, mime) {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function safeJsonParse(text, max = 1048576) {
  if (new TextEncoder().encode(text).length > max)
    throw new RangeError('Data exceeds import limit');
  return JSON.parse(text);
}
function cameraPoint(viewer) {
  const cartographic = viewer.camera.positionCartographic;
  return {
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: Cesium.Math.toDegrees(cartographic.longitude),
    alt: cartographic.height,
    heading: Cesium.Math.toDegrees(viewer.camera.heading),
    pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
    roll: Cesium.Math.toDegrees(viewer.camera.roll),
  };
}
function makeControl(text, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.addEventListener('click', handler);
  return button;
}
function addSummary(container, headline, detail, actions = []) {
  const row = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = label(headline, 250);
  row.append(title);
  const p = document.createElement('p');
  p.className = 'gev-muted';
  p.textContent = label(detail, 500);
  row.append(p);
  const controls = document.createElement('div');
  controls.className = 'gev-acting';
  for (const [text, handler] of actions)
    controls.append(makeControl(text, handler));
  row.append(controls);
  container.append(row);
}
const DOM = `<header><h2>◉ ANALYST DESK</h2><button type="button" id="gev-desk-close" aria-label="Close analyst desk">✕</button></header>
<nav role="tablist" aria-label="Analyst desk sections">
<button type="button" data-tab="gis" role="tab" aria-selected="true">GIS</button><button type="button" data-tab="history" role="tab">History</button><button type="button" data-tab="alerts" role="tab">Alerts</button><button type="button" data-tab="analyze" role="tab">Analyze</button><button type="button" data-tab="workspaces" role="tab">Workspaces</button><button type="button" data-tab="reports" role="tab">Reports</button><button type="button" data-tab="weather" role="tab">Weather</button><button type="button" data-tab="ot" role="tab">Cyber/OT</button><button type="button" data-tab="enterprise" role="tab">Enterprise</button><button type="button" data-tab="settings" role="tab">Settings</button>
</nav><main>
<section data-gev-tab="gis"><h3>Local GIS overlays</h3><p>Import GeoJSON, KML or GPX. Local files only; no URL fetching. Source and attribution remain your responsibility.</p><label>GeoJSON / KML / GPX<input id="gev-gis-file" type="file" accept=".geojson,.json,.kml,.gpx"/></label><label>Opacity <input id="gev-gis-opacity" type="range" min="10" max="100" value="40"/></label><div id="gev-gis-items" class="gev-list"></div></section>
<section data-gev-tab="history" hidden><h3>Local observation archive</h3><p class="gev-warning">OFF until explicitly enabled. Stored in this browser (IndexedDB), not on a server. Check source licensing before recording.</p><label class="gev-inline"><input type="checkbox" id="gev-record-optin"/> Enable 7-day local history</label><label class="gev-inline"><input type="checkbox" id="gev-record-auto"/> Automatically capture a bounded sample every 2 minutes</label><div class="gev-acting"><button id="gev-capture">Capture visible analyst records</button><button id="gev-history-load">Load 7 days</button><button id="gev-history-clear">Delete all local history</button></div><label>Replay point within loaded history <input id="gev-history-range" type="range" min="0" max="100" value="100"/></label><div class="gev-acting"><button id="gev-history-play">Play</button><button id="gev-history-stop">Stop</button><button id="gev-history-export">Export CSV</button></div><p id="gev-history-time" class="gev-muted"></p><div id="gev-history-list" class="gev-list"></div></section>
<section data-gev-tab="alerts" hidden><h3>Geofencing & monitoring</h3><p class="gev-warning">Select an imported GIS polygon; monitoring is opt-in and checks currently loaded layer records. Alerts represent geographic crossings, not danger assessments.</p><label>Polygon layer<select id="gev-zone-source"></select></label><label>Rule name<input id="gev-zone-name" maxlength="80" value="Watch area"/></label><label>Transition<select id="gev-zone-transition"><option value="both">Enter or exit</option><option value="enter">Entry only</option><option value="exit">Exit only</option></select></label><div class="gev-acting"><button id="gev-zone-add">Create rule</button><button id="gev-zone-check">Check now</button></div><label class="gev-inline"><input type="checkbox" id="gev-zone-monitor"/> Enable monitoring (30 s)</label><label class="gev-inline"><input type="checkbox" id="gev-zone-notify"/> Browser notifications (permission required)</label><div id="gev-zone-rules" class="gev-list"></div><h3>Recent events</h3><div id="gev-zone-events" class="gev-list"></div></section>
<section data-gev-tab="analyze" hidden><h3>Spatial coincidence analysis</h3><p>Cross-match loaded current observations with your local archive. Proximity does not establish causation.</p><label>Distance threshold (m)<input id="gev-analysis-radius" type="number" min="10" max="100000" value="1000"/></label><label>Time threshold (minutes)<input id="gev-analysis-window" type="number" min="0" max="1440" value="60"/></label><button id="gev-analysis-run">Analyze current vs archive</button><div id="gev-analysis-list" class="gev-list"></div></section>
<section data-gev-tab="workspaces" hidden><h3>Saved workspaces</h3><p>Stores local camera pose, enabled layers and visual quality. No API keys or credentials.</p><label>Workspace name<input id="gev-workspace-name" maxlength="100" placeholder="My investigation"/></label><div class="gev-acting"><button id="gev-workspace-save">Save locally</button><button id="gev-workspace-import">Import JSON</button><input hidden id="gev-workspace-file" type="file" accept=".json"/></div><div id="gev-workspaces" class="gev-list"></div></section>
<section data-gev-tab="reports" hidden><h3>Evidence report</h3><p>Export provenance with up to 1,000 local observations. Use the browser Print function to save the HTML report as PDF.</p><label>Report title<input id="gev-report-title" value="Geospatial observation report" maxlength="140"/></label><label>Analyst note<textarea id="gev-report-note" maxlength="1000" rows="3" placeholder="Context and limitations"></textarea></label><div class="gev-acting"><button id="gev-report-html">Export HTML</button><button id="gev-report-print">Print / Save PDF</button></div></section>
<section data-gev-tab="weather" hidden><h3>Europe / global weather preview</h3><p>Optional, one-time Open-Meteo forecast for the camera location. Forecast values, not official warnings, radar observations or AEMET data.</p><button id="gev-weather-fetch">Fetch forecast at camera</button><div id="gev-weather-output" class="gev-list"></div></section>
<section data-gev-tab="ot" hidden><h3>Cyber/OT summary (offline)</h3><p class="gev-warning">Upload only non-sensitive, approved aggregate zone/conduit information. No direct DCS, SIS or PLC connectivity. No device addresses or credentials permitted.</p><label>Authorized aggregate JSON<input type="file" id="gev-ot-file" accept=".json"/></label><div id="gev-ot-summary" class="gev-list"></div></section>
<section data-gev-tab="enterprise" hidden><h3>Secure enterprise extensions</h3><p class="gev-warning">Only available through an opt-in HTTPS deployment with the OIDC gateway and RBAC. No credentials are stored here. The default local app stays unchanged.</p><div class="gev-acting"><button id="gev-ent-login">OIDC sign-in</button><button id="gev-ent-whoami">Who am I?</button><button id="gev-ent-logout">Sign out</button></div><h3>AEMET official warnings</h3><label>Area<select id="gev-ent-area"><option value="esp">Spain</option><option value="and">Andalusia</option><option value="mad">Madrid</option><option value="cat">Catalonia</option><option value="val">Valencia</option><option value="gal">Galicia</option><option value="can">Canary Islands</option></select></label><button id="gev-ent-aemet">Read official CAP warnings</button><h3>Private OT summary</h3><button id="gev-ent-ot">Read approved aggregate (operator role)</button><h3>Declarative connectors</h3><button id="gev-ent-connectors">List connectors</button><div id="gev-ent-list" class="gev-list"></div><output id="gev-emp-output" role="status"></output><p class="gev-muted">PDF integrity: export PDF via Reports, then use the server-side Ed25519 detached signer. Requires a trusted public key; not an embedded PAdES signature.</p></section>
<section data-gev-tab="settings" hidden><h3>Rendering quality</h3><p>Chooses Cesium render resolution. Use a lower setting on slower GPUs.</p><label>Quality preset<select id="gev-quality"><option value="0.7">Performance (70%)</option><option value="1" selected>Balanced (100%)</option><option value="1.25">High detail (125%)</option></select></label><label class="gev-inline"><input type="checkbox" id="gev-auto-quality"/> Automatically adapt render scale to frame timing</label><h3>Deployment status</h3><p>This local-first interface has no server authentication, SSO or role-based permissions. Do not expose its Vite server on the public Internet. Corporate deployment requires a separately secured backend/gateway.</p><button id="gev-desk-diagnostics">Show source health</button><div id="gev-desk-health" class="gev-list"></div></section>
</main><footer>Local-first • No personal tracking • Dataset timestamps & rights must be verified • Not for safety-critical use</footer>`;

export function createIntelligenceConsole({
  viewer,
  dataManager,
  signal,
} = {}) {
  if (!viewer?.dataSources || !dataManager?.layers)
    throw new TypeError('GEV viewer and lifecycle manager required');
  const launcher = document.createElement('button');
  launcher.id = 'gev-intel-launcher';
  launcher.type = 'button';
  launcher.textContent = '◉ ANALYST';
  const root = document.createElement('aside');
  root.id = 'gev-intel-desk';
  root.hidden = true;
  root.setAttribute('aria-label', 'Geospatial analyst desk');
  // Only constant markup; never interpolate user, feed, or GIS-sourced text into HTML.
  root.innerHTML = DOM;
  document.body.append(launcher, root);
  const state = {
    destroyed: false,
    gis: [],
    rules: [],
    alerts: [],
    archive: [],
    history: null,
    historyEnabled: false,
    loadedAt: 0,
    workspaces: [],
    replay: null,
    playing: null,
    monitoring: null,
    autoRecord: null,
    notifying: false,
    ot: null,
    weather: null,
    qualityFrame: null,
  };
  const disposers = [];
  // Gateway endpoints are same-origin, authenticated and entirely opt-in.
  try {
    disposers.push(mountEnterpriseDesk(root, { signal }));
  } catch (error) {
    console.warn('[Enterprise Desk] Cannot mount:', error);
  }
  const refinement = createRefinementScheduler();
  const markMotion = () => {
    refinement.motionStart();
    refinement.motionStop();
  };
  const removeCameraMotion =
    viewer.camera.changed?.addEventListener?.(markMotion);
  if (typeof removeCameraMotion === 'function')
    disposers.push(removeCameraMotion);
  function info(text, error = false) {
    const message = $(root, '#gev-intel-status');
    if (message) {
      message.textContent = text;
      message.dataset.error = String(error);
    } else {
      const status = document.createElement('output');
      status.id = 'gev-intel-status';
      status.setAttribute('role', 'status');
      status.textContent = text;
      status.dataset.error = String(error);
      root.querySelector('main').prepend(status);
    }
  }
  function act(id, fn, eventType = 'click') {
    const el = $(root, `#${id}`);
    if (!el) throw new Error(`Missing Desk control ${id}`);
    el.addEventListener(eventType, async (event) => {
      if (state.destroyed) return;
      try {
        await fn(event);
      } catch (error) {
        console.warn('[Analyst Desk]', id, error);
        info(error.message || 'Operation failed', true);
      }
    });
    return el;
  }
  function setTab(tab) {
    for (const button of root.querySelectorAll('nav [data-tab]'))
      button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    for (const section of root.querySelectorAll('[data-gev-tab]'))
      section.hidden = section.dataset.gevTab !== tab;
  }
  for (const button of root.querySelectorAll('nav [data-tab]'))
    button.addEventListener('click', () => setTab(button.dataset.tab));
  launcher.addEventListener('click', () => {
    root.hidden = !root.hidden;
    launcher.setAttribute('aria-expanded', String(!root.hidden));
  });
  act('gev-desk-close', () => {
    root.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
  });
  const gisList = $(root, '#gev-gis-items');
  const zoneSelect = $(root, '#gev-zone-source');
  const redrawZones = () => {
    zoneSelect.replaceChildren();
    for (const item of state.gis) {
      if (
        !item.collection.features.some(
          (feature) =>
            feature.geometry.type === 'Polygon' ||
            feature.geometry.type === 'MultiPolygon',
        )
      )
        continue;
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      zoneSelect.append(option);
    }
  };
  function drawGis() {
    gisList.replaceChildren();
    for (const item of state.gis)
      addSummary(
        gisList,
        item.name,
        `${item.summary.featureCount} features | ${item.summary.vertexCount} vertices | ${item.visible ? 'visible' : 'hidden'}`,
        [
          [
            item.visible ? 'Hide' : 'Show',
            () => {
              item.visible = !item.visible;
              item.source.show = item.visible;
              drawGis();
            },
          ],
          ['Fly to', () => viewer.flyTo(item.source)],
          [
            'Export',
            () =>
              download(
                'overlay.geojson',
                JSON.stringify(item.collection, null, 2),
                'application/geo+json',
              ),
          ],
          [
            'Remove',
            () => {
              void viewer.dataSources.remove(item.source, true);
              state.gis = state.gis.filter((record) => record !== item);
              drawGis();
              redrawZones();
            },
          ],
        ],
      );
  }
  function colorGis(item) {
    const opacity = Number($(root, '#gev-gis-opacity').value) / 100;
    for (const entity of item.source.entities.values) {
      // Never permit HTML from feature properties into Cesium's infobox.
      entity.description = undefined;
      if (entity.polygon)
        entity.polygon.material = Cesium.Color.CYAN.withAlpha(opacity);
      if (entity.polyline) {
        entity.polyline.material = Cesium.Color.CYAN.withAlpha(
          Math.max(0.5, opacity),
        );
        entity.polyline.width = 3;
      }
      if (entity.billboard) entity.billboard.show = false;
      if (entity.position && !entity.point)
        entity.point = { pixelSize: 8, color: Cesium.Color.CYAN };
    }
  }
  async function importGis(file) {
    if (!file || file.size > 5 * 1024 * 1024)
      throw new RangeError('GIS file exceeds 5 MiB');
    if (state.gis.length >= 10)
      throw new RangeError('Maximum of 10 imported layers');
    const { collection, summary } = parseLocalGis(file.name, await file.text());
    const source = await Cesium.GeoJsonDataSource.load(collection, {
      clampToGround: true,
    });
    if (state.destroyed) {
      source.destroy?.();
      return;
    }
    const item = {
      id: crypto.randomUUID(),
      name: file.name.slice(0, 140),
      collection,
      summary,
      source,
      visible: true,
    };
    colorGis(item);
    await viewer.dataSources.add(source);
    state.gis.push(item);
    drawGis();
    redrawZones();
    info(`${summary.featureCount} local GIS features added from ${file.name}`);
  }
  act(
    'gev-gis-file',
    async (event) => {
      const file = event.currentTarget.files?.[0];
      if (file) await importGis(file);
      event.currentTarget.value = '';
    },
    'change',
  );
  act(
    'gev-gis-opacity',
    () => {
      for (const item of state.gis) colorGis(item);
    },
    'input',
  );
  const historyOpt = $(root, '#gev-record-optin');
  historyOpt.addEventListener('change', async () => {
    if (historyOpt.checked) {
      try {
        state.history = openBrowserHistory();
        state.historyEnabled = true;
        await state.history.prune();
        info('Local 7-day history enabled (manual capture by default)');
      } catch (error) {
        historyOpt.checked = false;
        state.historyEnabled = false;
        state.history?.close();
        state.history = null;
        info(error.message, true);
      }
    } else {
      state.historyEnabled = false;
      state.history?.close();
      state.history = null;
      clearInterval(state.autoRecord);
      state.autoRecord = null;
      $(root, '#gev-record-auto').checked = false;
      info(
        'History disabled; previously stored records retained until deleted',
      );
    }
  });
  $(root, '#gev-record-auto').addEventListener('change', (event) => {
    clearInterval(state.autoRecord);
    state.autoRecord = null;
    if (!event.currentTarget.checked) return;
    if (!state.historyEnabled) {
      event.currentTarget.checked = false;
      info('Enable history before automatic recording', true);
      return;
    }
    // Conservative default: at most 100 samples every 120 seconds; no background-tab collection.
    state.autoRecord = setInterval(async () => {
      if (state.destroyed || !state.historyEnabled || document.hidden) return;
      try {
        const rows = collectAnalystObservations(dataManager, {
          maxPerLayer: 25,
        }).slice(0, 100);
        if (rows.length) await state.history.append(rows);
        await state.history.prune();
      } catch (error) {
        console.warn('[Analyst Desk] Automatic history capture failed:', error);
      }
    }, 120000);
    info(
      'Opt-in periodic sample recording enabled: up to 100 records / 2 minutes while visible',
    );
  });
  act('gev-capture', async () => {
    if (!state.historyEnabled) throw new Error('Enable local history first');
    const rows = collectAnalystObservations(dataManager);
    if (!rows.length)
      throw new Error('No compatible enabled-layer analyst records available');
    await state.history.append(rows);
    await state.history.prune();
    info(
      `Captured ${rows.length} records. Time refers to browser receipt when source observation time is unavailable.`,
    );
  });
  const replaySource = new Cesium.CustomDataSource('analyst-replay');
  void viewer.dataSources.add(replaySource);
  function showReplay(index) {
    const records = state.archive;
    if (!records.length) return;
    const i = Math.max(0, Math.min(records.length - 1, index));
    const cutoff = records[i].observedAt;
    replaySource.entities.removeAll();
    let count = 0;
    for (let j = i; j >= 0 && count < 400; j--) {
      const r = records[j];
      if (r.observedAt < cutoff - 60 * 60 * 1000) break;
      replaySource.entities.add({
        id: `replay-${j}`,
        position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat),
        point: {
          pixelSize: 5,
          color: Cesium.Color.YELLOW,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
        },
      });
      count++;
    }
    $(root, '#gev-history-time').textContent =
      `${new Date(cutoff).toLocaleString()} | ${count} points within previous hour (received or source timestamp)`;
    state.replay = i;
  }
  async function loadHistory() {
    if (!state.historyEnabled) throw new Error('Enable history first');
    state.archive = await state.history.query({ limit: 3000 });
    state.archive.sort((a, b) => a.observedAt - b.observedAt);
    const items = $(root, '#gev-history-list');
    items.replaceChildren();
    const grouped = Object.groupBy
      ? Object.groupBy(state.archive, (x) => x.kind)
      : state.archive.reduce((a, v) => ((a[v.kind] ||= []).push(v), a), {});
    for (const [kind, rows] of Object.entries(grouped))
      addSummary(items, kind, `${rows.length} local observations`);
    $(root, '#gev-history-range').max = String(
      Math.max(0, state.archive.length - 1),
    );
    $(root, '#gev-history-range').value = String(
      Math.max(0, state.archive.length - 1),
    );
    if (state.archive.length) showReplay(state.archive.length - 1);
    info(`Loaded ${state.archive.length} local observation records`);
  }
  act('gev-history-load', loadHistory);
  act(
    'gev-history-range',
    (event) => showReplay(Number(event.currentTarget.value)),
    'input',
  );
  act('gev-history-play', () => {
    if (!state.archive.length) throw new Error('Load archive first');
    clearInterval(state.playing);
    state.playing = setInterval(() => {
      if (state.destroyed || document.hidden) return;
      const next = Math.min((state.replay ?? 0) + 1, state.archive.length - 1);
      showReplay(next);
      $(root, '#gev-history-range').value = String(next);
      if (next === state.archive.length - 1) {
        clearInterval(state.playing);
        state.playing = null;
      }
    }, 500);
  });
  act('gev-history-stop', () => {
    clearInterval(state.playing);
    state.playing = null;
  });
  act('gev-history-clear', async () => {
    if (!state.historyEnabled) throw new Error('Enable history to delete it');
    if (
      !window.confirm(
        'Permanently delete all local analyst observations in this browser?',
      )
    )
      return;
    await state.history.clear();
    state.archive = [];
    replaySource.entities.removeAll();
    $(root, '#gev-history-list').replaceChildren();
    info('History deleted');
  });
  act('gev-history-export', () => {
    const rows = state.archive;
    if (!rows.length) throw new Error('Load history first');
    const value = [
      'kind,id,source,lat,lon,observedAt,receivedAt,observationTimeKnown',
      ...rows.map((r) =>
        [
          r.kind,
          r.id,
          r.source,
          r.lat,
          r.lon,
          r.observedAt,
          r.receivedAt,
          r.observationTimeKnown,
        ]
          .map((v) => `"${String(v).replaceAll('"', '""')}"`)
          .join(','),
      ),
    ].join('\n');
    download('gev-observations.csv', value, 'text/csv;charset=utf-8');
  });
  const RULES_STORE = `${STORE}.geofences`;
  try {
    const saved = safeJsonParse(
      localStorage.getItem(RULES_STORE) || '[]',
      250000,
    );
    if (Array.isArray(saved)) {
      for (const rule of saved.slice(0, 50)) {
        createGeofenceEngine({
          rules: [
            {
              id: rule.id,
              geometry: rule.geometry,
              transition: rule.transition,
            },
          ],
        });
        state.rules.push({
          id: rule.id,
          geometry: rule.geometry,
          transition: rule.transition,
          name: label(rule.name, 80),
        });
      }
    }
  } catch {
    state.rules = [];
  }
  const saveRules = () => {
    const json = JSON.stringify(state.rules);
    if (new TextEncoder().encode(json).byteLength > 250000)
      throw new RangeError('Rule geometry exceeds 250 KiB persistent quota');
    localStorage.setItem(RULES_STORE, json);
  };
  let engine = null;
  function redrawRules() {
    const list = $(root, '#gev-zone-rules');
    list.replaceChildren();
    for (const r of state.rules)
      addSummary(list, r.name, `${r.transition} | ${r.id}`, [
        [
          'Remove',
          () => {
            state.rules = state.rules.filter((rule) => rule !== r);
            saveRules();
            engine = null;
            redrawRules();
          },
        ],
      ]);
  }
  act('gev-zone-add', () => {
    const selected = state.gis.find((x) => x.id === zoneSelect.value);
    const feature = selected?.collection.features.find((x) =>
      ['Polygon', 'MultiPolygon'].includes(x.geometry.type),
    );
    if (!feature) throw new Error('Import and select a polygon layer first');
    if (state.rules.length >= 50)
      throw new RangeError('Too many monitoring rules');
    const name = $(root, '#gev-zone-name').value.trim().slice(0, 80);
    if (!name) throw new TypeError('Rule name required');
    const rule = {
      id: crypto.randomUUID(),
      name,
      geometry: feature.geometry,
      transition: $(root, '#gev-zone-transition').value,
    };
    createGeofenceEngine({
      rules: [
        { id: rule.id, geometry: rule.geometry, transition: rule.transition },
      ],
    }); // Validate before adding.
    state.rules.push(rule);
    try {
      saveRules();
    } catch (error) {
      state.rules.pop();
      throw error;
    }
    engine = null;
    redrawRules();
    info(`Geofence ${name} added for locally loaded geometry`);
  });
  redrawRules();
  const alertsList = $(root, '#gev-zone-events');
  function checkAlerts() {
    if (!state.rules.length) throw new Error('Create a geofence rule first');
    engine ||= createGeofenceEngine({
      rules: state.rules.map(({ id, geometry, transition }) => ({
        id,
        geometry,
        transition,
      })),
    });
    const results = engine.observe(collectAnalystObservations(dataManager));
    for (const event of results) {
      state.alerts.unshift(event);
      state.alerts.length = Math.min(100, state.alerts.length);
      if (state.notifying && Notification.permission === 'granted')
        new Notification(`GEV geofence ${event.transition}`, {
          body: `${event.kind} ${event.objectId}: ${event.ruleId}`,
        });
    }
    alertsList.replaceChildren();
    for (const alert of state.alerts.slice(0, 30))
      addSummary(
        alertsList,
        `${alert.transition.toUpperCase()} — ${alert.kind}`,
        `${alert.objectId} • ${new Date(alert.observedAt).toLocaleString()} • ${alert.ruleId}`,
      );
    info(
      `${results.length} new transitions from currently loaded analyst records. No movement? No new alert.`,
    );
  }
  act('gev-zone-check', checkAlerts);
  $(root, '#gev-zone-monitor').addEventListener('change', (event) => {
    clearInterval(state.monitoring);
    state.monitoring = null;
    if (event.currentTarget.checked) {
      if (!state.rules.length) {
        event.currentTarget.checked = false;
        info('Add a geofence rule first', true);
        return;
      }
      state.monitoring = setInterval(() => {
        if (!document.hidden)
          try {
            checkAlerts();
          } catch (error) {
            console.warn('[GEV] geofence check', error);
          }
      }, 30000);
      info('Geofence monitoring enabled locally');
    }
  });
  $(root, '#gev-zone-notify').addEventListener('change', async (event) => {
    if (event.currentTarget.checked && typeof Notification !== 'undefined') {
      const permission = await Notification.requestPermission();
      state.notifying = permission === 'granted';
      event.currentTarget.checked = state.notifying;
    } else {
      state.notifying = false;
      event.currentTarget.checked = false;
    }
  });
  act('gev-analysis-run', async () => {
    if (!state.historyEnabled)
      throw new Error('Enable history to compare with archived records');
    const current = collectAnalystObservations(dataManager).slice(0, 100);
    const previous = (await state.history.query({ limit: 1000 })).slice(-100);
    const radiusMeters = Number($(root, '#gev-analysis-radius').value);
    const windowMs = Number($(root, '#gev-analysis-window').value) * 60000;
    const found = correlateObservations(current, previous, {
      radiusMeters,
      windowMs,
      maxPairs: 100,
    });
    const list = $(root, '#gev-analysis-list');
    list.replaceChildren();
    for (const pair of found)
      addSummary(
        list,
        `${pair.leftId} ↔ ${pair.rightId}`,
        `${pair.distanceMeters} m / ${Math.round(pair.timeDifferenceMs / 1000)} s | sources: ${pair.leftSource}, ${pair.rightSource} | non-causal`,
      );
    info(
      `${found.length} spatiotemporal coincidences. Sources and timing must be verified.`,
    );
  });
  const WORKSPACES = `${STORE}.workspaces`;
  try {
    state.workspaces = safeJsonParse(
      localStorage.getItem(WORKSPACES) || '[]',
      500000,
    );
    if (!Array.isArray(state.workspaces)) state.workspaces = [];
  } catch {
    state.workspaces = [];
  }
  const persistWorkspaces = () => {
    localStorage.setItem(
      WORKSPACES,
      JSON.stringify(state.workspaces.slice(0, 10)),
    );
  };
  function drawWorkspaces() {
    const list = $(root, '#gev-workspaces');
    list.replaceChildren();
    for (const ws of state.workspaces)
      addSummary(list, ws.title, 'Local workspace snapshot', [
        [
          'Restore',
          async () => {
            const record = parseWorkspace(ws.content);
            if (record.camera)
              viewer.camera.setView({
                destination: Cesium.Cartesian3.fromDegrees(
                  record.camera.lon,
                  record.camera.lat,
                  record.camera.alt ?? 200000,
                ),
                orientation: {
                  heading: Cesium.Math.toRadians(record.camera.heading ?? 0),
                  pitch: Cesium.Math.toRadians(record.camera.pitch ?? -90),
                  roll: Cesium.Math.toRadians(record.camera.roll ?? 0),
                },
              });
            for (const layer of dataManager.getAll())
              if (
                record.layers?.includes(layer.id) !==
                dataManager.isEnabled(layer.id)
              )
                await dataManager.setEnabled(
                  layer.id,
                  record.layers.includes(layer.id),
                  { origin: 'user' },
                );
            if (Number.isFinite(record.visual?.resolutionScale))
              viewer.resolutionScale = record.visual.resolutionScale;
            info(`Restored ${ws.title}`);
          },
        ],
        [
          'Download',
          () => download('gev-workspace.json', ws.content, 'application/json'),
        ],
        [
          'Delete',
          () => {
            state.workspaces = state.workspaces.filter((x) => x !== ws);
            persistWorkspaces();
            drawWorkspaces();
          },
        ],
      ]);
  }
  drawWorkspaces();
  act('gev-workspace-save', () => {
    const title = $(root, '#gev-workspace-name').value.trim();
    const content = serializeWorkspace({
      title,
      camera: cameraPoint(viewer),
      layers: dataManager
        .getAll()
        .filter((x) => dataManager.isEnabled(x.id))
        .map((x) => x.id),
      visual: { resolutionScale: viewer.resolutionScale },
    });
    if (state.workspaces.length >= 10)
      throw new RangeError('Maximum of 10 workspaces');
    state.workspaces.push({ title, content });
    persistWorkspaces();
    drawWorkspaces();
    info(`Saved workspace ${title}`);
  });
  act('gev-workspace-import', () => $(root, '#gev-workspace-file').click());
  act(
    'gev-workspace-file',
    async (event) => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      if (file.size > 500000 || state.workspaces.length >= 10)
        throw new RangeError('Workspace size/count exceeded');
      const content = await file.text();
      const record = parseWorkspace(content);
      state.workspaces.push({ title: record.title, content });
      persistWorkspaces();
      drawWorkspaces();
      event.currentTarget.value = '';
    },
    'change',
  );
  async function report() {
    let rows = state.archive;
    if (!rows.length && state.historyEnabled)
      rows = await state.history.query({ limit: 1000 });
    const note = $(root, '#gev-report-note').value.slice(0, 1000);
    return renderEvidenceReport({
      title: $(root, '#gev-report-title').value,
      observations: rows.slice(-1000).map((r) => ({
        kind: r.kind,
        id: r.id,
        source: r.source,
        observedAt: r.observedAt,
        note:
          (r.observationTimeKnown
            ? 'source timestamp; '
            : 'browser receipt timestamp; ') + note,
      })),
    });
  }
  act('gev-report-html', async () => {
    download(
      'gev-evidence-report.html',
      await report(),
      'text/html;charset=utf-8',
    );
    info('Downloaded offline evidence HTML report');
  });
  act('gev-report-print', async () => {
    const html = await report();
    const blobUrl = URL.createObjectURL(
      new Blob([html], { type: 'text/html' }),
    );
    const tab = window.open(blobUrl, '_blank', 'noopener,noreferrer');
    if (!tab)
      throw new Error('Allow popups, or export HTML and print it to PDF');
    info('Open the generated report and use Print → Save as PDF');
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  });
  act('gev-weather-fetch', async () => {
    const { lat, lon } = cameraPoint(viewer);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const query = new URL('https://api.open-meteo.com/v1/forecast');
      query.searchParams.set('latitude', lat.toFixed(4));
      query.searchParams.set('longitude', lon.toFixed(4));
      query.searchParams.set(
        'current',
        'temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,weather_code',
      );
      query.searchParams.set('timezone', 'UTC');
      const response = await fetch(query, {
        signal: controller.signal,
        credentials: 'omit',
      });
      if (!response.ok) throw new Error(`Weather service ${response.status}`);
      const data = await response.json();
      if (state.destroyed) return;
      const current = data.current;
      if (!current) throw new Error('Forecast unavailable');
      const list = $(root, '#gev-weather-output');
      list.replaceChildren();
      for (const [key, value] of Object.entries(current))
        addSummary(list, key, String(value));
      info(
        `Open-Meteo forecast at ${lat.toFixed(3)}, ${lon.toFixed(3)} • ${current.time} UTC (model information, not an official warning)`,
      );
    } finally {
      clearTimeout(timeout);
    }
  });
  act(
    'gev-ot-file',
    async (event) => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      if (file.size > 250000)
        throw new RangeError('OT aggregate file too large');
      const input = safeJsonParse(await file.text(), 250000);
      state.ot = validateOtTopology(input);
      const list = $(root, '#gev-ot-summary');
      list.replaceChildren();
      for (const zone of state.ot.zones)
        addSummary(list, `Zone: ${zone.label || zone.id}`, zone.classification);
      for (const conduit of state.ot.conduits)
        addSummary(
          list,
          `${conduit.from} → ${conduit.to}`,
          `Conduit status: ${conduit.status}`,
        );
      info(
        `Validated ${state.ot.zones.length} abstract zones and ${state.ot.conduits.length} conduits offline. No OT equipment contacted.`,
      );
      event.currentTarget.value = '';
    },
    'change',
  );
  const quality = $(root, '#gev-quality');
  quality.addEventListener('change', () => {
    viewer.resolutionScale = Number(quality.value);
    info(`Rendering scale: ${Math.round(viewer.resolutionScale * 100)}%`);
  });
  const autoQuality = $(root, '#gev-auto-quality');
  let lastFrameAt = 0,
    sampleFrameTime = 0,
    sampleCount = 0;
  function adaptiveFrame(stamp) {
    if (state.destroyed || !autoQuality.checked) return;
    if (lastFrameAt && !document.hidden) {
      const delta = stamp - lastFrameAt;
      if (delta > 0 && delta < 250) {
        sampleFrameTime += delta;
        sampleCount++;
      }
    }
    lastFrameAt = stamp;
    if (sampleCount >= 90) {
      const avg = sampleFrameTime / sampleCount;
      // Hysteresis and small step sizes: avoid oscillating after a transient.
      const next =
        avg > 29
          ? Math.max(0.6, viewer.resolutionScale - 0.1)
          : avg < 18
            ? Math.min(1.25, viewer.resolutionScale + 0.05)
            : viewer.resolutionScale;
      viewer.resolutionScale = Math.round(next * 100) / 100;
      sampleCount = 0;
      sampleFrameTime = 0;
    }
    state.qualityFrame = requestAnimationFrame(adaptiveFrame);
  }
  autoQuality.addEventListener('change', () => {
    if (state.qualityFrame !== null) cancelAnimationFrame(state.qualityFrame);
    state.qualityFrame = null;
    lastFrameAt = 0;
    sampleFrameTime = 0;
    sampleCount = 0;
    quality.disabled = autoQuality.checked;
    if (autoQuality.checked)
      state.qualityFrame = requestAnimationFrame(adaptiveFrame);
  });
  act('gev-desk-diagnostics', () => {
    const list = $(root, '#gev-desk-health');
    list.replaceChildren();
    for (const [name, entry] of dataManager.layers) {
      if (!entry.enabled) continue;
      let stats;
      try {
        stats = entry.module?.getStats?.();
      } catch {
        stats = {};
      }
      addSummary(
        list,
        name,
        `enabled | records: ${stats?.count ?? 'unknown'} | latest: ${stats?.lastUpdate || 'unknown'}`,
      );
    }
  });
  signal?.addEventListener?.('abort', destroy, { once: true });
  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    clearInterval(state.playing);
    clearInterval(state.monitoring);
    clearInterval(state.autoRecord);
    if (state.qualityFrame !== null) cancelAnimationFrame(state.qualityFrame);
    state.history?.close();
    refinement.dispose();
    for (const dispose of disposers)
      try {
        dispose();
      } catch {
        /* teardown */
      }
    for (const item of state.gis)
      void viewer.dataSources.remove(item.source, true);
    void viewer.dataSources.remove(replaySource, true);
    launcher.remove();
    root.remove();
  }
  return Object.freeze({
    destroy,
    open: () => {
      root.hidden = false;
      launcher.setAttribute('aria-expanded', 'true');
    },
    getState: () => ({
      gis: state.gis.length,
      rules: state.rules.length,
      alerts: state.alerts.length,
      archive: state.archive.length,
      historyEnabled: state.historyEnabled,
    }),
  });
}
