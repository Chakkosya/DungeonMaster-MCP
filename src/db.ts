import pg from 'pg';
import { randomUUID } from 'node:crypto';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export type Db = pg.Pool | pg.PoolClient;
export async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}
export async function lockWorld(db: Db, worldId: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [worldId]);
}
export async function idempotent<T>(db: Db, scope: string, requestId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${scope}:${requestId}`;
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  const old = await db.query('SELECT result FROM idempotency WHERE key=$1', [key]);
  if (old.rows.length) return old.rows[0].result as T;
  const result = await fn();
  await db.query('INSERT INTO idempotency(key,result) VALUES($1,$2)', [key, JSON.stringify(result)]);
  return result;
}
export function uid() { return randomUUID(); }
