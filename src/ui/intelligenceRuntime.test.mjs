import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAnalystRecord,
  collectAnalystObservations,
  createGeofenceEngine,
  serializeWorkspace,
  parseWorkspace,
  correlateObservations,
  validateOtTopology,
} from './intelligenceRuntime.js';
import { parseLocalGis } from './intelligenceFiles.js';

test('GIS load enforces coordinate bounds and hostile properties', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { title: '<script>alert(1)</script>' },
        geometry: { type: 'Point', coordinates: [-6, 37] },
      },
    ],
  };
  const valid = parseLocalGis('point.geojson', JSON.stringify(fc));
  assert.equal(valid.summary.vertexCount, 1);
  assert.equal(
    valid.collection.features[0].properties.title,
    '<script>alert(1)</script>',
  );
  assert.throws(
    () =>
      parseLocalGis(
        'bad.json',
        JSON.stringify({
          ...fc,
          features: [
            {
              ...fc.features[0],
              geometry: { type: 'Point', coordinates: [400, 40] },
            },
          ],
        }),
      ),
    /outside/,
  );
  assert.throws(() => parseLocalGis('bad.json', '{bad json'), SyntaxError);
});
test('analyst normalization refuses positions without IDs and avoids inventing source timestamps', () => {
  const receivedAt = 1770000000000;
  assert.equal(
    normalizeAnalystRecord(
      { lat: 37, lon: -6 },
      'aircraft',
      'flights',
      receivedAt,
    ),
    null,
  );
  assert.equal(
    normalizeAnalystRecord(
      { id: 'ac', lat: -92, lon: -6 },
      'aircraft',
      'flights',
      receivedAt,
    ),
    null,
  );
  assert.equal(
    normalizeAnalystRecord(
      { id: 'x', lat: 37, lon: -6 },
      'person',
      'flights',
      receivedAt,
    ),
    null,
  );
  const clean = normalizeAnalystRecord(
    { id: 'AB 123', lat: 37, lon: -6 },
    'aircraft',
    'flights',
    receivedAt,
  );
  assert.equal(clean.observedAt, receivedAt);
  assert.equal(clean.observationTimeKnown, false);
  assert.equal(clean.id, 'AB_123');
});
test('only enabled and explicitly-supported layer records are enumerated', () => {
  const manager = {
    layers: new Map([
      [
        'flights',
        {
          enabled: true,
          module: {
            getAnalystRecords: () => [{ id: '123abc', lat: 37, lon: -6 }],
          },
        },
      ],
      [
        'vessels',
        {
          enabled: false,
          module: {
            getAnalystRecords: () => {
              throw new Error('should not be called');
            },
          },
        },
      ],
      [
        'unknown',
        {
          enabled: true,
          module: {
            getAnalystRecords: () => [{ id: 'person', lat: 37, lon: -6 }],
          },
        },
      ],
    ]),
  };
  const data = collectAnalystObservations(manager);
  assert.equal(data.length, 1);
  assert.equal(data[0].source, 'flights');
  assert.equal(data[0].kind, 'aircraft');
});
test('geofences and correlation operate only on finite infrastructure records', () => {
  const geometry = {
    type: 'Polygon',
    coordinates: [
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
        [-1, -1],
      ],
    ],
  };
  const engine = createGeofenceEngine({
    rules: [{ id: 'test', transition: 'both', geometry }],
  });
  const now = Date.now();
  engine.observe(
    [
      {
        id: 'aircraft',
        source: 'flights',
        kind: 'aircraft',
        lat: 0,
        lon: 2,
        observedAt: now - 1000,
      },
    ],
    now,
  );
  const alerts = engine.observe(
    [
      {
        id: 'aircraft',
        source: 'flights',
        kind: 'aircraft',
        lat: 0,
        lon: 0,
        observedAt: now,
      },
    ],
    now,
  );
  assert.equal(alerts[0].transition, 'enter');
  const matches = correlateObservations(
    [{ id: 'a', lat: 0, lon: 0, source: 'flights', observedAt: now }],
    [{ id: 'b', lat: 0, lon: 0.001, source: 'vessels', observedAt: now }],
    { radiusMeters: 1000 },
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].causal, false);
});
test('workspace excludes secret fields and OT rejects asset addresses', () => {
  assert.deepEqual(
    parseWorkspace(
      serializeWorkspace({
        title: 'test',
        camera: { lat: 2, lon: 3 },
        layers: ['flights'],
      }),
    ).title,
    'test',
  );
  assert.throws(
    () => serializeWorkspace({ title: 'bad', visual: { token: 'secret' } }),
    /credentials/,
  );
  assert.throws(
    () =>
      validateOtTopology({
        zones: [{ id: 'a', classification: 'control', ip: '10.0.0.1' }],
        conduits: [],
      }),
    /Detailed OT/,
  );
});
