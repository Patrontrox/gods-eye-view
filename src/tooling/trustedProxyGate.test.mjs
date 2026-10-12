import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitSameSite,
  isTrustedProxyPeer,
} from '../../server/providers/common/same-site.js';

function run(req) {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(b) {
      this.body = b;
    },
  };
  const refused = admitSameSite(req, res);
  return { refused, res };
}

const proxied = (remoteAddress) => ({
  socket: { remoteAddress },
  headers: {
    host: '127.0.0.1:5173',
    'x-forwarded-for': '203.0.113.9',
    'x-forwarded-host': 'gev.example.org',
    'x-forwarded-proto': 'https',
    origin: 'https://gev.example.org',
    'sec-fetch-site': 'same-origin',
  },
});

test('proxied requests stay refused by default', () => {
  delete process.env.GEV_TRUSTED_PROXIES;
  assert.equal(run(proxied('10.0.0.2')).refused, true);
});

test('a listed proxy peer is admitted with its forwarded authority', () => {
  process.env.GEV_TRUSTED_PROXIES = '10.0.0.2, 10.0.0.3';
  try {
    assert.equal(
      isTrustedProxyPeer({ socket: { remoteAddress: '::ffff:10.0.0.2' } }),
      true,
    );
    assert.equal(run(proxied('::ffff:10.0.0.2')).refused, false);
    // Unlisted peers sending the same headers are still refused.
    assert.equal(run(proxied('10.0.0.9')).refused, true);
    // A trusted proxy does not relax the origin check.
    const evil = proxied('10.0.0.2');
    evil.headers.origin = 'https://evil.example';
    assert.equal(run(evil).refused, true);
  } finally {
    delete process.env.GEV_TRUSTED_PROXIES;
  }
});
