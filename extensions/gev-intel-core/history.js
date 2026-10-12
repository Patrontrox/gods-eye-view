/** Explicitly enabled local observations archive, SQLite only; no passive collection.
 * Source terms / retention must be reviewed before importing any observation.
 */
import { DatabaseSync } from 'node:sqlite';

function normalizeRecord(record, now) {
  if (!record || !['aircraft', 'vessel', 'weather-event', 'facility'].includes(record.kind)) throw new TypeError('Unsupported observation kind');
  if (typeof record.id !== 'string' || !/^[\w:.-]{1,100}$/.test(record.id)) throw new TypeError('Invalid non-person asset ID');
  if (typeof record.source !== 'string' || !/^[\w.:-]{1,100}$/.test(record.source)) throw new TypeError('Invalid provider ID');
  if (![record.lat, record.lon, record.observedAt].every(Number.isFinite)) throw new TypeError('Invalid position or time');
  if (Math.abs(record.lat) > 90 || Math.abs(record.lon) > 180 || record.observedAt > now + 5000) throw new RangeError('Invalid position or future time');
  return { kind: record.kind, id: record.id, source: record.source, lat: record.lat, lon: record.lon,
    observedAt: Math.floor(record.observedAt), receivedAt: now };
}
export function openHistoryStore({ filename = ':memory:', enabled = false, retentionDays = 7, now = () => Date.now() } = {}) {
  if (!enabled) return Object.freeze({ enabled: false, append() { throw new Error('History is disabled'); },
    query() { return []; }, prune() { return 0; }, close() {} });
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365)
    throw new RangeError('History retentionDays must be 1-365');
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE IF NOT EXISTS observations (
    kind TEXT NOT NULL, asset_id TEXT NOT NULL, source TEXT NOT NULL,
    lat REAL NOT NULL, lon REAL NOT NULL, observed_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL, PRIMARY KEY(kind, asset_id, source, observed_at)
  ); CREATE INDEX IF NOT EXISTS observation_time_idx ON observations(observed_at);`);
  const insert = db.prepare(`INSERT OR IGNORE INTO observations
    (kind,asset_id,source,lat,lon,observed_at,received_at) VALUES (?,?,?,?,?,?,?)`);
  const querySql = db.prepare(`SELECT kind,asset_id AS id,source,lat,lon,
    observed_at AS observedAt,received_at AS receivedAt FROM observations
    WHERE observed_at >= ? AND observed_at <= ? AND kind=? ORDER BY observed_at ASC LIMIT ?`);
  const pruneSql = db.prepare(`DELETE FROM observations WHERE observed_at < ?`);
  let closed = false;
  const active = () => { if (closed) throw new Error('History store closed'); };
  return {
    enabled: true,
    append(records) {
      active();
      if (!Array.isArray(records) || records.length > 1000) throw new RangeError('Append batch limit 1000');
      let count = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const r of records) {
          const x = normalizeRecord(r, now());
          count += Number(insert.run(x.kind, x.id, x.source, x.lat, x.lon, x.observedAt, x.receivedAt).changes);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return count;
    },
    query({ from, to, kind, limit = 5000 }) {
      active();
      if (![from,to].every(Number.isSafeInteger) || from > to || !['aircraft','vessel','weather-event','facility'].includes(kind) ||
        !Number.isInteger(limit) || limit < 1 || limit > 10000) throw new TypeError('Invalid history query');
      return querySql.all(from, to, kind, limit);
    },
    prune() { active(); return Number(pruneSql.run(now() - retentionDays * 86400000).changes); },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
