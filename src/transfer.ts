import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { Actor } from './auth.js';
import { requirePermission } from './auth.js';
import { pool, tx, uid } from './db.js';
import { snapshot } from './game.js';

const chunkSize=32768;
const obj=z.record(z.string(),z.unknown());
const imported=z.object({format:z.literal('dungeonmaster-world-v1'),snapshot:z.object({
  world:z.object({name:z.string().min(1).max(100),owner_id:z.string().min(1),status:z.enum(['setup','active','archived']),settings:obj,state:obj}),
  members:z.array(z.object({user_id:z.string().min(1),ready:z.boolean(),active:z.boolean(),role:z.string(),preference:obj})).min(1).max(8),
  characters:z.array(z.object({id:z.uuid(),user_id:z.string(),name:z.string().min(1).max(80),sheet:obj})).max(8),
  story:z.object({public:obj,private:obj}).nullable(),
  npcs:z.array(z.object({id:z.uuid(),name:z.string(),visibility:z.enum(['public','private']),data:obj})).max(200),
  quests:z.array(z.object({id:z.uuid(),name:z.string(),visibility:z.enum(['public','private']),data:obj})).max(200),
  combat:z.object({state:obj,active:z.boolean()}).nullable()
})});

export async function exportWorld(actor: Actor,worldId: string) {
  requirePermission(actor,'dm');requirePermission(actor,'owner');
  return tx(async db=>{await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const w=await db.query('SELECT owner_id FROM worlds WHERE id=$1 AND group_id=$2 AND deleted_at IS NULL',[worldId,actor.groupId]);
    if(w.rows[0]?.owner_id!==actor.userId)throw new Error('只有房主可导出完整世界');
    const data=gzipSync(JSON.stringify({format:'dungeonmaster-world-v1',snapshot:await snapshot(db,worldId)}));
    if(data.length>200*1024*1024)throw new Error('导出超过 200 MB');
    await db.query('DELETE FROM world_exports WHERE world_id=$1',[worldId]);
    const exportId=uid();
    await db.query("INSERT INTO world_exports(id,world_id,group_id,owner_id,data,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",[exportId,worldId,actor.groupId,actor.userId,data]);
    return {exportId,sizeBytes:data.length,chunks:Math.ceil(data.length/chunkSize),chunkSize,expiresInSeconds:3600};
  });
}
export async function readExportChunk(actor: Actor,exportId: string,index: number) {
  requirePermission(actor,'dm');requirePermission(actor,'owner');
  const r=await pool.query('SELECT data FROM world_exports WHERE id=$1 AND group_id=$2 AND owner_id=$3 AND expires_at>now()',[exportId,actor.groupId,actor.userId]);
  if(!r.rows.length)throw new Error('导出不存在或已过期');
  const bytes=Buffer.from(r.rows[0].data);
  const chunks=Math.ceil(bytes.length/chunkSize);
  if(index<0||index>=chunks)throw new Error('分块序号无效');
  return {exportId,index,chunks,base64:bytes.subarray(index*chunkSize,(index+1)*chunkSize).toString('base64')};
}
export async function beginImport(actor: Actor,expectedChunks: number) {
  requirePermission(actor,'world');requirePermission(actor,'owner');
  if(expectedChunks<1||expectedChunks>6400)throw new Error('分块数量无效');
  const importId=uid();
  await pool.query("INSERT INTO world_imports(id,group_id,user_id,expected_chunks,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",[importId,actor.groupId,actor.userId,expectedChunks]);
  return {importId,expectedChunks,expiresInSeconds:3600};
}
export async function uploadImportChunk(actor: Actor,importId: string,index: number,base64: string) {
  requirePermission(actor,'world');requirePermission(actor,'owner');
  const bytes=Buffer.from(base64,'base64');
  if(bytes.length<1||bytes.length>chunkSize||bytes.toString('base64')!==base64)throw new Error('导入分块格式或大小无效');
  const r=await pool.query('SELECT expected_chunks FROM world_imports WHERE id=$1 AND group_id=$2 AND user_id=$3 AND expires_at>now()',[importId,actor.groupId,actor.userId]);
  if(!r.rows.length||index<0||index>=r.rows[0].expected_chunks)throw new Error('导入会话或分块序号无效');
  await pool.query('INSERT INTO world_import_chunks(import_id,chunk_index,data) VALUES($1,$2,$3) ON CONFLICT(import_id,chunk_index) DO UPDATE SET data=$3',[importId,index,bytes]);
  return {received:true,index};
}
export async function importWorld(actor: Actor,importId: string) {
  requirePermission(actor,'world');requirePermission(actor,'owner');
  return tx(async db=>{
    const session=await db.query('SELECT expected_chunks FROM world_imports WHERE id=$1 AND group_id=$2 AND user_id=$3 AND expires_at>now() FOR UPDATE',[importId,actor.groupId,actor.userId]);
    if(!session.rows.length)throw new Error('导入会话不存在或已过期');
    const chunks=await db.query('SELECT chunk_index,data FROM world_import_chunks WHERE import_id=$1 ORDER BY chunk_index',[importId]);
    if(chunks.rows.length!==session.rows[0].expected_chunks||chunks.rows.some((x:any,i:number)=>x.chunk_index!==i))throw new Error('导入分块未齐');
    const compressed=Buffer.concat(chunks.rows.map((x:any)=>x.data));
    if(compressed.length>200*1024*1024)throw new Error('导入超过 200 MB');
    const data=imported.parse(JSON.parse(gunzipSync(compressed).toString()));
    const s=data.snapshot;
    if(s.world.settings.rulesVersion&&s.world.settings.rulesVersion!=='srd-5.1')throw new Error('当前仅支持 SRD 5.1 规则');
    if(s.world.owner_id!==actor.userId)throw new Error('导入操作必须由源世界房主发起');
    const memberIds=new Set(s.members.map(x=>x.user_id));
    if(memberIds.size!==s.members.length||!memberIds.has(actor.userId)||s.characters.some(x=>!memberIds.has(x.user_id)))throw new Error('导入的成员或角色关系无效');
    for(const c of s.characters){
      const sheet=c.sheet as Record<string,any>;
      if(!Number.isInteger(sheet.level)||sheet.level<1||sheet.level>20||!Number.isInteger(sheet.hpMax)||sheet.hpMax<1||sheet.hpMax>500||!Number.isInteger(sheet.hp)||sheet.hp<0||sheet.hp>sheet.hpMax||!Number.isInteger(sheet.ac)||sheet.ac<1||sheet.ac>30||!Number.isInteger(sheet.experience)||sheet.experience<0)throw new Error('导入角色数值无效');
    }
    const worldId=uid();
    await db.query('INSERT INTO worlds(id,group_id,name,owner_id,status,settings,state) VALUES($1,$2,$3,$4,$5,$6,$7)',[worldId,actor.groupId,s.world.name,actor.userId,s.world.status,JSON.stringify(s.world.settings),JSON.stringify(s.world.state)]);
    await db.query('INSERT INTO world_branches(id,world_id,name,active) VALUES($1,$2,$3,true)',[uid(),worldId,'主线']);
    for(const m of s.members)await db.query('INSERT INTO members(world_id,user_id,ready,active,role,preference) VALUES($1,$2,$3,$4,$5,$6)',[worldId,m.user_id,m.ready,m.active,m.user_id===actor.userId?'owner':'player',JSON.stringify(m.preference)]);
    const ids=new Map<string,string>();
    for(const c of s.characters){const newId=uid();ids.set(c.id,newId);await db.query('INSERT INTO characters(id,world_id,user_id,name,sheet) VALUES($1,$2,$3,$4,$5)',[newId,worldId,c.user_id,c.name,JSON.stringify(c.sheet)]);}
    if(s.story)await db.query('INSERT INTO story(world_id,public,private) VALUES($1,$2,$3)',[worldId,JSON.stringify(s.story.public),JSON.stringify(s.story.private)]);
    for(const n of s.npcs)await db.query('INSERT INTO npcs(id,world_id,name,visibility,data) VALUES($1,$2,$3,$4,$5)',[uid(),worldId,n.name,n.visibility,JSON.stringify(n.data)]);
    for(const q of s.quests)await db.query('INSERT INTO quests(id,world_id,name,visibility,data) VALUES($1,$2,$3,$4,$5)',[uid(),worldId,q.name,q.visibility,JSON.stringify(q.data)]);
    if(s.combat){const state={...s.combat.state} as any;if(Array.isArray(state.order))state.order=state.order.map((x:any)=>({...x,id:ids.get(x.id)||x.id}));
      await db.query('INSERT INTO combats(world_id,state,active) VALUES($1,$2,$3)',[worldId,JSON.stringify(state),s.combat.active]);}
    await db.query("INSERT INTO game_events(world_id,type,payload) VALUES($1,'world_imported',$2)",[worldId,JSON.stringify({source:'dungeonmaster-world-v1'})]);
    await db.query('UPDATE worlds SET version=version+1 WHERE id=$1',[worldId]);
    await db.query('DELETE FROM world_imports WHERE id=$1',[importId]);
    return {worldId,name:s.world.name,players:s.members.length,characters:s.characters.length};
  });
}
