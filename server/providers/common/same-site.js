import { admitSameSiteRequest } from '../../../src/localRequestGate.mjs';

/** First element of a comma-separated forwarding header, trimmed. */
function firstForwardedValue(value) {
  return String(value ?? '')
    .split(',')[0]
    .trim();
}

/** Strip the IPv4-mapped IPv6 prefix so `::ffff:10.0.0.2` matches `10.0.0.2`. */
function normalizePeer(address) {
  return String(address || '')
    .replace(/^::ffff:/i, '')
    .trim();
}

/**
 * Socket peers allowed to forward requests (GEV_TRUSTED_PROXIES, comma list of
 * exact IP addresses). Empty by default: the local-first posture refuses every
 * proxied request unless the operator names their own reverse proxy.
 */
export function trustedProxyPeers(env = process.env) {
  return new Set(
    String(env.GEV_TRUSTED_PROXIES || '')
      .split(',')
      .map(normalizePeer)
      .filter(Boolean),
  );
}

/** Whether this request's socket peer is an operator-trusted reverse proxy. */
export function isTrustedProxyPeer(req, env = process.env) {
  const peers = trustedProxyPeers(env);
  if (!peers.size) return false;
  return peers.has(normalizePeer(req?.socket?.remoteAddress));
}

/**
 * Cross-site request gate for cost-bearing and log endpoints. Feeds the
 * request to the pure, unit-tested `admitSameSiteRequest` and answers 403
 * itself when the request is refused. Returns true when it has already
 * responded (the caller returns); false when the handler should continue.
 * Refuses cross-site browser requests (foreign or opaque Origin, a
 * Sec-Fetch-Site other than same-origin/none, or reverse-proxy headers) while
 * keeping loopback non-browser tools and the HOST=0.0.0.0 LAN opt-in working.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} True when a 403 was sent.
 */
export function admitSameSite(req, res) {
  const trusted = isTrustedProxyPeer(req);
  const headers = req.headers || {};
  const forwardedHost = trusted
    ? firstForwardedValue(headers['x-forwarded-host'])
    : '';
  const forwardedProto = trusted
    ? firstForwardedValue(headers['x-forwarded-proto']).toLowerCase()
    : '';
  const verdict = admitSameSiteRequest({
    hostHeader: forwardedHost || req.headers?.host,
    protocol:
      forwardedProto === 'https' || forwardedProto === 'http'
        ? `${forwardedProto}:`
        : req.socket?.encrypted
          ? 'https:'
          : 'http:',
    trustedProxy: trusted,
    origin: req.headers?.origin,
    secFetchSite: req.headers?.['sec-fetch-site'],
    proxyHeaders: req.headers || {},
  });
  if (verdict.ok) return false;
  res.statusCode = verdict.status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: verdict.error }));
  return true;
}

/**
 * Wrap a middleware handler so cross-site requests are refused with 403
 * before the handler runs. Loopback tools and same-origin browser requests
 * pass straight through.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: Function) => unknown} handler
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: Function) => unknown}
 */
export function sameSiteGated(handler) {
  return (req, res, next) => {
    if (admitSameSite(req, res)) return undefined;
    return handler(req, res, next);
  };
}
