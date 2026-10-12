/** A geofence rules engine for non-person asset/events, with no network access.
 * Emits an observed transition only for fresh, uniquely identified records.
 */
const within = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (!Array.isArray(a) || !Array.isArray(b)) throw new TypeError('Invalid ring vertex');
    const intersection = ((a[1] > lat) !== (b[1] > lat)) &&
      (lon < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]);
    if (intersection) inside = !inside;
  }
  return inside;
}
export function containsPoint(geometry, lon, lat) {
  if (!within(lon, -180, 180) || !within(lat, -90, 90)) return false;
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) throw new TypeError('Polygon or MultiPolygon required');
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(poly => Array.isArray(poly) && poly.length > 0 &&
    pointInRing(lon, lat, poly[0]) && !poly.slice(1).some(hole => pointInRing(lon, lat, hole)));
}
export function createGeofenceEngine({ rules, maxStalenessMs = 120000, minAlertIntervalMs = 60000 } = {}) {
  if (!Array.isArray(rules) || rules.length > 100) throw new RangeError('1-100 geofence rules expected');
  if (!(maxStalenessMs > 0 && minAlertIntervalMs >= 0)) throw new RangeError('Invalid timing');
  const seen = new Map();
  const lastAlert = new Map();
  const ruleIds = new Set();
  for (const rule of rules) {
    if (!rule.id || !rule.geometry || !['enter', 'exit', 'both'].includes(rule.transition))
      throw new TypeError('Rule needs id, geometry, and transition');
    if (ruleIds.has(rule.id)) throw new TypeError('Duplicate geofence rule ID');
    ruleIds.add(rule.id);
    const polys = rule.geometry.type === 'Polygon' ? [rule.geometry.coordinates] :
      rule.geometry.type === 'MultiPolygon' ? rule.geometry.coordinates : null;
    if (!Array.isArray(polys)) throw new TypeError('Rule requires Polygon/MultiPolygon');
    for (const poly of polys) for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 4 || ring.length > 5000) throw new TypeError('Invalid geofence ring');
      for (let i = 0; i < ring.length; i++) {
        const [lon,lat] = ring[i] ?? [];
        if (!within(lon,-180,180) || !within(lat,-90,90)) throw new TypeError('Invalid geofence vertex');
        if (i && Math.abs(lon-ring[i-1][0]) > 180) throw new RangeError('Antimeridian geofences not yet supported');
      }
      if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) throw new TypeError('Geofence ring must be closed');
    }
  }
  return {
    observe(records, now = Date.now()) {
      if (!Array.isArray(records) || records.length > 20000) throw new RangeError('Observation batch too large');
      const alerts = [];
      for (const record of records) {
        if (!record?.id || !['aircraft', 'vessel', 'facility', 'weather-event'].includes(record.kind)) continue;
        if (!within(record.lon, -180, 180) || !within(record.lat, -90, 90)) continue;
        if (!Number.isFinite(record.observedAt) || record.observedAt > now + 5000 || now - record.observedAt > maxStalenessMs) continue;
        for (const rule of rules) {
          if (rule.kinds && !rule.kinds.includes(record.kind)) continue;
          const key = `${rule.id}:${record.kind}:${record.id}`;
          const current = containsPoint(rule.geometry, record.lon, record.lat);
          const old = seen.get(key);
          if (old && record.observedAt <= old.observedAt) continue;
          seen.set(key, { inside: current, observedAt: record.observedAt });
          if (seen.size > 100000) {
            const oldest = seen.keys().next().value;
            seen.delete(oldest); lastAlert.delete(oldest);
          }
          if (!old || current === old.inside) continue;
          const transition = current ? 'enter' : 'exit';
          if (rule.transition !== 'both' && transition !== rule.transition) continue;
          if (now - (lastAlert.get(key) ?? -Infinity) < minAlertIntervalMs) continue;
          lastAlert.set(key, now);
          alerts.push(Object.freeze({ ruleId: rule.id, kind: record.kind, objectId: String(record.id),
            transition, observedAt: record.observedAt, source: record.source ?? 'unknown',
            assessment: 'geometric observation; not verified intent or hazard' }));
        }
      }
      // Bounded retention of transient state: long-running browser sessions must not grow indefinitely.
      for (const [key, value] of seen) if (now - value.observedAt > maxStalenessMs * 5) { seen.delete(key); lastAlert.delete(key); }
      return alerts;
    },
    reset() { seen.clear(); lastAlert.clear(); },
    diagnostics() { return { trackedRelationships: seen.size, ruleCount: rules.length }; },
  };
}
