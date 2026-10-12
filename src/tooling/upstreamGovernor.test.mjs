import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUpstreamGovernor,
  parseHostLimits,
} from '../../server/providers/common/upstream-governor.js';

function fakeUpstream(handler) {
  const calls = [];
  const fn = async (input, init = {}) => {
    calls.push({ url: String(input?.url ?? input), init });
    return handler(calls.length, init);
  };
  fn.calls = calls;
  return fn;
}

const ok = (body = 'ok') => new Response(body, { status: 200 });

test('concurrent identical GETs share one upstream request', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const base = fakeUpstream(async () => {
    await gate;
    return ok('shared');
  });
  const g = createUpstreamGovernor(base);
  const p = [1, 2, 3].map(() => g.fetch('https://api.example.com/x'));
  release();
  const bodies = await Promise.all(p.map(async (r) => (await r).text()));
  assert.deepEqual(bodies, ['shared', 'shared', 'shared']);
  assert.equal(base.calls.length, 1);
  assert.equal(g.snapshot().hosts['api.example.com'].deduplicated, 2);
  // after completion a new request goes upstream again
  await (await g.fetch('https://api.example.com/x')).text();
  assert.equal(base.calls.length, 2);
});

test('POSTs and different headers are not deduplicated', async () => {
  const base = fakeUpstream(async () => ok());
  const g = createUpstreamGovernor(base);
  await Promise.all([
    g.fetch('https://a.example/x', { method: 'POST', body: '1' }),
    g.fetch('https://a.example/x', { method: 'POST', body: '1' }),
    g.fetch('https://a.example/y', { headers: { a: '1' } }),
    g.fetch('https://a.example/y', { headers: { a: '2' } }),
  ]);
  assert.equal(base.calls.length, 4);
});

test('one waiter aborting does not cancel the others', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const base = fakeUpstream(async (_n, init) => {
    await gate;
    if (init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return ok('fine');
  });
  const g = createUpstreamGovernor(base);
  const ctl = new AbortController();
  const a = g.fetch('https://b.example/x', { signal: ctl.signal });
  const b = g.fetch('https://b.example/x');
  ctl.abort();
  await assert.rejects(a, { name: 'AbortError' });
  release();
  assert.equal(await (await b).text(), 'fine');
});

test('the shared request aborts when every waiter aborts', async () => {
  let seen;
  const base = fakeUpstream(
    (_n, init) =>
      new Promise((_res, rej) => {
        seen = init.signal;
        init.signal.addEventListener('abort', () =>
          rej(new DOMException('Aborted', 'AbortError')),
        );
      }),
  );
  const g = createUpstreamGovernor(base);
  const c1 = new AbortController();
  const c2 = new AbortController();
  const a = g.fetch('https://c.example/x', { signal: c1.signal });
  const b = g.fetch('https://c.example/x', { signal: c2.signal });
  c1.abort();
  assert.equal(seen.aborted, false);
  c2.abort();
  assert.equal(seen.aborted, true);
  await assert.rejects(a);
  await assert.rejects(b);
  assert.equal(
    g.snapshot().hosts['c.example'].failures,
    0,
    'aborts are not failures',
  );
});

test('outbound budget answers a synthetic 429', async () => {
  const base = fakeUpstream(async () => ok());
  const g = createUpstreamGovernor(base, { perHostPerMin: 2 });
  for (const path of ['1', '2']) await g.fetch(`https://d.example/${path}`);
  const res = await g.fetch('https://d.example/3');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('x-gev-governor'), 'upstream-budget');
  assert.equal(base.calls.length, 2);
});

test('per-host overrides and loopback bypass', async () => {
  const base = fakeUpstream(async () => ok());
  const g = createUpstreamGovernor(base, {
    perHostPerMin: 1,
    hostLimits: { 'e.example': 0 },
  });
  for (let i = 0; i < 5; i += 1)
    assert.equal((await g.fetch(`https://e.example/${i}`)).status, 200);
  for (let i = 0; i < 5; i += 1)
    assert.equal((await g.fetch(`http://localhost:1/${i}`)).status, 200);
  assert.equal(g.snapshot().hosts.localhost, undefined);
});

test('circuit opens after consecutive failures and half-opens after cooldown', async () => {
  let t = 0;
  let status = 503;
  const base = fakeUpstream(async () => new Response('', { status }));
  const g = createUpstreamGovernor(base, {
    failureThreshold: 3,
    cooldownMs: 1000,
    now: () => t,
  });
  for (let i = 0; i < 3; i += 1) await g.fetch(`https://f.example/${i}`);
  const blocked = await g.fetch('https://f.example/z');
  assert.equal(blocked.status, 503);
  assert.equal(blocked.headers.get('x-gev-governor'), 'circuit-open');
  assert.equal(base.calls.length, 3);
  assert.equal(g.snapshot().hosts['f.example'].circuit, 'open');
  t = 1500;
  status = 200;
  assert.equal((await g.fetch('https://f.example/probe')).status, 200);
  assert.equal(g.snapshot().hosts['f.example'].circuit, 'closed');
});

test('network errors count as failures and propagate', async () => {
  const base = fakeUpstream(async () => {
    throw new TypeError('fetch failed');
  });
  const g = createUpstreamGovernor(base);
  await assert.rejects(g.fetch('https://g.example/'), TypeError);
  const s = g.snapshot().hosts['g.example'];
  assert.equal(s.failures, 1);
  assert.match(s.lastError, /fetch failed/);
});

test('host limit parsing', () => {
  assert.deepEqual(parseHostLimits('a.com=5, b.com=0,bad,c.com=x'), {
    'a.com': 5,
    'b.com': 0,
  });
});
