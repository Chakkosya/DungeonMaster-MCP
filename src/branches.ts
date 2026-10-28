import { gzipSync,gunzipSync } from 'node:zlib';
import type { Actor } from './auth.js';
import { requirePermission } from './auth.js';
import { pool, tx, lockWorld, idempotent, uid, type Db } from './db.js';
import { snapshot, applySnapshot } from './game.js';

async function owner(db:Db,actor:Actor,worldId:string){
  requirePermission(actor,'owner');
  const r=await db.query('SELECT owner_id FROM worlds WHERE id=$1 AND group_id=$2 AND deleted_at IS NULL',[worldId,actor.groupId]);
  if(r.rows[0]?.owner_id!==actor.userId)throw new Error('此操作需要房主身份');
}
async function quota(db:Db,worldId:string,currentBytes:number,replacedBytes=0){
  const [settings,saves,branches,totalSaves,totalBranches]=await Promise.all([
    db.query('SELECT world_quota_bytes,server_quota_bytes FROM server_settings WHERE id=true'),
    db.query('SELECT coalesce(sum(size_bytes),0)::bigint AS bytes FROM saves WHERE world_id=$1 AND deleted_at IS NULL',[worldId]),
    db.query('SELECT coalesce(sum(size_bytes),0)::bigint AS bytes FROM world_branches WHERE world_id=$1',[worldId]),
    db.query('SELECT coalesce(sum(size_bytes),0)::bigint AS bytes FROM saves WHERE deleted_at IS NULL'),
    db.query('SELECT coalesce(sum(size_bytes),0)::bigint AS bytes FROM world_branches')]);
  if(Number(saves.rows[0].bytes)+Number(branches.rows[0].bytes)-replacedBytes+currentBytes>Number(settings.rows[0].world_quota_bytes))throw new Error('分支超过世界存储配额');
  if(Number(totalSaves.rows[0].bytes)+Number(totalBranches.rows[0].bytes)-replacedBytes+currentBytes>Number(settings.rows[0].server_quota_bytes))throw new Error('分支超过服务器存储配额');
}
async function currentSnapshot(db:Db,id:string){const compressed=gzipSync(JSON.stringify(await snapshot(db,id)));JSON.parse(gunzipSync(compressed).toString());return compressed;}
export async function listBranches(actor:Actor,worldId:string){
  requirePermission(actor,'read');
  const w=await pool.query('SELECT id FROM worlds WHERE id=$1 AND group_id=$2 AND deleted_at IS NULL',[worldId,actor.groupId]);if(!w.rows.length)throw new Error('世界不存在或无权访问');
  const r=await pool.query('SELECT id,name,active,size_bytes,created_at,updated_at FROM world_branches WHERE world_id=$1 ORDER BY created_at',[worldId]);return r.rows;
}
export async function branchFromSave(actor:Actor,worldId:string,saveId:string,name:string){
  return tx(async db=>idempotent(db,worldId,actor.requestId,async()=>{await lockWorld(db,worldId);await owner(db,actor,worldId);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('global-saves',0))");
    const branches=await db.query('SELECT id,active FROM world_branches WHERE world_id=$1 FOR UPDATE',[worldId]);
    if(branches.rows.length>=3)throw new Error('世界最多保留 3 个剧情分支，请先删除一个非活动分支');
    const active=branches.rows.find((x:any)=>x.active);if(!active)throw new Error('活动分支不存在');
    const save=await db.query('SELECT snapshot FROM saves WHERE id=$1 AND world_id=$2 AND deleted_at IS NULL',[saveId,worldId]);if(!save.rows.length)throw new Error('存档不存在');
    const next=JSON.parse(gunzipSync(save.rows[0].snapshot).toString());
    const current=await currentSnapshot(db,worldId);await quota(db,worldId,current.length);
    await db.query('UPDATE world_branches SET snapshot=$2,size_bytes=$3,active=false,updated_at=now() WHERE id=$1',[active.id,current,current.length]);
    const branchId=uid();await db.query('INSERT INTO world_branches(id,world_id,name,active) VALUES($1,$2,$3,true)',[branchId,worldId,name]);
    await applySnapshot(db,worldId,next);
    await db.query("INSERT INTO game_events(world_id,type,payload) VALUES($1,'branch_created',$2)",[worldId,JSON.stringify({branchId,saveId})]);
    return {branchId,name,active:true};
  }));
}
export async function switchBranch(actor:Actor,worldId:string,branchId:string){
  return tx(async db=>idempotent(db,worldId,actor.requestId,async()=>{await lockWorld(db,worldId);await owner(db,actor,worldId);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('global-saves',0))");
    const r=await db.query('SELECT id,name,active,snapshot,size_bytes FROM world_branches WHERE world_id=$1 FOR UPDATE',[worldId]);
    const active=r.rows.find((x:any)=>x.active),target=r.rows.find((x:any)=>x.id===branchId);
    if(!target||target.active||!target.snapshot)throw new Error('目标不是可切换的非活动分支');
    if(!active)throw new Error('活动分支不存在');
    const current=await currentSnapshot(db,worldId);await quota(db,worldId,current.length,Number(target.size_bytes));
    const next=JSON.parse(gunzipSync(target.snapshot).toString());
    await db.query('UPDATE world_branches SET snapshot=$2,size_bytes=$3,active=false,updated_at=now() WHERE id=$1',[active.id,current,current.length]);
    await db.query('UPDATE world_branches SET snapshot=NULL,size_bytes=0,active=true,updated_at=now() WHERE id=$1',[branchId]);
    await applySnapshot(db,worldId,next);
    await db.query("INSERT INTO game_events(world_id,type,payload) VALUES($1,'branch_switched',$2)",[worldId,JSON.stringify({branchId})]);
    return {branchId,name:target.name,active:true};
  }));
}
export async function deleteBranch(actor:Actor,worldId:string,branchId:string,token:string){
  return tx(async db=>idempotent(db,worldId,actor.requestId,async()=>{await lockWorld(db,worldId);await owner(db,actor,worldId);
    const confirmed=await db.query("DELETE FROM confirmations WHERE token=$1 AND world_id=$2 AND user_id=$3 AND kind='branch_delete' AND target_id=$4 AND expires_at>now() RETURNING token",[token,worldId,actor.userId,branchId]);
    if(!confirmed.rows.length)throw new Error('确认令牌无效或已过期');
    const r=await db.query('DELETE FROM world_branches WHERE id=$1 AND world_id=$2 AND NOT active RETURNING id',[branchId,worldId]);
    if(!r.rows.length)throw new Error('只能删除非活动分支');
    await db.query("INSERT INTO game_events(world_id,type,payload) VALUES($1,'branch_deleted',$2)",[worldId,JSON.stringify({branchId})]);
    return {deleted:true,branchId};
  }));
}
