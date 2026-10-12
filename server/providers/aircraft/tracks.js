import { getOpenSkyToken } from './opensky.js';
import { readCappedResponseText } from '../common/http.js';

/**
 * Bounded, per-process track-history proxies. A unique ICAO address is not
 * evidence that a caller may spend another OpenSky credit budget unit.
 * Calls with an identical in-flight key share one upstream read.
 * The same policy covers the optional adsb.lol trace path.
 */
export function trackBackfillProxies({
  fetchImpl = (...args) => fetch(...args),
  tokenProvider = getOpenSkyToken,
  now = () => Date.now(),
  maxRequestsPerMinute = 12,
  maxConcurrent = 4,
} = {}) {
  if (!Number.isInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 1)
    throw new RangeError('maxRequestsPerMinute must be positive');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
    throw new RangeError('maxConcurrent must be positive');

  const TRACK_CACHE_MS = 60_000;
  const TRACK_CACHE_MAX = 200;
  const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;
  const WINDOW_MS = 60_000;
  const cache = new Map();
  const inFlight = new Map();
  const providers = new Map([
    ['osky', { requests: [], concurrent: 0, cooldownUntil: 0 }],
    ['lol', { requests: [], concurrent: 0, cooldownUntil: 0 }],
  ]);

  function cachePut(key, entry) {
    cache.set(key, entry);
    if (cache.size > TRACK_CACHE_MAX) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
  }

  function admit(provider) {
    const state = providers.get(provider);
    const stamp = now();
    state.requests = state.requests.filter((at) => stamp - at < WINDOW_MS);
    if (state.cooldownUntil > stamp)
      return Math.max(1, Math.ceil((state.cooldownUntil - stamp) / 1000));
    if (state.concurrent >= maxConcurrent) return 1;
    if (state.requests.length >= maxRequestsPerMinute)
      return Math.max(
        1,
        Math.ceil((state.requests[0] + WINDOW_MS - stamp) / 1000),
      );
    state.requests.push(stamp);
    return 0;
  }

  function reply(res, status, body, retryAfter = 0) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
    res.end(body);
  }

  function upstreamCooldown(state, response) {
    if (response.status !== 429) return;
    const value = Number(response.headers.get('retry-after'));
    const seconds =
      Number.isFinite(value) && value > 0 ? Math.min(900, value) : 60;
    state.cooldownUntil = Math.max(state.cooldownUntil, now() + seconds * 1000);
  }

  async function proxyJson(res, key, upstreamUrl, headerProvider = {}) {
    const provider = key.split(':', 1)[0];
    let entry = cache.get(key);
    if (!entry || now() - entry.at >= TRACK_CACHE_MS) {
      let request = inFlight.get(key);
      if (!request) {
        const retryAfter = admit(provider);
        if (retryAfter) {
          reply(
            res,
            429,
            JSON.stringify({ error: 'Track source rate limited' }),
            retryAfter,
          );
          return;
        }
        const state = providers.get(provider);
        state.concurrent++;
        request = (async () => {
          try {
            // Only mint a token after cache and rate-admission decisions.
            const headers =
              typeof headerProvider === 'function'
                ? await headerProvider()
                : headerProvider;
            const upstream = await fetchImpl(upstreamUrl, {
              headers,
              signal: AbortSignal.timeout(12_000),
            });
            upstreamCooldown(state, upstream);
            const { tooLarge, text } = await readCappedResponseText(
              upstream,
              RESPONSE_CAP_BYTES,
            );
            const status = tooLarge ? 502 : upstream.status;
            const body = tooLarge
              ? JSON.stringify({ error: 'Upstream track response too large' })
              : upstream.ok
                ? text
                : JSON.stringify({
                    error: `Track source HTTP ${upstream.status}`,
                  });
            const result = { at: now(), status, body };
            // Backoff also applies to upstream errors, to avoid repeated calls.
            cachePut(key, result);
            return result;
          } finally {
            state.concurrent--;
          }
        })();
        inFlight.set(key, request);
        void request.then(
          () => {
            if (inFlight.get(key) === request) inFlight.delete(key);
          },
          () => {
            if (inFlight.get(key) === request) inFlight.delete(key);
          },
        );
      }
      entry = await request;
    }
    const cooldown = providers.get(provider).cooldownUntil;
    const remaining =
      entry.status === 429 && cooldown > now()
        ? Math.max(1, Math.ceil((cooldown - now()) / 1000))
        : 0;
    reply(res, entry.status, entry.body, remaining);
  }

  function install(middlewares) {
    middlewares.use('/api/flights/track', async (req, res) => {
      try {
        const incoming = new URL(req.url || '', 'http://localhost');
        const icao24 = String(incoming.searchParams.get('icao24') || '')
          .trim()
          .toLowerCase();
        if (!/^[0-9a-f]{6}$/.test(icao24)) {
          reply(
            res,
            400,
            JSON.stringify({ error: 'icao24 must be a 6-char hex string' }),
          );
          return;
        }
        await proxyJson(
          res,
          `osky:${icao24}`,
          `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`,
          async () => {
            const token = await tokenProvider();
            return token ? { Authorization: `Bearer ${token}` } : {};
          },
        );
      } catch {
        reply(
          res,
          502,
          JSON.stringify({ error: 'OpenSky track fetch failed' }),
        );
      }
    });
    middlewares.use('/api/military/track', async (req, res) => {
      try {
        const incoming = new URL(req.url || '', 'http://localhost');
        const hex = String(incoming.searchParams.get('hex') || '')
          .trim()
          .toLowerCase();
        if (!/^[0-9a-f~]{6,7}$/.test(hex)) {
          reply(
            res,
            400,
            JSON.stringify({ error: 'hex must be a 6-7 char hex string' }),
          );
          return;
        }
        await proxyJson(
          res,
          `lol:${hex}`,
          `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`,
        );
      } catch {
        reply(
          res,
          502,
          JSON.stringify({ error: 'adsb.lol trace fetch failed' }),
        );
      }
    });
  }

  return {
    name: 'track-backfill-proxies',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
