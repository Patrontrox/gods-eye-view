/** Deterministic, local HTML evidence report, escaped at all data boundaries.
 * No remote scripts, images, fonts or styles are loaded; source identifiers remain visible.
 */
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderEvidenceReport({ title, observations, generatedAt = new Date().toISOString() } = {}) {
  if (typeof title !== 'string' || !title.trim() || title.length > 140) throw new TypeError('Report title required');
  if (!Array.isArray(observations) || observations.length > 1000) throw new RangeError('Report observation limit exceeded');
  if (typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt))) throw new TypeError('Invalid report time');
  const rows = observations.map((o) => {
    if (!o || !['aircraft','vessel','weather-event','facility'].includes(o.kind) || typeof o.source !== 'string' || !Number.isFinite(o.observedAt))
      throw new TypeError('Invalid evidence record');
    return `<tr><td>${esc(o.kind)}</td><td>${esc(o.id??'')}</td><td>${esc(o.source)}</td><td>${esc(new Date(o.observedAt).toISOString())}</td><td>${esc(o.note??'')}</td></tr>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${esc(title)}</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#17202a}table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:.45rem;text-align:left}thead{background:#f3f4f6}.notice{padding:.6rem 0;color:#5c6370}</style></head><body><h1>${esc(title)}</h1><p>Generated: ${esc(generatedAt)}</p><p class="notice">Observations are external or user-supplied evidence, not verified facts or proof of causality. Check original sources and timestamps.</p><table><thead><tr><th>Kind</th><th>Asset ID</th><th>Source</th><th>Observed UTC</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}
