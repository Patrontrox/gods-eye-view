/** Parse bounded local GIS files into safe WGS84 GeoJSON. No URLs or code are executed. */
import { parseGeoJson } from '../../extensions/gev-intel-core/geojson.js';

const LIMIT = 5 * 1024 * 1024;
function safeDocument(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > LIMIT)
    throw new RangeError('File exceeds the 5 MiB input limit');
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text))
    throw new TypeError('XML entity declarations are not accepted');
  if (typeof DOMParser === 'undefined')
    throw new Error('XML conversion requires a browser');
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror'))
    throw new TypeError('Malformed XML document');
  return xml;
}
function descendants(element, name) {
  return Array.from(element.getElementsByTagName('*')).filter(
    (node) => node.localName === name,
  );
}
function first(element, name) {
  return descendants(element, name)[0] || null;
}
function coordinates(value) {
  const result = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((item) => {
      const fields = item.split(',');
      if (
        fields.length < 2 ||
        fields.length > 3 ||
        fields.some((s) => s.trim() === '')
      )
        throw new TypeError('Invalid GIS coordinates');
      const numeric = fields.map(Number);
      if (!numeric.every(Number.isFinite))
        throw new TypeError('Invalid GIS coordinates');
      return numeric;
    });
  if (!result.length || result.length > 100000)
    throw new RangeError('Invalid GIS geometry size');
  return result;
}
function parseKml(text) {
  const doc = safeDocument(text);
  const placemarks = descendants(doc, 'Placemark');
  if (placemarks.length > 2000) throw new RangeError('Too many KML placemarks');
  const features = [];
  for (const [index, item] of placemarks.entries()) {
    const label =
      first(item, 'name')?.textContent?.slice(0, 200) ||
      `Placemark ${index + 1}`;
    const geometries = [];
    for (const point of descendants(item, 'Point')) {
      const positions = coordinates(first(point, 'coordinates')?.textContent);
      if (positions.length !== 1)
        throw new TypeError('KML point needs one coordinate');
      geometries.push({ type: 'Point', coordinates: positions[0] });
    }
    for (const line of descendants(item, 'LineString'))
      geometries.push({
        type: 'LineString',
        coordinates: coordinates(first(line, 'coordinates')?.textContent),
      });
    for (const poly of descendants(item, 'Polygon')) {
      const outer = first(poly, 'outerBoundaryIs');
      if (!outer) throw new TypeError('KML polygon missing outer boundary');
      const rings = [coordinates(first(outer, 'coordinates')?.textContent)];
      for (const hole of descendants(poly, 'innerBoundaryIs'))
        rings.push(coordinates(first(hole, 'coordinates')?.textContent));
      geometries.push({ type: 'Polygon', coordinates: rings });
    }
    for (const [sub, geometry] of geometries.entries())
      features.push({
        type: 'Feature',
        id: `kml-${index}-${sub}`,
        properties: { name: label },
        geometry,
      });
  }
  return { type: 'FeatureCollection', features };
}
function parseGpx(text) {
  const doc = safeDocument(text);
  const features = [];
  const attr = (node, key) => {
    const value = node.getAttribute(key);
    if (value === null || value.trim() === '')
      throw new TypeError('Missing GPX coordinate');
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError('Invalid GPX coordinate');
    return number;
  };
  const position = (node) => [attr(node, 'lon'), attr(node, 'lat')];
  for (const [i, waypoint] of descendants(doc, 'wpt').entries())
    features.push({
      type: 'Feature',
      id: `wpt-${i}`,
      properties: {
        name:
          first(waypoint, 'name')?.textContent?.slice(0, 200) ||
          `Waypoint ${i + 1}`,
      },
      geometry: { type: 'Point', coordinates: position(waypoint) },
    });
  for (const [i, segment] of [
    ...descendants(doc, 'trkseg'),
    ...descendants(doc, 'rte'),
  ].entries()) {
    const nodes = [
      ...descendants(segment, 'trkpt'),
      ...descendants(segment, 'rtept'),
    ];
    if (nodes.length < 2) continue;
    features.push({
      type: 'Feature',
      id: `route-${i}`,
      properties: { name: `Route ${i + 1}` },
      geometry: { type: 'LineString', coordinates: nodes.map(position) },
    });
  }
  if (features.length > 2000) throw new RangeError('Too many GPX features');
  return { type: 'FeatureCollection', features };
}
export function parseLocalGis(filename, input) {
  const ext = String(filename).split('.').pop().toLowerCase();
  const document =
    ext === 'kml'
      ? parseKml(input)
      : ext === 'gpx'
        ? parseGpx(input)
        : JSON.parse(input);
  return parseGeoJson(JSON.stringify(document));
}
