/** Safe, declarative JSON connectors. Operator chooses URLs at deployment, not the browser.
 * No arbitrary JavaScript, redirects, private addresses, DNS rebinding or custom request bodies.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { readBoundedBytes } from './oidc.mjs';

export function publicAddress(ip) {
  if (isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a !== 169 && a !== 192 && a !== 255 &&
      !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) &&
      !(a === 100 && b >= 64 && b <= 127) && !(a >= 224) &&
      !(a === 198 && [18,19].includes(b)) && !(a === 192 && b === 0);
  }
  if (isIP(ip) === 6) {
    const s = ip.toLowerCase();
    return !/^(::|::1$|fe[89ab]|fc|fd|ff|2001:db8)/.test(s) && !s.startsWith('::ffff:');
  }
  return false;
}
export function validateConnector(def) {
  if (!def || !/^[a-z][a-z0-9-]{1,39}$/.test(def.id) ||
      typeof def.title !== 'string' || !def.title.trim() || def.title.length > 100 ||
      !['viewer','analyst','operator','admin'].includes(def.minRole || 'viewer')) throw new TypeError('Invalid connector metadata');
  const url = new URL(def.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.port && url.port !== '443' || isIP(url.hostname) || !/^[a-z0-9.-]+$/.test(url.hostname) ||
      url.hostname === 'localhost' || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) throw new TypeError('Connector requires public HTTPS DNS endpoint');
  if (def.tokenEnv && !/^GEV_CONNECTOR_[A-Z0-9_]{1,80}$/.test(def.tokenEnv)) throw new TypeError('Invalid secret reference');
  return Object.freeze({ id: def.id, title: def.title, url: url.href, minRole: def.minRole || 'viewer', tokenEnv: def.tokenEnv || null });
}
/** Secure default transport binds TLS to the validated DNS answer, preventing DNS rebinding. */
function pinnedFetch(url, opts, answers) {
  const selected = answers[0];
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'GET', headers: opts.headers, timeout: 6000, maxRedirects: 0,
      lookup(host, options, done) {
        if (host !== new URL(url).hostname) return done(new Error('Unexpected TLS destination'));
        done(null, selected.address, selected.family);
      },
      servername: new URL(url).hostname,
      rejectUnauthorized: true,
    }, response => {
      const chunks = []; let bytes = 0;
      const status = response.statusCode || 502;
      if (status < 200 || status >= 300) { response.destroy(); return reject(new Error('Connector upstream unavailable')); }
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 262144) { response.destroy(); reject(new Error('Connector response exceeds 256 KiB')); }
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status, headers: { 'content-type': 'application/json' } })));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Connector timed out')));
    request.on('error', reject);
    request.end();
  });
}

export function createConnectors({ definitions = [], fetchImpl, resolveDns = lookup, secrets = process.env, now = () => Date.now() } = {}) {
  if (!Array.isArray(definitions) || definitions.length > 20) throw new TypeError('Too many connectors');
  const defs = definitions.map(validateConnector);
  if (new Set(defs.map(x => x.id)).size !== defs.length) throw new TypeError('Duplicate connector IDs');
  const state = new Map();
  const all = () => defs.map(({ id, title, minRole }) => ({ id, title, minRole }));
  async function read(id) {
    const def = defs.find(x => x.id === id); if (!def) throw new TypeError('Unknown connector');
    let session = state.get(id);
    if (session?.until > now()) return session.value;
    if (session?.promise) return session.promise;
    const run = (async () => {
      const url = new URL(def.url);
      // Do not fetch from an untrusted URL even when the administrator mistyped a domain.
      const answers = await resolveDns(url.hostname, { all: true, verbatim: true });
      if (!Array.isArray(answers) || !answers.length || !answers.every(x => publicAddress(x.address))) throw new Error('Connector endpoint resolves to prohibited address');
      // Security boundary: DNS pinning requires a deployment-level egress policy that denies
      // private, loopback and metadata networks. DNS checks alone are not sufficient.
      const headers = { accept: 'application/json' };
      if (def.tokenEnv) {
        const secret = secrets[def.tokenEnv]; if (!secret) throw new Error('Connector secret is not configured');
        headers.authorization = `Bearer ${secret}`;
      }
      const response = await (fetchImpl || ((uri, options) => pinnedFetch(uri, options, answers)))(def.url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(6000) });
      if (!response.ok || Number(response.headers?.get('content-length') || 0) > 262144) throw new Error('Connector unavailable or oversized');
      const bytes = await readBoundedBytes(response, 262144);
      const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Connector must return a JSON object');
      const receivedAt = new Date(now()).toISOString();
      const output = { connector: id, receivedAt, data: value };
      state.set(id, { until: now() + 60000, value: output });
      return output;
    })();
    state.set(id, { ...session, promise: run });
    try { return await run; } finally { if (state.get(id)?.promise === run) state.delete(id); }
  }
  return Object.freeze({ list: all, read });
}
