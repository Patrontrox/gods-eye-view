/**
 * Shared upstream governor for every provider's outbound `fetch`.
 *
 * Per-client limits (rate-limit.js) stop one browser from hammering a proxy;
 * they do not stop the server as a whole from hammering an upstream, nor from
 * firing the same request five times because five panels asked at once. This
 * module sits under every provider by wrapping the process' `fetch` once, and
 * adds, per upstream host:
 *
 *   - single-flight: concurrent identical body-less GETs share one upstream
 *     request; each caller receives its own clone of the response, and the
 *     shared request is aborted only when every caller has aborted;
 *   - an outbound budget (requests/minute per host) answered locally with a
 *     synthetic 429 once spent;
 *   - a circuit breaker: after N consecutive failures (network error, 429 or
 *     5xx) the host is short-circuited with a synthetic 503 for a cool-down,
 *     then one probe is let through (half-open);
 *   - telemetry: counters per host, readable through `governorSnapshot()` and
 *     the `/api/governor/status` endpoint.
 *
 * Synthetic responses carry `x-gev-governor` so providers and logs can tell
 * them apart from real upstream answers. Loopback hosts are never governed.
 * `GEV_UPSTREAM_GOVERNOR=0` disables the whole layer.
 */
import { resolvePerMinuteCap } from './rate-limit.js';

export const DEFAULT_HOST_PER_MIN = 600;
export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_COOLDOWN_MS = 30_000;
const WINDOW_MS = 60_000;
const MAX_TRACKED_HOSTS = 512;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Normalise any fetch input to { url, method, hasBody, headers }. */
function describeRequest(input, init = {}) {
  let url;
  let method = init.method;
  let hasBody = init.body !== undefined && init.body !== null;
  if (typeof input === 'string' || input instanceof URL)
    url = new URL(String(input));
  else if (input && typeof input.url === 'string') {
    url = new URL(input.url);
    method ??= input.method;
    hasBody ||= Boolean(input.body);
  } else return null;
  return { url, method: String(method || 'GET').toUpperCase(), hasBody, init };
}

function headerKey(headers) {
  if (!headers) return '';
  const entries =
    typeof headers.entries === 'function' && !Array.isArray(headers)
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
  return entries
    .map(([k, v]) => `${String(k).toLowerCase()}:${v}`)
    .sort()
    .join('\n');
}

function synthetic(status, reason, host) {
  return new Response(JSON.stringify({ error: reason, host }), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-gev-governor': reason,
      'retry-after': '30',
    },
  });
}

/** Whether an upstream answer counts against the breaker. */
function isFailureStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * Build a governed fetch around `baseFetch`.
 *
 * @param {typeof fetch} baseFetch
 * @param {object} [options]
 */
export function createUpstreamGovernor(
  baseFetch,
  {
    perHostPerMin = DEFAULT_HOST_PER_MIN,
    hostLimits = {},
    failureThreshold = DEFAULT_FAILURE_THRESHOLD,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    now = () => Date.now(),
  } = {},
) {
  /** host -> state */
  const hosts = new Map();
  /** dedupe key -> { promise, controller, waiters } */
  const inflight = new Map();

  const stateFor = (host) => {
    let state = hosts.get(host);
    if (!state) {
      if (hosts.size >= MAX_TRACKED_HOSTS) {
        const oldest = hosts.keys().next().value;
        hosts.delete(oldest);
      }
      state = {
        times: [],
        consecutiveFailures: 0,
        openedAt: null,
        probing: false,
        stats: {
          requests: 0,
          upstream: 0,
          deduplicated: 0,
          throttled: 0,
          shortCircuited: 0,
          failures: 0,
          lastStatus: null,
          lastError: null,
          lastAt: null,
        },
      };
      hosts.set(host, state);
    }
    return state;
  };

  const limitFor = (host) => {
    const value = hostLimits[host];
    return Number.isFinite(value) ? value : perHostPerMin;
  };

  const record = (state, { ok, status, error }) => {
    state.stats.lastAt = now();
    state.stats.lastStatus = status ?? null;
    if (error)
      state.stats.lastError = String(error?.message || error).slice(0, 200);
    if (ok) {
      state.consecutiveFailures = 0;
      state.openedAt = null;
    } else {
      state.stats.failures += 1;
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= failureThreshold) state.openedAt = now();
    }
    state.probing = false;
  };

  const runUpstream = async (state, input, init) => {
    state.stats.upstream += 1;
    try {
      const response = await baseFetch(input, init);
      record(state, {
        ok: !isFailureStatus(response.status),
        status: response.status,
      });
      return response;
    } catch (error) {
      // A caller's own abort is not the upstream's fault.
      if (error?.name !== 'AbortError' && error?.name !== 'TimeoutError') {
        record(state, { ok: false, error });
      } else state.probing = false;
      throw error;
    }
  };

  const governed = async (input, init = {}) => {
    const request = describeRequest(input, init);
    if (!request || LOOPBACK.has(request.url.hostname))
      return baseFetch(input, init);
    const host = request.url.host;
    const state = stateFor(host);
    state.stats.requests += 1;
    const t = now();

    // Circuit breaker.
    if (state.openedAt !== null) {
      if (t - state.openedAt < cooldownMs || state.probing) {
        state.stats.shortCircuited += 1;
        return synthetic(503, 'circuit-open', host);
      }
      state.probing = true; // half-open: let exactly one probe through
    }

    const dedupable =
      request.method === 'GET' &&
      !request.hasBody &&
      init.redirect !== 'manual';
    const key = dedupable
      ? `${request.url.href}\n${headerKey(init.headers ?? input?.headers)}`
      : null;
    const shared = key ? inflight.get(key) : null;
    if (shared) {
      state.stats.deduplicated += 1;
      return joinShared(shared, init.signal);
    }

    // Outbound budget (shared requests above cost nothing extra).
    const limit = limitFor(host);
    if (limit > 0) {
      state.times = state.times.filter((at) => t - at < WINDOW_MS);
      if (state.times.length >= limit) {
        state.stats.throttled += 1;
        if (state.probing) state.probing = false;
        return synthetic(429, 'upstream-budget', host);
      }
      state.times.push(t);
    }

    if (!key) return runUpstream(state, input, init);

    const controller = new AbortController();
    const entry = { controller, waiters: 0, promise: null };
    const { signal: _callerSignal, ...rest } = init;
    entry.promise = runUpstream(state, input, {
      ...rest,
      signal: controller.signal,
    });
    inflight.set(key, entry);
    const cleanup = () => {
      if (inflight.get(key) === entry) inflight.delete(key);
    };
    entry.promise.then(cleanup, cleanup);
    return joinShared(entry, init.signal);
  };

  const joinShared = (entry, signal) => {
    entry.waiters += 1;
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      entry.waiters -= 1;
      if (entry.waiters <= 0) entry.controller.abort(signal?.reason);
    };
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        leave();
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (response) => {
          signal?.removeEventListener('abort', onAbort);
          if (left) return;
          left = true;
          try {
            resolve(response.clone());
          } catch (error) {
            reject(error);
          }
        },
        (error) => {
          signal?.removeEventListener('abort', onAbort);
          left = true;
          reject(error);
        },
      );
    });
  };

  const snapshot = () => {
    const t = now();
    const out = {};
    for (const [host, state] of hosts) {
      const open = state.openedAt !== null && t - state.openedAt < cooldownMs;
      out[host] = {
        ...state.stats,
        circuit: open
          ? 'open'
          : state.openedAt !== null
            ? 'half-open'
            : 'closed',
        usedThisMinute: state.times.filter((at) => t - at < WINDOW_MS).length,
        limitPerMinute: limitFor(host),
      };
    }
    return {
      generatedAt: new Date(t).toISOString(),
      inflight: inflight.size,
      hosts: out,
    };
  };

  return {
    fetch: governed,
    snapshot,
    reset: () => {
      hosts.clear();
      inflight.clear();
    },
  };
}

let installed = null;

/** Parse `host=perMin,host=perMin` overrides. */
export function parseHostLimits(value) {
  const limits = {};
  for (const part of String(value || '').split(',')) {
    const [host, cap] = part.split('=').map((s) => s?.trim());
    if (!host || cap === undefined) continue;
    const n = Number(cap);
    if (Number.isFinite(n) && n >= 0) limits[host] = Math.floor(n);
  }
  return limits;
}

/**
 * Wrap `globalThis.fetch` once for this process. Idempotent.
 * Returns the governor, or null when disabled by `GEV_UPSTREAM_GOVERNOR=0`.
 */
export function installUpstreamGovernor(
  env = process.env,
  target = globalThis,
) {
  if (installed) return installed;
  if (String(env.GEV_UPSTREAM_GOVERNOR ?? '').trim() === '0') return null;
  // Under node:test, suites stub and restore `fetch` freely; capturing a stub
  // as the governor's base would leak it into later tests.
  if (env.NODE_TEST_CONTEXT && env.GEV_UPSTREAM_GOVERNOR !== '1') return null;
  if (typeof target.fetch !== 'function') return null;
  const base = target.fetch.bind(target);
  installed = createUpstreamGovernor(base, {
    perHostPerMin: resolvePerMinuteCap(
      env.GEV_UPSTREAM_PER_MIN,
      DEFAULT_HOST_PER_MIN,
    ),
    hostLimits: parseHostLimits(env.GEV_UPSTREAM_HOST_LIMITS),
  });
  target.fetch = installed.fetch;
  return installed;
}

/** Current telemetry, or null when the governor is not installed. */
export function governorSnapshot() {
  return installed?.snapshot() ?? null;
}
