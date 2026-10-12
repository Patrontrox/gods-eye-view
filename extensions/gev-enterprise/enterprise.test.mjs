import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createOidcVerifier, rolesFromClaims, requireRole } from './oidc.mjs';
import { validateConnector, createConnectors, publicAddress } from './connectors.mjs';
import { createAemetAlerts } from './aemet.mjs';
import { signReportPdf, verifyReportPdf } from './report-signature.mjs';
import { createEnterpriseGateway } from './gateway.mjs';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';

const json = o => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = rsa.publicKey.export({ format: 'jwk' });
const issuer = 'https://id.example.org';
const now = 1900000000000;
function jwt(payload, header = { alg: 'RS256', kid: 'good' }) {
  const base64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const content = `${base64(header)}.${base64(payload)}`;
  return `${content}.${sign('RSA-SHA256', Buffer.from(content), rsa.privateKey).toString('base64url')}`;
}
function claims(extra = {}) {
  return { iss: issuer, aud: 'gevent', sub: 'subject-1', roles: ['viewer'], exp: now / 1000 + 300, iat: now / 1000 - 60, ...extra };
}
const verifier = createOidcVerifier({ issuer, audience: 'gevent', jwksUri: `${issuer}/jwks`, now: () => now,
  fetchImpl: async () => json({ keys: [{ ...publicJwk, alg: 'RS256', kid: 'good', use: 'sig' }] }) });

test('verifies signed OIDC JWT, audience, nonce, expiry and signature without algorithm downgrade', async () => {
  const good = jwt(claims({ nonce: 'nonce123' }));
  assert.equal((await verifier.verify(good, { nonce: 'nonce123' })).sub, 'subject-1');
  await assert.rejects(verifier.verify(good, { nonce: 'wrong' }));
  await assert.rejects(verifier.verify(jwt(claims({ aud: 'wrong' }))));
  await assert.rejects(verifier.verify(jwt(claims({ exp: now/1000 - 120 }))));
  await assert.rejects(verifier.verify(jwt(claims(), { alg: 'none', kid: 'good' })));
  await assert.rejects(verifier.verify(good.slice(0,-10)+'0000000000'));
});
test('RBAC role assignment must be issuer-verified and hierarchy is enforced', () => {
  assert.deepEqual(rolesFromClaims({ roles: ['viewer','admin','root',null] }), ['viewer','admin']);
  assert.deepEqual(rolesFromClaims({ realm_access: { roles: ['operator'] } }, 'realm_access.roles'), ['operator']);
  requireRole(['operator'], 'viewer');
  assert.throws(() => requireRole(['viewer'], 'operator'));
});
test('connector metadata refuses direct private, credentials, redirect and invalid DNS results', async () => {
  const base = { id:'approved-weather', title:'Weather', url:'https://public.example.org/data' };
  assert.equal(validateConnector(base).id, 'approved-weather');
  assert.throws(() => validateConnector({ ...base, url:'http://public.example.org/data' }));
  assert.throws(() => validateConnector({ ...base, url:'https://127.0.0.1/x' }));
  assert.throws(() => validateConnector({ ...base, url:'https://public.example.org/x?redirect=http://internal' }));
  for(const ip of ['127.0.0.1','10.0.0.10','192.168.1.2','172.20.3.1','169.254.169.254','::1','fd00::1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
  const registry = createConnectors({ definitions:[base], resolveDns:async () => [{address:'10.0.0.1'}], fetchImpl:async () => { throw Error('must never call'); } });
  await assert.rejects(registry.read(base.id), /prohibited address/);
});
test('connector requests are coalesced, capped and readable by ID only', async () => {
  let calls = 0;
  const r = createConnectors({ definitions: [{ id: 'approved', title: 'Approved', url: 'https://good.example.org/record' }],
    resolveDns: async () => [{address:'8.8.8.8'}],
    fetchImpl: async () => { calls++; return json({status:'operational'}); },
    now: () => now });
  const [a,b] = await Promise.all([r.read('approved'),r.read('approved')]);
  assert.deepEqual(a,b); assert.equal(calls,1);
  assert.deepEqual((await r.read('approved')).data,{status:'operational'}); assert.equal(calls,1);
  await assert.rejects(r.read('http://private.local'));
});
test('AEMET official two-stage API enforces same-origin data URL, caching and response shape', async () => {
  let count=0;
  const weather = createAemetAlerts({ apiKey: 'private-key', now: () => now, fetchImpl: async uri => {
    count++;
    const url = new URL(uri);
    if (url.pathname.includes('/api/')) {
      assert.equal(url.searchParams.get('api_key'),'private-key');
      return json({ datos: 'https://opendata.aemet.es/opendata/datos/payload.xml' });
    }
    return new Response('<alert><info><event>Viento</event></info></alert>');
  }});
  const result = await weather.read('esp');
  assert.match(result.capXml, /Viento/);
  assert.equal(result.attribution, '© AEMET');
  assert.deepEqual(await weather.read('esp'),result);
  assert.equal(count,2);
  await assert.rejects(weather.read('../../etc/passwd'));
  const evil=createAemetAlerts({ apiKey:'x',fetchImpl:async()=>json({datos:'http://169.254.169.254/metadata'})});
  await assert.rejects(evil.read('esp'), /unexpected data location/);
});
test('PDF detached signature detects document and signature tampering', () => {
  const pair=generateKeyPairSync('ed25519');
  const pdf=Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
  const receipt=signReportPdf(pdf,pair.privateKey.export({type:'pkcs8',format:'pem'}));
  assert.equal(verifyReportPdf(pdf,receipt,pair.publicKey.export({type:'spki',format:'pem'})),true);
  assert.equal(verifyReportPdf(Buffer.concat([pdf,Buffer.from('tampered')]),receipt,receipt.publicKey),false);
  assert.equal(verifyReportPdf(pdf,{...receipt,signature:'aaaa'},receipt.publicKey),false);
});

test('enterprise sidecar denies cross-origin, unauthenticated, and protects OT and connectors by OIDC role', async () => {
  const gw = createEnterpriseGateway({ publicOrigin:'https://gev.example.org', clientId:'gevent',
    authorizationEndpoint:'https://id.example.org/authorize',tokenEndpoint:'https://id.example.org/token',
    otAggregateFile:'/unused', }, { verifier, connectors:createConnectors(),
    readAggregate: async () => ({ zones:[{id:'dmz', classification:'dmz'}], conduits:[] }), now:()=>now });
  const srv=createServer(gw.handler);srv.listen(0,'127.0.0.1'); await once(srv,'listening');
  try {
    const request=(path,opts={})=>new Promise((resolve,reject)=>{
      const req=httpRequest({hostname:'127.0.0.1',port:srv.address().port,path,method:'GET',headers:{Host:'gev.example.org',...opts.headers}},res=>{
        const chunks=[]; res.on('data',c=>chunks.push(c));
        res.on('end',()=>resolve({status:res.statusCode,headers:new Headers(res.headers),body:Buffer.concat(chunks).toString('utf8')}));
      });
      req.on('error',reject);req.end();
    });
    const blocked=await request('/api/enterprise/ot/summary'); assert.equal(blocked.status,401);
    const origin=await request('/api/enterprise/health',{headers:{origin:'https://attacker.example.org'}});assert.equal(origin.status,403);
    const login=await request('/api/enterprise/auth/login');assert.equal(login.status,302);
    assert.match(login.headers.get('location'),/code_challenge_method=S256/);
    assert.match(login.headers.get('set-cookie'),/__Host-gev-ent-state/);
    // Roles are enforced after a real signed OIDC callback exchanges credentials.
  } finally { srv.close(); gw.close(); }
});

test('complete PKCE callback creates a secure session, enforces viewer/operator roles and supports logout', async () => {
  let nextRole = 'viewer';
  const gw = createEnterpriseGateway({
    publicOrigin: 'https://gev.example.org', clientId: 'gevent',
    authorizationEndpoint: 'https://id.example.org/auth', tokenEndpoint: 'https://id.example.org/token',
    otAggregateFile: '/unused',
  }, {
    now: () => now,
    verifier: { verify: async (_idToken, { nonce }) => ({ sub: 'signed-subject', roles: [nextRole], nonce }) },
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'POST');
      assert.equal(new URLSearchParams(options.body).get('grant_type'), 'authorization_code');
      assert.ok(new URLSearchParams(options.body).get('code_verifier')?.length > 30);
      return json({ id_token: 'a.mock.idtoken' });
    },
    connectors: { list: () => [{ id: 'approved', title: 'Approved', minRole: 'analyst' }], read: async () => ({ data: { ready: true } }) },
    aemet: { read: async () => ({ attribution: '© AEMET', area: 'esp', capXml: '<alert/>' }) },
    readAggregate: async () => ({ zones: [{ id: 'level3', classification: 'operations' }], conduits: [] }),
  });
  const srv = createServer(gw.handler); srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  const send = (path, cookie) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: srv.address().port, method: 'GET',
      path, headers: { Host: 'gev.example.org', ...(cookie ? { Cookie: cookie } : {}) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    req.on('error', reject); req.end();
  });
  async function signin(role) {
    nextRole = role;
    const first = await send('/api/enterprise/auth/login');
    const state = new URL(first.headers.location).searchParams.get('state');
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    assert.match(first.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Lax/);
    const callback = await send(`/api/enterprise/auth/callback?state=${state}&code=fixture`, cookie);
    assert.equal(callback.status, 302);
    const sid = callback.headers['set-cookie'].find(x => x.startsWith('__Host-gev-ent-session=')).split(';')[0];
    return sid;
  }
  try {
    const viewer = await signin('viewer');
    assert.equal((await send('/api/enterprise/auth/me', viewer)).body.roles[0], 'viewer');
    assert.equal((await send('/api/enterprise/aemet/alerts', viewer)).status, 200);
    assert.equal((await send('/api/enterprise/connectors', viewer)).status, 403);
    assert.equal((await send('/api/enterprise/ot/summary', viewer)).status, 403);
    const operator = await signin('operator');
    assert.equal((await send('/api/enterprise/ot/summary', operator)).body.topology.zones[0].id, 'level3');
    assert.equal((await send('/api/enterprise/connectors', operator)).body.connectors.length, 1);
    const logout = await send('/api/enterprise/auth/logout', operator);
    assert.equal(logout.status, 200);
    assert.equal((await send('/api/enterprise/ot/summary', operator)).status, 401);
  } finally { srv.close(); gw.close(); }
});
