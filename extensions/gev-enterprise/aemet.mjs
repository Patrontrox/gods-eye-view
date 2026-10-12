/** Official AEMET OpenData CAP warnings (Spanish national or regional area).
 * Two-stage documented AEMET response. Secret stays in backend; untrusted data URLs rejected.
 */
const BASE = 'https://opendata.aemet.es';
const CODES = new Set(['esp','and','arn','ast','bal','can','cant','cat','clm','cyl','ext','gal','mad','mur','nav','pva','rio','val','ceu','mel']);
const readCapped = async (response, max = 1000000) => {
  if (!response.ok || Number(response.headers?.get('content-length') || 0) > max) throw new Error('AEMET data unavailable');
  // Require a readable response body: the fallback .text() can allocate unbounded data.
  const reader = response.body?.getReader?.(); if (!reader) throw new Error('AEMET streaming unavailable');
  const parts = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > max) throw new Error('AEMET response too large');
      parts.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(parts).toString('utf8');
};
export function createAemetAlerts({ apiKey, fetchImpl = fetch, now = () => Date.now() }) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('AEMET_API_KEY is missing');
  const cache = new Map(); const inFlight = new Map();
  async function read(area = 'esp') {
    if (!CODES.has(area)) throw new RangeError('Unrecognized AEMET area');
    const cached = cache.get(area); if (cached && cached.expires > now()) return cached.data;
    if (inFlight.has(area)) return inFlight.get(area);
    const job = (async () => {
      const metaUrl = new URL(`/opendata/api/avisos_cap/ultimoelaborado/area/${area}`, BASE);
      metaUrl.searchParams.set('api_key', apiKey);
      const metaResponse = await fetchImpl(metaUrl, { redirect: 'error', signal: AbortSignal.timeout(7000), headers: { accept: 'application/json' } });
      const meta = JSON.parse(await readCapped(metaResponse, 10000));
      if (!meta || typeof meta.datos !== 'string') throw new Error('AEMET data link unavailable');
      const dataUrl = new URL(meta.datos);
      if (dataUrl.protocol !== 'https:' || dataUrl.origin !== BASE || !dataUrl.pathname.startsWith('/opendata/') || dataUrl.username || dataUrl.password || dataUrl.search || dataUrl.hash) {
        throw new Error('AEMET returned an unexpected data location');
      }
      const dataResponse = await fetchImpl(dataUrl, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { accept: 'application/xml,text/xml,text/plain' } });
      const capXml = await readCapped(dataResponse, 1500000);
      if (/<!DOCTYPE|<!ENTITY/i.test(capXml)) throw new Error('XML entity declarations refused');
      const data = { source: 'AEMET OpenData', attribution: '© AEMET', area, fetchedAt: new Date(now()).toISOString(), capXml };
      cache.set(area, { data, expires: now() + 10 * 60 * 1000 });
      return data;
    })();
    inFlight.set(area, job);
    try { return await job; } finally { if (inFlight.get(area) === job) inFlight.delete(area); }
  }
  return Object.freeze({ read });
}
