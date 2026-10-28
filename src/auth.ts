import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { pool, uid } from './db.js';

export const permissions = ['read','world','game','dm','save','owner'] as const;
export type Permission = typeof permissions[number];
export interface Actor { groupId: string; userId: string; messageId: string; messageTime?: string; requestId: string; keyId: string; permissions: string[]; }
export function digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const actual = scryptSync(password,salt,64);
  const expected = Buffer.from(hash,'hex');
  return expected.length === actual.length && timingSafeEqual(actual,expected);
}
export async function createKey(name: string, groups: string[], grants: string[], expiresAt?: string) {
  if(expiresAt&&(!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=Date.now()))throw new Error('密钥有效期必须是未来时间');
  const key = `dnd_${randomBytes(32).toString('base64url')}`;
  const id = uid();
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('INSERT INTO api_keys(id,name,key_hash,prefix,permissions,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [id,name,digest(key),key.slice(0,12),grants,expiresAt || null]);
    for (const group of new Set(groups)) await db.query('INSERT INTO api_key_groups(key_id,group_id) VALUES($1,$2)',[id,group]);
    await db.query('COMMIT');
    return { id, key };
  } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}
export async function authenticate(req: FastifyRequest): Promise<Actor> {
  const bearer = /^Bearer (dnd_[A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '');
  if (!bearer) throw new Error('缺少 MCP Bearer API Key');
  const groupId = String(req.headers['x-qq-group-id'] || '');
  const userId = String(req.headers['x-qq-user-id'] || '');
  const messageId = String(req.headers['x-qq-message-id'] || '');
  const requestId = String(req.headers['x-request-id'] || messageId);
  const timestamp = String(req.headers['x-qq-message-time'] || '');
  if (!groupId || !userId || !messageId || !requestId || !timestamp || !Number.isFinite(Date.parse(timestamp)))
    throw new Error('缺少可信 QQ 上下文请求头');
  const found = await pool.query(`SELECT k.* FROM api_keys k JOIN api_key_groups g ON g.key_id=k.id
    WHERE k.key_hash=$1 AND g.group_id=$2 AND k.enabled AND NOT k.revoked
    AND (k.expires_at IS NULL OR k.expires_at>now())`, [digest(bearer[1]),groupId]);
  if (!found.rows.length) throw new Error('API Key 无效或未授权此 QQ 群');
  const key = found.rows[0];
  await pool.query('UPDATE api_keys SET last_used_at=now(),last_source=$2,use_count=use_count+1 WHERE id=$1',[key.id,req.ip]);
  return { groupId,userId,messageId,messageTime:timestamp,requestId,keyId:key.id,permissions:key.permissions };
}
export function requirePermission(actor: Actor, permission: Permission) {
  if (!actor.permissions.includes(permission)) throw new Error(`API Key 缺少 ${permission} 权限`);
}
