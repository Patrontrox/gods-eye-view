/** Optional enterprise sidecar. Bind only 127.0.0.1; deploy behind an HTTPS reverse proxy
 * with authentication enabled for the rest of God's Eye View as well.
 * Never touches PLCs, SIS, DCS, or plant networks. Accepts only pre-aggregated local OT data.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createOidcVerifier, rolesFromClaims, requireRole, newVerifier, pkceChallenge, AuthenticationError, readBoundedBytes } from './oidc.mjs';
import { createAemetAlerts } from './aemet.mjs';
import { createConnectors } from './connectors.mjs';
import { validateOtTopology } from '../gev-intel-core/otTopology.js';

const COOKIE_SESSION = '__Host-gev-ent-session';
const COOKIE_PENDING = '__Host-gev-ent-state';
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' };
const issueId = () => randomBytes(32).toString('base64url');
function cookieHeader(req, name) {
  const values = (req.headers.cookie || '').split(';').map(x => x.trim());
  const found = values.find(x => x.startsWith(`${name}=`));
  const value = found?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function send(res, status, data) {
  const text = JSON.stringify(data);
  res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
const sessionCookie = (name, value, maxAge) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
function validHttps(value, title) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(`${title} must be HTTPS`);
  return url;
}

export function createEnterpriseGateway(config, { fetchImpl = fetch, now = () => Date.now(), verifier, aemet, connectors, readAggregate } = {}) {
  const publicOrigin = validHttps(config.publicOrigin, 'Public origin');
  if (publicOrigin.pathname !== '/' || publicOrigin.search) throw new Error('Public origin must be an origin');
  const authorizationEndpoint = validHttps(config.authorizationEndpoint, 'OIDC authorization endpoint');
  const tokenEndpoint = validHttps(config.tokenEndpoint, 'OIDC token endpoint');
  const redirectUri = `${publicOrigin.origin}/api/enterprise/auth/callback`;
  if (typeof config.clientId !== 'string' || !config.clientId) throw new Error('OIDC client ID required');
  const verifyToken = verifier || createOidcVerifier({ issuer: config.issuer, audience: config.clientId, jwksUri: config.jwksUri, fetchImpl, now });
  const weather = aemet || (config.aemetApiKey ? createAemetAlerts({ apiKey: config.aemetApiKey, fetchImpl, now }) : null);
  const registry = connectors || createConnectors({ definitions: config.connectors || [], secrets: config.env || process.env, now });
  const pending = new Map();
  const sessions = new Map();
  const MAX_SESSIONS = 200, SESSION_MS = 60 * 60 * 1000;
  const prune = () => {
    for (const [key, val] of pending) if (val.until <= now()) pending.delete(key);
    for (const [key, val] of sessions) if (val.until <= now()) sessions.delete(key);
  };
  async function aggregate() {
    if (readAggregate) return validateOtTopology(await readAggregate());
    const file = config.otAggregateFile;
    if (!file || !isAbsolute(file)) throw new Error('An absolute GEV_OT_AGGREGATE_FILE is required');
    const info = await stat(file);
    if (!info.isFile() || info.size > 262144) throw new Error('OT aggregate size limit exceeded');
    const bytes = await readFile(file);
    if (bytes.byteLength > 262144) throw new Error('OT aggregate size limit exceeded');
    return validateOtTopology(JSON.parse(bytes.toString('utf8')));
  }
  async function handler(req, res) {
    try {
      const host = String(req.headers.host || '');
      // The proxy must preserve Host; a mismatch is not an alternate permitted domain.
      if (host !== publicOrigin.host) return send(res, 403, { error: 'Host not admitted' });
      const raw = String(req.url || '');
      if (raw.length > 2000 || /\\|%5c/i.test(raw)) return send(res, 400, { error: 'Invalid path' });
      const url = new URL(raw, publicOrigin);
      if (!url.pathname.startsWith('/api/enterprise/')) return send(res, 404, { error: 'Not found' });
      const origin = req.headers.origin;
      if (origin && origin !== publicOrigin.origin) return send(res, 403, { error: 'Cross-origin request refused' });
      if (!['GET','HEAD'].includes(req.method)) return send(res, 405, { error: 'Read-only endpoint' });
      prune();
      const route = url.pathname.slice('/api/enterprise/'.length);
      if (route === 'health') return send(res, 200, { status: 'up', oidc: 'configured', weather: Boolean(weather), localAggregate: Boolean(config.otAggregateFile), note: 'Health is not evidence of downstream source availability' });
      if (route === 'auth/login') {
        if (pending.size >= 200) return send(res, 429, { error: 'Too many authentication attempts' });
        const state = issueId(); const nonce = issueId(); const codeVerifier = newVerifier();
        pending.set(state, { nonce, codeVerifier, until: now() + 5 * 60 * 1000 });
        const dest = new URL(authorizationEndpoint);
        for (const [k, v] of Object.entries({ response_type: 'code', scope: 'openid profile', client_id: config.clientId, redirect_uri: redirectUri,
          state, nonce, code_challenge: pkceChallenge(codeVerifier), code_challenge_method: 'S256' })) dest.searchParams.set(k, v);
        res.writeHead(302, { ...HEADERS, location: dest.toString(), 'set-cookie': sessionCookie(COOKIE_PENDING, state, 300) });
        return res.end();
      }
      if (route === 'auth/callback') {
        const state = url.searchParams.get('state'); const nonceState = cookieHeader(req, COOKIE_PENDING);
        const item = state && pending.get(state); if (state) pending.delete(state);
        if (!item || state !== nonceState || item.until <= now() || !url.searchParams.get('code') || url.searchParams.has('error')) return send(res, 401, { error: 'OIDC state expired or invalid' });
        const form = new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code'), code_verifier: item.codeVerifier,
          client_id: config.clientId, redirect_uri: redirectUri });
        if (config.clientSecret) form.set('client_secret', config.clientSecret);
        const tokenResponse = await fetchImpl(tokenEndpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(7000),
          headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
        if (!tokenResponse.ok || Number(tokenResponse.headers?.get('content-length') || 0) > 16000) return send(res, 401, { error: 'OIDC token exchange failed' });
        const rawTokens = await readBoundedBytes(tokenResponse, 16000);
        const tokens = JSON.parse(Buffer.from(rawTokens).toString('utf8'));
        const claims = await verifyToken.verify(tokens.id_token, { nonce: item.nonce });
        const roles = rolesFromClaims(claims, config.rolesClaim || 'roles');
        if (!roles.length) return send(res, 403, { error: 'No mapped OIDC application role' });
        const sid = issueId();
        sessions.set(sid, { sub: claims.sub, roles, until: now() + SESSION_MS });
        if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
        res.writeHead(302, { ...HEADERS, location: publicOrigin.origin + '/', 'set-cookie': [sessionCookie(COOKIE_PENDING, '', 0), sessionCookie(COOKIE_SESSION, sid, 3600)] });
        return res.end();
      }
      const sid = cookieHeader(req, COOKIE_SESSION);
      const session = sid && sessions.get(sid);
      if (!session || session.until <= now()) return send(res, 401, { error: 'Authentication required' });
      if (route === 'auth/me') return send(res, 200, { authenticated: true, roles: session.roles, subject: session.sub });
      if (route === 'auth/logout') {
        sessions.delete(sid);
        res.setHeader('set-cookie', sessionCookie(COOKIE_SESSION, '', 0));
        return send(res, 200, { authenticated: false });
      }
      if (route === 'aemet/alerts') {
        requireRole(session.roles, 'viewer');
        if (!weather) return send(res, 503, { error: 'AEMET API key not configured' });
        return send(res, 200, await weather.read(url.searchParams.get('area') || 'esp'));
      }
      if (route === 'ot/summary') {
        requireRole(session.roles, 'operator');
        try { return send(res, 200, { topology: await aggregate(), source: 'approved local aggregate', observedAt: new Date(now()).toISOString() }); }
        catch (error) { console.warn('[GEV Enterprise] OT aggregate unavailable:', error.message); return send(res, 503, { error: 'Approved OT aggregate unavailable' }); }
      }
      if (route === 'connectors') {
        requireRole(session.roles, 'analyst');
        return send(res, 200, { connectors: registry.list().filter(x => { try { requireRole(session.roles, x.minRole); return true; } catch { return false; } }) });
      }
      if (route.startsWith('connectors/')) {
        const id = route.slice('connectors/'.length);
        if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) return send(res, 400, { error: 'Invalid connector ID' });
        const definition = registry.list().find(x => x.id === id);
        if (!definition) return send(res, 404, { error: 'Unknown connector' });
        requireRole(session.roles, definition.minRole);
        return send(res, 200, await registry.read(id));
      }
      return send(res, 404, { error: 'Unknown endpoint' });
    } catch (error) {
      if (error instanceof AuthenticationError) return send(res, error.message === 'Insufficient permissions' ? 403 : 401, { error: error.message });
      if (error instanceof RangeError || error instanceof TypeError) return send(res, 400, { error: 'Invalid request' });
      console.warn('[GEV Enterprise] Request unavailable:', error.message);
      return send(res, 502, { error: 'Upstream service unavailable' });
    }
  }
  return Object.freeze({ handler, close: () => { pending.clear(); sessions.clear(); } });
}
export function startEnterpriseGateway(config) {
  const gateway = createEnterpriseGateway(config);
  const port = Number(config.port || 4474);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid gateway port');
  const server = createServer(gateway.handler);
  server.requestTimeout = 12000;
  server.headersTimeout = 8000;
  server.maxRequestsPerSocket = 100;
  server.listen(port, '127.0.0.1', () => console.log(`[GEV Enterprise] local sidecar listening on 127.0.0.1:${port}; HTTPS reverse proxy required`));
  server.once('close', gateway.close);
  return server;
}
