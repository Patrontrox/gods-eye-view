/** Validate local geospatial vectors without performing I/O or executing properties.
 *  Safe import preparation, NOT a Cesium layer renderer. Coordinates are WGS84 [lon,lat].
 */
const TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FEATURES = 2000;
const MAX_COORDINATES = 100000;
const MAX_DEPTH = 12;
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function parseGeoJson(input, { maxBytes = MAX_BYTES, maxFeatures = MAX_FEATURES } = {}) {
  if (typeof input !== 'string') throw new TypeError('GeoJSON must be text');
  if (new TextEncoder().encode(input).byteLength > Math.min(MAX_BYTES, maxBytes)) throw new RangeError('GeoJSON byte limit exceeded');
  const value = JSON.parse(input);
  if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features))
    throw new TypeError('Only GeoJSON FeatureCollection documents are supported');
  if (value.features.length > Math.min(MAX_FEATURES, maxFeatures)) throw new RangeError('GeoJSON feature limit exceeded');
  let coordinates = 0;
  const types = new Set();
  const visit = (node, depth, callback) => {
    if (depth > MAX_DEPTH) throw new RangeError('GeoJSON nesting limit exceeded');
    if (!Array.isArray(node) || node.length === 0) throw new TypeError('Invalid coordinate array');
    if (typeof node[0] === 'number') {
      if (node.length < 2 || node.length > 3 || node.some(n => !Number.isFinite(n))) throw new TypeError('Invalid coordinate');
      const [lon, lat] = node;
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new RangeError('Coordinate outside WGS84 bounds');
      if (++coordinates > MAX_COORDINATES) throw new RangeError('GeoJSON vertex limit exceeded');
      callback(lon, lat);
      return;
    }
    for (const part of node) visit(part, depth + 1, callback);
  };
  const bounds = [180, 90, -180, -90];
  const update = (lon, lat) => {
    bounds[0] = Math.min(bounds[0], lon); bounds[1] = Math.min(bounds[1], lat);
    bounds[2] = Math.max(bounds[2], lon); bounds[3] = Math.max(bounds[3], lat);
  };
  for (const feature of value.features) {
    if (!feature || feature.type !== 'Feature' || !feature.geometry || !TYPES.has(feature.geometry.type))
      throw new TypeError('Unsupported GeoJSON feature geometry');
    const g = feature.geometry;
    types.add(g.type);
    for (const k of Object.keys(feature.properties ?? {})) {
      if (BLOCKED_KEYS.has(k)) throw new TypeError('Unsafe GeoJSON property name');
    }
    if (g.type === 'Point') {
      visit(g.coordinates, 0, update);
    } else {
      visit(g.coordinates, 0, update);
    }
  }
  // Parsing only: do not fetch external links, inject HTML, or treat properties as executable.
  return { collection: value, summary: Object.freeze({ featureCount: value.features.length, vertexCount: coordinates,
    types: [...types].sort(), bounds: coordinates ? bounds : null }) };
}
