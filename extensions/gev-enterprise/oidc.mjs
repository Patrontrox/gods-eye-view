/** Strict RS256 OIDC ID-token validation using the native Node crypto runtime.
 * No HS256/none fallback. A trusted issuer and its HTTPS JWKS URI are administrator-configured.
 */
import { createPublicKey, verify as verifySignature, randomBytes, createHash } from 'node:crypto';

export class AuthenticationError extends Error {
  constructor(message = 'Authentication failed') { super(message); this.name = 'AuthenticationError'; }
}
const b64 = (value) => Buffer.from(value, 'base64url');
/** Incrementally enforce a byte ceiling, including chunked / missing Content-Length. */
export async function readBoundedBytes(response, max) {
  if (Number(response.headers?.get('content-length') || 0) > max) throw new Error('Oversized response');
  const reader = response.body?.getReader?.(); if (!reader) throw new Error('Streaming response required');
  const parts = []; let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > max) throw new Error('Oversized response');
      parts.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}
function objectPart(part) {
  if (!/^[A-Za-z0-9_-]{1,12000}$/.test(part)) throw new AuthenticationError();
  try {
    const obj = JSON.parse(b64(part).toString('utf8'));
    if (!obj || Array.isArray(obj) || typeof obj !== 'object') throw Error();
    return obj;
  } catch { throw new AuthenticationError(); }
}
export function createOidcVerifier({ issuer, audience, jwksUri, fetchImpl = fetch, now = () => Date.now(), cacheMs = 300000 }) {
  if (typeof issuer !== 'string' || typeof audience !== 'string' || !issuer || !audience) throw new Error('OIDC issuer and audience are required');
  const url = new URL(jwksUri);
  const issuerUrl = new URL(issuer);
  if (url.protocol !== 'https:' || issuerUrl.protocol !== 'https:' || url.username || url.password ||
      issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) {
    throw new Error('OIDC issuer and JWKS must be HTTPS and canonical');
  }
  if (url.origin !== issuerUrl.origin) throw new Error('Cross-origin JWKS refused unless independently verified');
  if (!Number.isInteger(cacheMs) || cacheMs < 1000 || cacheMs > 3600000) throw new RangeError('Invalid JWKS cache');
  let keys = [], expires = 0, loading;
  async function loadKeys(force = false) {
    if (!force && keys.length && now() < expires) return keys;
    if (loading) return loading;
    loading = (async () => {
      const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
      if (!res.ok || Number(res.headers?.get('content-length') || 0) > 128000) throw new AuthenticationError('JWKS unavailable');
      const buf = await readBoundedBytes(res, 128000);
      const parsed = JSON.parse(Buffer.from(buf).toString('utf8'));
      if (!Array.isArray(parsed.keys) || parsed.keys.length > 24) throw new AuthenticationError('Invalid JWKS');
      keys = parsed.keys.filter(k => k?.kty === 'RSA' && k.use !== 'enc' && (!k.alg || k.alg === 'RS256') &&
        typeof k.kid === 'string' && k.kid.length <= 128 && typeof k.n === 'string' && typeof k.e === 'string');
      if (!keys.length) throw new AuthenticationError('No permitted signing keys');
      expires = now() + cacheMs;
      return keys;
    })();
    try { return await loading; } finally { loading = undefined; }
  }
  async function verify(token, { nonce } = {}) {
    if (typeof token !== 'string' || token.length < 100 || token.length > 16000) throw new AuthenticationError();
    const chunks = token.split('.');
    if (chunks.length !== 3 || !chunks.every(Boolean)) throw new AuthenticationError();
    const header = objectPart(chunks[0]);
    const claims = objectPart(chunks[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit || header.jku || header.jwk || header.x5u) throw new AuthenticationError();
    let matching = (await loadKeys()).filter(k => k.kid === header.kid);
    if (matching.length !== 1) matching = (await loadKeys(true)).filter(k => k.kid === header.kid);
    if (matching.length !== 1) throw new AuthenticationError();
    let good = false;
    try { good = verifySignature('RSA-SHA256', Buffer.from(`${chunks[0]}.${chunks[1]}`), createPublicKey({ key: matching[0], format: 'jwk' }), b64(chunks[2])); } catch { /* forbidden key */ }
    if (!good) throw new AuthenticationError();
    const seconds = now() / 1000;
    const aud = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    if (claims.iss !== issuer || !Array.isArray(aud) || !aud.includes(audience) ||
      typeof claims.sub !== 'string' || !claims.sub ||
      !Number.isFinite(claims.exp) || seconds >= claims.exp + 30 ||
      (Number.isFinite(claims.nbf) && seconds + 30 < claims.nbf) ||
      (Number.isFinite(claims.iat) && claims.iat > seconds + 30) ||
      (aud.length > 1 && claims.azp !== audience) ||
      (nonce !== undefined && claims.nonce !== nonce)) throw new AuthenticationError();
    return Object.freeze({ ...claims });
  }
  return Object.freeze({ verify });
}

/** Roles must come from verified issuer claims; caller configures the claim path. */
export function rolesFromClaims(claims, claimName = 'roles') {
  if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+){0,3}$/.test(claimName)) throw new Error('Invalid roles claim');
  const value = claimName.split('.').reduce((acc, key) => acc?.[key], claims);
  return Array.isArray(value) ? value.filter(x => typeof x === 'string' && /^(viewer|analyst|operator|admin)$/.test(x)) : [];
}
export function requireRole(roles, role) {
  const hierarchy = { viewer: 1, analyst: 2, operator: 3, admin: 4 };
  if (!hierarchy[role] || !roles.some(r => (hierarchy[r] || 0) >= hierarchy[role])) throw new AuthenticationError('Insufficient permissions');
}
export const newVerifier = () => randomBytes(32).toString('base64url');
export const pkceChallenge = secret => createHash('sha256').update(secret).digest('base64url');
