/** Browser-local, opt-in analyst storage and adapter. No OSINT history is collected by default. */
import { correlateObservations } from '../../extensions/gev-intel-core/correlation.js';
import { createGeofenceEngine } from '../../extensions/gev-intel-core/geofence.js';
import {
  serializeWorkspace,
  parseWorkspace,
} from '../../extensions/gev-intel-core/workspace.js';
import { validateOtTopology } from '../../extensions/gev-intel-core/otTopology.js';

const STORE = 'gev-intelligence-user-observations-v1';
const ALLOWED_KINDS = new Set([
  'aircraft',
  'vessel',
  'facility',
  'weather-event',
]);
const SOURCES = Object.freeze({
  flights: 'aircraft',
  'military-flights': 'aircraft',
  military: 'aircraft',
  vessels: 'vessel',
  'ais-live-vessels': 'vessel',
  earthquakes: 'weather-event',
  'local-firms': 'weather-event',
  datacenters: 'facility',
  dams: 'facility',
});

export function normalizeAnalystRecord(row, kind, source, receivedAt) {
  if (!ALLOWED_KINDS.has(kind) || !row || typeof row !== 'object') return null;
  const lat = Number(row.lat ?? row.latitude);
  const lon = Number(row.lon ?? row.longitude);
  if (
    ![lat, lon].every(Number.isFinite) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  // Never infer a true observed time from the time at which the browser sampled it.
  const known = row.observedAt ?? row.time ?? row.timestamp;
  let measured =
    typeof known === 'string' && known.trim()
      ? Number.isFinite(Number(known))
        ? Number(known)
        : Date.parse(known)
      : Number(known);
  if (Number.isFinite(measured) && measured >= 1e9 && measured < 1e11)
    measured *= 1000; // UTC seconds epoch.
  const observedAt =
    Number.isFinite(measured) && measured >= 0 && measured <= receivedAt + 5000
      ? measured
      : receivedAt;
  const identity = row.icao24 ?? row.mmsi ?? row.usgsId ?? row.id ?? row.name;
  if (identity == null) return null;
  const id = String(identity)
    .replace(/[^a-zA-Z0-9:_-]/g, '_')
    .slice(0, 100);
  if (!id) return null;
  return {
    kind,
    id,
    lat,
    lon,
    source,
    observedAt,
    receivedAt,
    observationTimeKnown: observedAt !== receivedAt,
  };
}
export function collectAnalystObservations(
  dataManager,
  { maxPerLayer = 300 } = {},
) {
  const receivedAt = Date.now();
  const records = [];
  for (const [layerId, layer] of dataManager.layers) {
    if (
      !layer.enabled ||
      !SOURCES[layerId] ||
      typeof layer.module?.getAnalystRecords !== 'function'
    )
      continue;
    let items;
    try {
      items = layer.module.getAnalystRecords(maxPerLayer);
    } catch {
      continue;
    }
    if (!Array.isArray(items)) continue;
    for (const item of items.slice(0, maxPerLayer)) {
      const record = normalizeAnalystRecord(
        item,
        SOURCES[layerId],
        layerId,
        receivedAt,
      );
      if (record) records.push(record);
    }
  }
  return records.slice(0, 2000);
}
const requestPromise = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
export function openBrowserHistory({
  indexedDBImpl = globalThis.indexedDB,
  retentionDays = 7,
} = {}) {
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 90
  )
    throw new RangeError('Retention must be 1-90 days');
  if (!indexedDBImpl)
    throw new Error('IndexedDB is unavailable; history remains disabled');
  const ready = new Promise((resolve, reject) => {
    const open = indexedDBImpl.open(STORE, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('observations')) {
        const store = db.createObjectStore('observations', { keyPath: 'key' });
        store.createIndex('time', 'observedAt');
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  let closed = false;
  const db = async () => {
    if (closed) throw new Error('History is closed');
    return ready;
  };
  return {
    async append(records) {
      if (!Array.isArray(records) || records.length > 2000)
        throw new RangeError('History batch too large');
      const connection = await db();
      await new Promise((resolve, reject) => {
        const transaction = connection.transaction('observations', 'readwrite');
        const store = transaction.objectStore('observations');
        for (const r of records) {
          if (
            !ALLOWED_KINDS.has(r.kind) ||
            !Number.isFinite(r.lat) ||
            !Number.isFinite(r.lon) ||
            !Number.isFinite(r.observedAt)
          ) {
            transaction.abort();
            return;
          }
          store.put({
            ...r,
            key: `${r.kind}:${r.source}:${r.id}:${r.observedAt}`,
          });
        }
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () =>
          reject(transaction.error || new Error('History write aborted'));
      });
      return records.length;
    },
    async query({
      from = Date.now() - retentionDays * 86400000,
      to = Date.now(),
      kind,
      limit = 3000,
    } = {}) {
      if (
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        from > to ||
        limit < 1 ||
        limit > 5000
      )
        throw new TypeError('Invalid history query');
      const connection = await db();
      return new Promise((resolve, reject) => {
        const results = [];
        const request = connection
          .transaction('observations')
          .objectStore('observations')
          .index('time')
          .openCursor(IDBKeyRange.bound(from, to));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || results.length >= limit) {
            resolve(results);
            return;
          }
          if (!kind || cursor.value.kind === kind) results.push(cursor.value);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    },
    async prune() {
      const connection = await db();
      const cutoff = Date.now() - retentionDays * 86400000;
      return new Promise((resolve, reject) => {
        let removed = 0;
        const request = connection
          .transaction('observations', 'readwrite')
          .objectStore('observations')
          .index('time')
          .openCursor(IDBKeyRange.upperBound(cutoff, true));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(removed);
            return;
          }
          cursor.delete();
          removed++;
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    },
    async clear() {
      const connection = await db();
      return new Promise((resolve, reject) => {
        const request = connection
          .transaction('observations', 'readwrite')
          .objectStore('observations')
          .clear();
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
      });
    },
    close() {
      closed = true;
      void ready.then((connection) => connection.close()).catch(() => {});
    },
  };
}
export {
  correlateObservations,
  createGeofenceEngine,
  serializeWorkspace,
  parseWorkspace,
  validateOtTopology,
};
