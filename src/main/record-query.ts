import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { RecordPage } from '../shared/record-query-contracts.ts';
import { AiError } from './ai/errors.ts';
import { integer, keys, providerId, uuid } from "./ai/primitives.ts";

const filterFields = {
  ai_results: ['productId'], ai_calls: ['productId', 'providerId', 'status'],
  image_versions: ['productId'], image_selections: ['productId'], content_versions: ['productId'],
} as const;
type RecordTable = keyof typeof filterFields;
type Filters = Partial<Record<'productId' | 'providerId' | 'status', string>>;
type Row = Record<string, SQLOutputValue>;
type Validator<T> = (raw: unknown) => T;
interface Cursor { version: 1; table: RecordTable; filters: Filters; after: number; upper: number }

function where(table: RecordTable, filters: Filters): { sql: string; values: string[] } {
  const allowed: readonly string[] = filterFields[table];
  if (Object.keys(filters).some(key => !allowed.includes(key))) throw new AiError('INVALID_INPUT');
  const fields = filterFields[table].filter(key => filters[key] !== undefined);
  return { sql: fields.map(key => `json_extract(record_json,'$.${key}')=?`).join(' AND '), values: fields.map(key => filters[key]!) };
}
function parse(table: RecordTable, raw: unknown): { filters: Filters; pageSize: number; cursor?: string } {
  try {
    const o = keys(raw, table === 'ai_calls' ? [] : ['productId'], [...filterFields[table], 'pageSize', 'cursor']);
    const filters: Filters = {};
    if (Object.hasOwn(o, 'productId')) filters.productId = uuid(typeof o.productId === 'string' ? o.productId.toLowerCase() : o.productId);
    if (Object.hasOwn(o, 'providerId')) filters.providerId = providerId(o.providerId);
    if (Object.hasOwn(o, 'status')) { if (typeof o.status !== 'string' || !['RUNNING', 'SUCCEEDED', 'FAILED'].includes(o.status)) throw new Error(); filters.status = o.status; }
    const pageSize = Object.hasOwn(o, 'pageSize') ? integer(o.pageSize, 1, 100) : 50;
    if (Object.hasOwn(o, 'cursor') && (typeof o.cursor !== 'string' || o.cursor.length < 1 || o.cursor.length > 2048)) throw new Error();
    return { filters, pageSize, ...(Object.hasOwn(o, 'cursor') ? { cursor: o.cursor as string } : {}) };
  } catch { throw new AiError('INVALID_INPUT'); }
}

/** Fixed table/field allowlists and bound values; all records retain full validation and identity checks. */
export class RecordReader {
  private db: DatabaseSync;
  // Ephemeral and private to this reader, so reopening/restoring a service invalidates its cursors.
  private secret = randomBytes(32);
  constructor(db: DatabaseSync) { this.db = db; }
  private decode<T extends { id: string }>(row: Row, validate: Validator<T>): T {
    try { const value = validate(JSON.parse(String(row.record_json))); if (value.id !== row.id) throw new Error(); return value; }
    catch { throw new AiError('INVALID_CONFIG'); }
  }
  list<T extends { id: string }>(table: RecordTable, filters: Filters, validate: Validator<T>): T[] {
    const condition = where(table, filters);
    try { return this.db.prepare(`SELECT id,record_json FROM ${table}${condition.sql ? ` WHERE ${condition.sql}` : ''} ORDER BY rowid`).all(...condition.values).map(row => this.decode(row, validate)); }
    catch { throw new AiError('INVALID_CONFIG'); }
  }
  get<T extends { id: string }>(table: RecordTable, rawId: string, validate: Validator<T>): T | undefined {
    const id = uuid(rawId);
    try { const row = this.db.prepare(`SELECT id,record_json FROM ${table} WHERE id=?`).get(id); return row ? this.decode(row, validate) : undefined; }
    catch { throw new AiError('INVALID_CONFIG'); }
  }
  private encode(cursor: Cursor): string {
    const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }
  private cursor(raw: string, table: RecordTable, filters: Filters): Cursor {
    try {
      const parts = raw.split('.');
      if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw new Error();
      const body = Buffer.from(parts[0], 'base64url'), signature = Buffer.from(parts[1], 'base64url');
      if (body.toString('base64url') !== parts[0] || signature.toString('base64url') !== parts[1]
        || !timingSafeEqual(signature, createHmac('sha256', this.secret).update(parts[0]).digest())) throw new Error();
      const o = keys(JSON.parse(body.toString('utf8')), ['version', 'table', 'filters', 'after', 'upper']);
      if (o.version !== 1 || o.table !== table || JSON.stringify(o.filters) !== JSON.stringify(filters)) throw new Error();
      const upper = integer(o.upper, 1, Number.MAX_SAFE_INTEGER), after = integer(o.after, 1, upper);
      return { version: 1, table, filters, after, upper };
    } catch { throw new AiError('INVALID_INPUT'); }
  }
  query<T extends { id: string }>(table: RecordTable, raw: unknown, validate: Validator<T>): RecordPage<T> {
    const input = parse(table, raw), condition = where(table, input.filters);
    // Capture the append boundary before fetching the first page. No long-lived SQLite transaction is held.
    const cursor = input.cursor ? this.cursor(input.cursor, table, input.filters) : {
      version: 1 as const, table, filters: input.filters, after: 0,
      upper: integer(this.db.prepare(`SELECT COALESCE(MAX(rowid),0) AS upper FROM ${table}`).get()!.upper, 0, Number.MAX_SAFE_INTEGER),
    };
    try {
      const rows = this.db.prepare(`SELECT rowid,id,record_json FROM ${table} WHERE ${condition.sql ? `${condition.sql} AND ` : ''}rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`).all(...condition.values, cursor.after, cursor.upper, input.pageSize + 1);
      const selected = rows.slice(0, input.pageSize), items = selected.map(row => this.decode(row, validate));
      const nextCursor = rows.length > input.pageSize ? this.encode({ ...cursor, after: integer(selected.at(-1)!.rowid, 1, Number.MAX_SAFE_INTEGER) }) : null;
      return { items, nextCursor };
    } catch { throw new AiError('INVALID_CONFIG'); }
  }
}
