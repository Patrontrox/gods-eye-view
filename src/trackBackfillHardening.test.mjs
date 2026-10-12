import test from 'node:test';
import assert from 'node:assert/strict';
import { trackBackfillProxies } from '../server/providers/aircraft/tracks.js';

function setup({ limit = 2, fetchImpl, now = () => 0, tokenProvider = async () => 'token' } = {}) {
  const handlers = new Map();
  const plugin = trackBackfillProxies({
    maxRequestsPerMinute: limit,
    now,
    tokenProvider,
    fetchImpl: fetchImpl || (async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })),
  });
  plugin.configureServer({ middlewares: { use: (route, fn) => handlers.set(route, fn) } });
  async function call(route, query) {
    const output = { statusCode: 200, headers: {}, body: '',
      setHeader(key, value) { this.headers[key] = value; },
      end(value) { this.body = value; },
    };
    await handlers.get(route)({ url: `/?${query}` }, output);
    return output;
  }
  return { call };
}

test('new unique keys consume a bounded upstream budget; cache hits do not', async () => {
  let calls = 0;
  const f = setup({ limit: 2, fetchImpl: async () => {
    calls++;
    return new Response('{"ok":true}', { status: 200 });
  }});
  for (const id of ['aab001', 'aab002'])
    assert.equal((await f.call('/api/military/track', `hex=${id}`)).statusCode, 200);
  const blocked = await f.call('/api/military/track', 'hex=aab003');
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['Retry-After']) > 0);
  assert.equal((await f.call('/api/military/track', 'hex=aab001')).statusCode, 200);
  assert.equal(calls, 2);
});

test('concurrent identical requests make one upstream call', async () => {
  let count = 0;
  let resolveFetch;
  const pending = new Promise((resolve) => { resolveFetch = resolve; });
  const f = setup({ limit: 1, fetchImpl: async () => {
    count++;
    await pending;
    return new Response('{"ok":true}', { status: 200 });
  }});
  const a = f.call('/api/military/track', 'hex=bb0001');
  const b = f.call('/api/military/track', 'hex=bb0001');
  resolveFetch();
  const responses = await Promise.all([a, b]);
  assert.deepEqual(responses.map((x) => x.statusCode), [200, 200]);
  assert.equal(count, 1);
});

test('OpenSky token is fetched only after admission; upstream cooldown is honored', async () => {
  let tokenCalls = 0;
  const f = setup({ limit: 2,
    tokenProvider: async () => { tokenCalls++; return 'test-token'; },
    fetchImpl: async () => new Response('{"error":"busy"}', {
      status: 429, headers: { 'retry-after': '120' },
    }),
  });
  const one = await f.call('/api/flights/track', 'icao24=ab0001');
  const two = await f.call('/api/flights/track', 'icao24=ab0002');
  assert.equal(one.statusCode, 429);
  assert.equal(two.statusCode, 429);
  assert.ok(Number(two.headers['Retry-After']) >= 120);
  assert.equal(tokenCalls, 1);
});
