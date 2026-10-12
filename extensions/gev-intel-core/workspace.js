/** Versioned workspace configuration, no secrets and no network I/O. */
const ALLOWED_KEYS = new Set(['title','camera','layers','visual','annotations']);
const FORBIDDEN_KEYS = new Set(['apikey','token','password','secret','authorization','credentials']);
function walk(value, depth = 0) {
  if (depth > 8) throw new RangeError('Workspace nesting too deep');
  if (Array.isArray(value)) { if (value.length > 1000) throw new RangeError('Workspace list too large'); return value.map(x=>walk(x,depth+1)); }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key,x] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase()) || FORBIDDEN_KEYS.has(key)) throw new TypeError('Workspace must not contain credentials');
      if (['__proto__','constructor','prototype'].includes(key)) throw new TypeError('Unsafe object key');
      result[key] = walk(x,depth+1);
    }
    return result;
  }
  if (['string','number','boolean'].includes(typeof value) || value === null) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Non-finite number');
    return value;
  }
  throw new TypeError('Unsupported workspace value');
}
export function serializeWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace) ||
      Object.keys(workspace).some(k=>!ALLOWED_KEYS.has(k))) throw new TypeError('Unsupported workspace fields');
  if (typeof workspace.title !== 'string' || !workspace.title.trim() || workspace.title.length > 120) throw new TypeError('Workspace title required');
  const record = { version: 1, savedAt: new Date().toISOString(), data: walk(workspace) };
  const json = JSON.stringify(record);
  if (new TextEncoder().encode(json).byteLength > 500000) throw new RangeError('Workspace too large');
  return json;
}
export function parseWorkspace(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 500000) throw new TypeError('Workspace too large');
  const parsed = JSON.parse(text);
  if (parsed?.version !== 1 || typeof parsed.data?.title !== 'string') throw new TypeError('Unsupported workspace schema');
  return walk(parsed.data);
}
