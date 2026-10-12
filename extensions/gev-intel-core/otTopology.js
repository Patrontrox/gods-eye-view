/** Offline, read-only zone/conduit visual model. Never connects to OT devices. */
export function validateOtTopology(topology) {
  if (!topology || !Array.isArray(topology.zones) || !Array.isArray(topology.conduits) ||
      topology.zones.length > 500 || topology.conduits.length > 2000)
    throw new TypeError('Invalid zone/conduit model');
  const zoneIds = new Set();
  for (const z of topology.zones) {
    if (typeof z.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(z.id) || zoneIds.has(z.id)) throw new TypeError('Invalid or duplicate zone ID');
    zoneIds.add(z.id);
    if (!['enterprise','dmz','operations','control','safety','other'].includes(z.classification)) throw new TypeError('Invalid zone classification');
  }
  const pairs = new Set();
  for (const c of topology.conduits) {
    if (!zoneIds.has(c.from) || !zoneIds.has(c.to) || c.from === c.to) throw new TypeError('Invalid conduit endpoints');
    const key = `${c.from}->${c.to}`;
    if (pairs.has(key)) throw new TypeError('Duplicate conduit');
    pairs.add(key);
    if (!['allowed','degraded','unavailable','unknown'].includes(c.status)) throw new TypeError('Invalid conduit state');
  }
  // Only aggregated identity/status fields are accepted: prevent accidental export of addresses, credentials or detailed ICS inventory.
  if (topology.zones.some(z=>Object.keys(z).some(k=>!['id','classification','label'].includes(k))) ||
      topology.conduits.some(c=>Object.keys(c).some(k=>!['from','to','status','observedAt'].includes(k))))
    throw new TypeError('Detailed OT asset metadata cannot be exported');
  return structuredClone({ zones: topology.zones, conduits: topology.conduits });
}
