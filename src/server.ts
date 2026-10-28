import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool, uid, tx, lockWorld } from './db.js';
import { authenticate, createKey, digest, passwordHash, verifyPassword, permissions } from './auth.js';
import { createMcpServer } from './mcp.js';
import { createSave } from './game.js';

const app=Fastify({logger:true,bodyLimit:2*1024*1024});
await app.register(cookie);
await app.register(rateLimit,{max:120,timeWindow:'1 minute'});
await app.register(staticFiles,{root:resolve('admin/dist'),prefix:'/admin/'});

const initial=await pool.query('SELECT count(*)::int AS n FROM admin_users');
if(initial.rows[0].n===0){
  const username=process.env.ADMIN_USERNAME;
  const password=process.env.ADMIN_PASSWORD;
  if(!username||!password||password.length<16) throw new Error('首次启动需设置 ADMIN_USERNAME 和至少 16 位 ADMIN_PASSWORD');
  await pool.query('INSERT INTO admin_users(id,username,password_hash) VALUES($1,$2,$3)',[uid(),username,passwordHash(password)]);
}
app.get('/healthz',async()=>({ok:true}));
app.get('/readyz',async()=>{await pool.query('SELECT 1');return {ready:true};});
app.all('/mcp',{config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:req=>req.headers.authorization||req.ip}}},async(req,reply)=>{
  let actor;
  try{actor=await authenticate(req);}catch(e){return reply.code(401).send({error:e instanceof Error?e.message:String(e)});}
  if(req.method!=='POST')return reply.code(405).send({error:'只支持 POST Streamable HTTP'});
  const server=createMcpServer(actor);
  const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined});
  await server.connect(transport);
  reply.hijack();
  reply.raw.on('close',()=>{void transport.close();void server.close();});
  await transport.handleRequest(req.raw,reply.raw,req.body);
});
type AdminReq={Body:any;Params:{id:string}};
async function admin(req:any,mutate=false){
  const token=req.cookies.dnd_admin;
  if(!token)throw new Error('请先登录');
  const r=await pool.query('SELECT s.*,u.username FROM admin_sessions s JOIN admin_users u ON u.id=s.admin_id WHERE s.token_hash=$1 AND s.expires_at>now()',[digest(token)]);
  if(!r.rows.length)throw new Error('登录已过期');
  if(mutate&&req.headers['x-csrf-token']!==r.rows[0].csrf)throw new Error('CSRF 验证失败');
  return r.rows[0];
}
app.setErrorHandler((error,req,reply)=>{const message=error instanceof Error?error.message:String(error);const status=/登录|CSRF/.test(message)?401:400;reply.code(status).send({error:message});});
app.post<AdminReq>('/admin/api/login',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(req,reply)=>{
  const {username,password}=(req.body||{}) as any;
  const r=await pool.query('SELECT * FROM admin_users WHERE username=$1',[username]);
  if(!r.rows.length||!verifyPassword(String(password||''),r.rows[0].password_hash))return reply.code(401).send({error:'用户名或密码错误'});
  const token=randomBytes(32).toString('base64url');const csrf=randomBytes(24).toString('base64url');
  await pool.query("INSERT INTO admin_sessions(token_hash,admin_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",[digest(token),r.rows[0].id,csrf]);
  reply.setCookie('dnd_admin',token,{httpOnly:true,secure:process.env.PUBLIC_URL?.startsWith('https://')||false,sameSite:'strict',path:'/admin',maxAge:43200});
  return {username,csrf};
});
app.post('/admin/api/logout',async(req,reply)=>{await admin(req,true);await pool.query('DELETE FROM admin_sessions WHERE token_hash=$1',[digest(req.cookies.dnd_admin||'')]);reply.clearCookie('dnd_admin',{path:'/admin'});return {ok:true};});
app.get('/admin/api/me',async req=>{const a=await admin(req);return {username:a.username,csrf:a.csrf};});
app.get('/admin/api/overview',async req=>{await admin(req);const [w,k,s,b]=await Promise.all([
  pool.query('SELECT count(*)::int AS n FROM worlds'),pool.query('SELECT count(*)::int AS n FROM api_keys WHERE enabled AND NOT revoked'),
  pool.query('SELECT count(*)::int AS n,coalesce(sum(size_bytes),0)::bigint AS bytes FROM saves WHERE deleted_at IS NULL'),
  pool.query('SELECT id,filename,status,size_bytes,attempts,error,created_at FROM backup_records ORDER BY created_at DESC LIMIT 10')]);
  return {worlds:w.rows[0].n,activeKeys:k.rows[0].n,saves:s.rows[0].n,saveBytes:s.rows[0].bytes,backups:b.rows};});
app.get('/admin/api/keys',async req=>{await admin(req);const r=await pool.query(`SELECT k.id,k.name,k.prefix,k.permissions,k.enabled,k.revoked,k.expires_at,k.last_used_at,k.use_count,
  k.last_source,k.error_count,
  coalesce(array_agg(g.group_id) FILTER(WHERE g.group_id IS NOT NULL),'{}') AS groups
  FROM api_keys k LEFT JOIN api_key_groups g ON g.key_id=k.id GROUP BY k.id ORDER BY k.created_at DESC`);return r.rows;});
app.post<AdminReq>('/admin/api/keys',async req=>{await admin(req,true);const {name,groups,grants,expiresAt}=(req.body||{}) as any;
  if(typeof name!=='string'||!name.trim()||!Array.isArray(groups)||!groups.length||!groups.every((x:any)=>typeof x==='string'&&x.trim())||!Array.isArray(grants)||!grants.every((x:any)=>permissions.includes(x)))throw new Error('密钥名称、群绑定或权限无效');
  const created=await createKey(name,groups,grants,expiresAt);
  await pool.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','key_created',JSON.stringify({id:created.id,name})]);
  return {...created,endpoint:`${process.env.PUBLIC_URL||'http://localhost:3000'}/mcp`};
});
app.patch<AdminReq>('/admin/api/keys/:id',async req=>{await admin(req,true);const {id}=req.params;const {enabled,revoked}=(req.body||{}) as any;
  if(typeof enabled!=='boolean'&&typeof revoked!=='boolean')throw new Error('需要状态字段');
  await pool.query('UPDATE api_keys SET enabled=coalesce($2,enabled),revoked=coalesce($3,revoked) WHERE id=$1',[id,typeof enabled==='boolean'?enabled:null,typeof revoked==='boolean'?revoked:null]);
  await pool.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','key_status',JSON.stringify({id,enabled,revoked})]);return {ok:true};});
app.post<AdminReq>('/admin/api/keys/:id/rotate',async req=>{await admin(req,true);const db=await pool.connect();
  try{await db.query('BEGIN');const old=await db.query('SELECT * FROM api_keys WHERE id=$1 AND NOT revoked FOR UPDATE',[req.params.id]);if(!old.rows.length)throw new Error('密钥不存在或已撤销');
    const groups=await db.query('SELECT group_id FROM api_key_groups WHERE key_id=$1',[req.params.id]);
    const key=`dnd_${randomBytes(32).toString('base64url')}`;const id=uid();
    await db.query('INSERT INTO api_keys(id,name,key_hash,prefix,permissions,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[id,old.rows[0].name,digest(key),key.slice(0,12),old.rows[0].permissions,old.rows[0].expires_at]);
    for(const g of groups.rows)await db.query('INSERT INTO api_key_groups(key_id,group_id) VALUES($1,$2)',[id,g.group_id]);
    await db.query('UPDATE api_keys SET revoked=true,enabled=false WHERE id=$1',[req.params.id]);
    await db.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','key_rotated',JSON.stringify({oldId:req.params.id,newId:id})]);
    await db.query('COMMIT');return {id,key,endpoint:`${process.env.PUBLIC_URL||'http://localhost:3000'}/mcp`};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
});
app.delete<AdminReq>('/admin/api/keys/:id',async req=>{await admin(req,true);
  await pool.query('DELETE FROM api_keys WHERE id=$1',[req.params.id]);
  await pool.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','key_deleted',JSON.stringify({id:req.params.id})]);return {deleted:true};});
app.get('/admin/api/worlds',async req=>{await admin(req);const r=await pool.query(`SELECT w.id,w.group_id,w.name,w.status,w.version,w.updated_at,
  w.deleted_at,
  (SELECT count(*)::int FROM members m WHERE m.world_id=w.id) AS players,
  (SELECT count(*)::int FROM saves s WHERE s.world_id=w.id AND s.kind='auto') AS autosaves
  FROM worlds w ORDER BY w.updated_at DESC LIMIT 100`);return r.rows;});
app.get<AdminReq>('/admin/api/worlds/:id',async req=>{await admin(req);const [w,m,s,b]=await Promise.all([
  pool.query('SELECT id,group_id,name,status,version,settings,state,deleted_at,updated_at FROM worlds WHERE id=$1',[req.params.id]),
  pool.query('SELECT user_id,ready,active,role FROM members WHERE world_id=$1 ORDER BY joined_at',[req.params.id]),
  pool.query('SELECT id,kind,version,name,note,size_bytes,created_at,deleted_at FROM saves WHERE world_id=$1 ORDER BY created_at DESC',[req.params.id]),
  pool.query('SELECT id,name,active,size_bytes,updated_at FROM world_branches WHERE world_id=$1 ORDER BY created_at',[req.params.id])]);
  if(!w.rows.length)throw new Error('世界不存在');return {world:w.rows[0],players:m.rows,saves:s.rows,branches:b.rows};});
app.post<AdminReq>('/admin/api/worlds/:id/archive',async req=>{await admin(req,true);return tx(async db=>{await lockWorld(db,req.params.id);
  const r=await db.query("UPDATE worlds SET status='archived',updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id",[req.params.id]);if(!r.rows.length)throw new Error('世界不存在');
  await db.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','world_archived',JSON.stringify({worldId:req.params.id})]);return {archived:true};});});
app.post<AdminReq>('/admin/api/worlds/:id/resume',async req=>{await admin(req,true);return tx(async db=>{await lockWorld(db,req.params.id);
  const prior=await db.query("SELECT 1 FROM game_events WHERE world_id=$1 AND type='campaign_started' LIMIT 1",[req.params.id]);
  const r=await db.query("UPDATE worlds SET status=$2,updated_at=now() WHERE id=$1 AND status='archived' AND deleted_at IS NULL RETURNING id",[req.params.id,prior.rows.length?'active':'setup']);if(!r.rows.length)throw new Error('世界未归档');
  await db.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','world_resumed',JSON.stringify({worldId:req.params.id})]);return {resumed:true};});});
app.delete<AdminReq>('/admin/api/worlds/:id',async req=>{await admin(req,true);return tx(async db=>{await lockWorld(db,req.params.id);
  const w=await db.query('SELECT group_id FROM worlds WHERE id=$1 AND deleted_at IS NULL',[req.params.id]);if(!w.rows.length)throw new Error('世界不存在');
  const trash=await db.query('SELECT count(*)::int AS n FROM worlds WHERE group_id=$1 AND deleted_at IS NOT NULL',[w.rows[0].group_id]);if(trash.rows[0].n>=3)throw new Error('当前 QQ 群世界回收站已满');
  await db.query('UPDATE worlds SET deleted_at=now(),updated_at=now() WHERE id=$1',[req.params.id]);await db.query('DELETE FROM group_active_worlds WHERE world_id=$1',[req.params.id]);
  await db.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','world_deleted',JSON.stringify({worldId:req.params.id})]);return {deleted:true};});});
app.post<AdminReq>('/admin/api/worlds/:id/recover',async req=>{await admin(req,true);return tx(async db=>{await lockWorld(db,req.params.id);
  const r=await db.query("UPDATE worlds SET deleted_at=NULL,updated_at=now() WHERE id=$1 AND deleted_at>now()-interval '7 days' RETURNING id",[req.params.id]);if(!r.rows.length)throw new Error('世界不在回收站');
  await db.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','world_recovered',JSON.stringify({worldId:req.params.id})]);return {recovered:true};});});
app.delete<AdminReq>('/admin/api/worlds/:id/purge',async req=>{await admin(req,true);return tx(async db=>{await lockWorld(db,req.params.id);
  const r=await db.query('DELETE FROM worlds WHERE id=$1 AND deleted_at IS NOT NULL RETURNING id',[req.params.id]);if(!r.rows.length)throw new Error('世界不在回收站');
  await db.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','world_purged',JSON.stringify({worldId:req.params.id})]);return {purged:true};});});
app.get<AdminReq>('/admin/api/worlds/:id/saves',async req=>{await admin(req);const r=await pool.query('SELECT id,kind,version,name,note,size_bytes,created_at,deleted_at FROM saves WHERE world_id=$1 ORDER BY created_at DESC',[req.params.id]);return r.rows;});
app.post<AdminReq>('/admin/api/worlds/:id/autosave',async req=>{await admin(req,true);
  const w=await pool.query('SELECT group_id FROM worlds WHERE id=$1 AND deleted_at IS NULL',[req.params.id]);if(!w.rows.length)throw new Error('世界不存在');
  const actor={groupId:w.rows[0].group_id,userId:'admin',messageId:uid(),requestId:uid(),keyId:'admin',permissions:['save']};
  const saved=await createSave(actor,req.params.id,'auto','管理员存档');
  await pool.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','autosave_created',JSON.stringify({worldId:req.params.id,saveId:saved.saveId})]);return saved;});
app.delete<{Params:{id:string;userId:string}}>('/admin/api/worlds/:id/members/:userId',async req=>{await admin(req,true);
  return tx(async db=>{await lockWorld(db,req.params.id);const w=await db.query('SELECT owner_id FROM worlds WHERE id=$1 AND deleted_at IS NULL',[req.params.id]);if(!w.rows.length)throw new Error('世界不存在');if(w.rows[0].owner_id===req.params.userId)throw new Error('不能移除房主');
    const battle=await db.query('SELECT active FROM combats WHERE world_id=$1',[req.params.id]);if(battle.rows[0]?.active)throw new Error('战斗进行中，暂不能移除成员');
    await db.query('DELETE FROM members WHERE world_id=$1 AND user_id=$2',[req.params.id,req.params.userId]);
    await db.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','member_removed',JSON.stringify({worldId:req.params.id,userId:req.params.userId})]);return {removed:true};});});
app.delete<{Params:{id:string;saveId:string}}>('/admin/api/worlds/:id/saves/:saveId',async req=>{await admin(req,true);
  return tx(async db=>{await lockWorld(db,req.params.id);
    const w=await db.query('SELECT id FROM worlds WHERE id=$1 AND deleted_at IS NULL',[req.params.id]);if(!w.rows.length)throw new Error('世界不存在');
    const selected=await db.query("SELECT size_bytes FROM saves WHERE world_id=$1 AND id=$2 AND kind='manual' AND deleted_at IS NULL",[req.params.id,req.params.saveId]);if(!selected.rows.length)throw new Error('只能删除有效手动存档');
    const settings=(await db.query('SELECT recycle_save_limit,recycle_quota_bytes FROM server_settings WHERE id=true')).rows[0];
    const trash=(await db.query('SELECT count(*)::int AS n,coalesce(sum(size_bytes),0)::bigint AS bytes FROM saves WHERE world_id=$1 AND deleted_at IS NOT NULL',[req.params.id])).rows[0];
    if(trash.n>=settings.recycle_save_limit||Number(trash.bytes)+selected.rows[0].size_bytes>Number(settings.recycle_quota_bytes))throw new Error('存档回收站已满，请先清理');
    await db.query("UPDATE saves SET deleted_at=now() WHERE world_id=$1 AND id=$2",[req.params.id,req.params.saveId]);
    await db.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','save_deleted',JSON.stringify({worldId:req.params.id,saveId:req.params.saveId})]);return {deleted:true};});});
app.delete<{Params:{id:string;saveId:string}}>('/admin/api/worlds/:id/saves/:saveId/purge',async req=>{await admin(req,true);
  return tx(async db=>{await lockWorld(db,req.params.id);
    const w=await db.query('SELECT id FROM worlds WHERE id=$1 AND deleted_at IS NULL',[req.params.id]);if(!w.rows.length)throw new Error('世界不存在');
    const r=await db.query('DELETE FROM saves WHERE world_id=$1 AND id=$2 AND deleted_at IS NOT NULL RETURNING id',[req.params.id,req.params.saveId]);if(!r.rows.length)throw new Error('存档不在回收站');
    await db.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','save_purged',JSON.stringify({worldId:req.params.id,saveId:req.params.saveId})]);return {purged:true};});});
app.post<{Params:{id:string;saveId:string}}>('/admin/api/worlds/:id/saves/:saveId/recover',async req=>{await admin(req,true);
  return tx(async db=>{await lockWorld(db,req.params.id);const w=await db.query('SELECT id FROM worlds WHERE id=$1 AND deleted_at IS NULL',[req.params.id]);if(!w.rows.length)throw new Error('世界不存在');const settings=(await db.query('SELECT manual_save_limit FROM server_settings WHERE id=true')).rows[0];
    const count=await db.query("SELECT count(*)::int AS n FROM saves WHERE world_id=$1 AND kind='manual' AND deleted_at IS NULL",[req.params.id]);if(count.rows[0].n>=settings.manual_save_limit)throw new Error('手动存档已满');
    const r=await db.query("UPDATE saves SET deleted_at=NULL WHERE world_id=$1 AND id=$2 AND kind='manual' AND deleted_at>now()-interval '7 days' RETURNING id",[req.params.id,req.params.saveId]);if(!r.rows.length)throw new Error('存档不在回收站');
    await db.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','save_recovered',JSON.stringify({worldId:req.params.id,saveId:req.params.saveId})]);return {recovered:true};});});
app.get('/admin/api/audit',async req=>{await admin(req);const r=await pool.query('SELECT actor,action,detail,created_at FROM audit_logs ORDER BY id DESC LIMIT 100');return r.rows;});
app.get('/admin/api/settings',async req=>{await admin(req);const r=await pool.query('SELECT world_quota_bytes,server_quota_bytes,manual_save_limit,recycle_save_limit,recycle_quota_bytes,backup_quota_bytes,daily_backup_retention,manual_backup_retention FROM server_settings WHERE id=true');return r.rows[0];});
app.patch<AdminReq>('/admin/api/settings',async req=>{await admin(req,true);const data=(req.body||{}) as any;
  const world=Number(data.worldQuotaMb),server=Number(data.serverQuotaMb),manual=Number(data.manualSaveLimit),recycle=Number(data.recycleSaveLimit),recycleMb=Number(data.recycleQuotaMb),backupMb=Number(data.backupQuotaMb),daily=Number(data.dailyBackupRetention),manualBackup=Number(data.manualBackupRetention);
  if(!Number.isInteger(world)||world<10||world>2048||!Number.isInteger(server)||server<world||server>10240||!Number.isInteger(manual)||manual<1||manual>50||!Number.isInteger(recycle)||recycle<1||recycle>100||!Number.isInteger(recycleMb)||recycleMb<1||recycleMb>2048||!Number.isInteger(backupMb)||backupMb<100||backupMb>51200||!Number.isInteger(daily)||daily<1||daily>90||!Number.isInteger(manualBackup)||manualBackup<1||manualBackup>90)throw new Error('系统配额设置无效');
  await pool.query('UPDATE server_settings SET world_quota_bytes=$1,server_quota_bytes=$2,manual_save_limit=$3,recycle_save_limit=$4,recycle_quota_bytes=$5,backup_quota_bytes=$6,daily_backup_retention=$7,manual_backup_retention=$8 WHERE id=true',[world*1024*1024,server*1024*1024,manual,recycle,recycleMb*1024*1024,backupMb*1024*1024,daily,manualBackup]);
  await pool.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','settings_updated',JSON.stringify({world,server,manual,recycle,recycleMb,backupMb,daily,manualBackup})]);return {saved:true};});
app.post('/admin/api/backups',async req=>{await admin(req,true);const id=uid();
  await pool.query('INSERT INTO backup_records(id,filename,status) VALUES($1,$2,$3)',[id,`manual-${id}.dump`,'queued']);
  await pool.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',['admin','backup_requested',JSON.stringify({id})]);
  return {id,status:'queued'};});
app.get('/admin',async(req,reply)=>reply.redirect('/admin/'));

export { app };
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  await app.listen({port:Number(process.env.PORT||3000),host:'0.0.0.0'});
