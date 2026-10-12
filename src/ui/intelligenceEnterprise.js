/** Optional enterprise panel — only talks to same-origin authenticated sidecar endpoints.
 * No bearer tokens or OIDC secrets enter browser storage. All remote text is rendered as textContent.
 */
const API = '/api/enterprise';
const $ = (root, selector) => root.querySelector(selector);
function text(root, value) {
  root.textContent = String(value ?? '').slice(0, 5000);
}
const abortRequest = (signal) =>
  AbortSignal.any([signal, AbortSignal.timeout(12000)]);
async function get(path, signal) {
  const response = await fetch(`${API}/${path}`, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: abortRequest(signal),
  });
  if (!response.ok) {
    if (response.status === 401)
      throw new Error('Connect to enterprise sign-in');
    if (response.status === 403)
      throw new Error('OIDC role does not permit this operation');
    throw new Error(`Enterprise service HTTP ${response.status}`);
  }
  if (Number(response.headers.get('content-length') || 0) > 1800000)
    throw new Error('Enterprise response too large');
  const contents = await response.text();
  if (contents.length > 1800000)
    throw new Error('Enterprise response too large');
  return JSON.parse(contents);
}
function card(container, heading, description) {
  const section = document.createElement('div');
  const title = document.createElement('strong');
  text(title, heading);
  section.append(title);
  const detail = document.createElement('p');
  detail.className = 'gev-muted';
  text(detail, description);
  section.append(detail);
  container.append(section);
}
function extractCaps(xml) {
  if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('Unsupported CAP data');
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.querySelector('parsererror')) throw new Error('Invalid CAP XML');
  const entries = Array.from(parsed.getElementsByTagName('info')).slice(0, 60);
  return entries.map((node) => ({
    event:
      node.getElementsByTagName('event')[0]?.textContent || 'Weather warning',
    severity:
      node.getElementsByTagName('severity')[0]?.textContent || 'unknown',
    effective:
      node.getElementsByTagName('effective')[0]?.textContent || 'unknown',
    expires: node.getElementsByTagName('expires')[0]?.textContent || 'unknown',
    area:
      node.getElementsByTagName('areaDesc')[0]?.textContent ||
      'area not specified',
  }));
}

export function mountEnterpriseDesk(root, { signal } = {}) {
  const section = $(root, '[data-gev-tab="enterprise"]');
  if (!section) throw new Error('Missing Enterprise section');
  const disposers = [];
  const active = new AbortController();
  if (signal?.aborted) active.abort();
  else signal?.addEventListener('abort', () => active.abort(), { once: true });
  const out = $(section, '#gev-emp-output');
  const bind = (selector, callback) => {
    const node = $(section, selector);
    if (!node) throw new Error('Missing Enterprise control');
    const onClick = async () => {
      try {
        if (!active.signal.aborted) await callback();
      } catch (error) {
        text(out, error.message);
      }
    };
    node.addEventListener('click', onClick);
    disposers.push(() => node.removeEventListener('click', onClick));
  };
  bind('#gev-ent-login', () => {
    window.location.assign(`${API}/auth/login`);
  });
  bind('#gev-ent-whoami', async () => {
    const me = await get('auth/me', active.signal);
    text(out, `Signed in. Roles: ${me.roles.join(', ')}.`);
  });
  bind('#gev-ent-logout', async () => {
    await get('auth/logout', active.signal);
    text(out, 'Signed out');
  });
  bind('#gev-ent-aemet', async () => {
    const area = $(section, '#gev-ent-area').value;
    const data = await get(
      `aemet/alerts?area=${encodeURIComponent(area)}`,
      active.signal,
    );
    const warnings = extractCaps(data.capXml);
    const list = $(section, '#gev-ent-list');
    list.replaceChildren();
    if (!warnings.length)
      card(
        list,
        'AEMET',
        'No CAP information available for this area. This does not mean there is no risk.',
      );
    for (const w of warnings)
      card(
        list,
        `${w.severity}: ${w.event}`,
        `${w.area} • ${w.effective} – ${w.expires}`,
      );
    text(
      out,
      `© AEMET • ${data.fetchedAt}. ${warnings.length} CAP information block(s). Source coverage and publication time must be checked.`,
    );
  });
  bind('#gev-ent-ot', async () => {
    const data = await get('ot/summary', active.signal);
    const list = $(section, '#gev-ent-list');
    list.replaceChildren();
    for (const z of data.topology.zones.slice(0, 100))
      card(list, `OT zone ${z.label || z.id}`, z.classification);
    for (const c of data.topology.conduits.slice(0, 100))
      card(list, `${c.from} → ${c.to}`, `State: ${c.status}`);
    text(
      out,
      `Approved read-only OT aggregate • ${data.observedAt}. Not a live safety-process status.`,
    );
  });
  bind('#gev-ent-connectors', async () => {
    const data = await get('connectors', active.signal);
    const list = $(section, '#gev-ent-list');
    list.replaceChildren();
    for (const c of data.connectors) {
      const row = document.createElement('div');
      const button = document.createElement('button');
      button.type = 'button';
      text(button, `Fetch: ${c.title}`);
      button.addEventListener('click', async () => {
        try {
          const response = await get(
            `connectors/${encodeURIComponent(c.id)}`,
            active.signal,
          );
          const pre = document.createElement('pre');
          pre.textContent = JSON.stringify(response.data, null, 2).slice(
            0,
            25000,
          );
          list.replaceChildren(pre);
          text(
            out,
            `${c.id} retrieved with role ${c.minRole}; validate source and freshness.`,
          );
        } catch (error) {
          text(out, error.message);
        }
      });
      row.append(button);
      list.append(row);
    }
    text(out, `Available connectors: ${data.connectors.length}`);
  });
  return () => {
    active.abort();
    for (const fn of disposers) fn();
  };
}
