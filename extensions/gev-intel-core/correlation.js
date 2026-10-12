/** Proximity correlation: shared place and time never proves causation. */
const R = 6371000;
export function distanceMeters(a,b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat-a.lat)*rad, dLon = (b.lon-a.lon)*rad;
  const q = Math.sin(dLat/2)**2 + Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(q)));
}
export function correlateObservations(left, right, { radiusMeters = 1000, windowMs = 60000, maxPairs = 10000 } = {}) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length > 10000 || right.length > 10000)
    throw new RangeError('Invalid correlation batches');
  if (!(radiusMeters > 0 && radiusMeters <= 1000000 && windowMs >= 0 && windowMs <= 86400000)) throw new RangeError('Invalid limits');
  if (left.length * right.length > 5000000) throw new RangeError('Correlation workload exceeds safe cap; add a spatial index');
  const result = [];
  for (const a of left) for (const b of right) {
    if (![a?.lat,a?.lon,b?.lat,b?.lon,a?.observedAt,b?.observedAt].every(Number.isFinite)) continue;
    if (Math.abs(a.lat)>90 || Math.abs(b.lat)>90 || Math.abs(a.lon)>180 || Math.abs(b.lon)>180) continue;
    const diff = Math.abs(a.observedAt-b.observedAt);
    if (diff > windowMs) continue;
    const distance = distanceMeters(a,b);
    if (distance > radiusMeters) continue;
    result.push({ leftId: a.id, rightId: b.id, distanceMeters: Math.round(distance),
      timeDifferenceMs: diff, leftSource: a.source, rightSource: b.source,
      relation: 'spatiotemporal-coincidence', causal: false });
    if (result.length >= maxPairs) return result;
  }
  return result;
}
