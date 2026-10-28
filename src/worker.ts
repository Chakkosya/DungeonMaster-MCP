import { spawn } from 'node:child_process';
import { mkdir, stat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pool, uid } from './db.js';
import { autosaveDue, createSave } from './game.js';

const backupDir=process.env.BACKUP_DIR||'/backups';
async function backup(existing?:{id:string;filename:string}){
  await mkdir(backupDir,{recursive:true});
  const filename=existing?.filename||`dnd-${new Date().toISOString().slice(0,10)}.dump`;
  const full=join(backupDir,filename);
  const id=existing?.id||uid();
  if(existing)await pool.query("UPDATE backup_records SET status='running',attempts=attempts+1,updated_at=now(),error=NULL WHERE id=$1",[id]);
  else await pool.query('INSERT INTO backup_records(id,filename,status,attempts) VALUES($1,$2,$3,1)',[id,filename,'running']);
  try{
    const url=new URL(process.env.DATABASE_URL||'');
    await new Promise<void>((resolve,reject)=>{
      const p=spawn('pg_dump',['--format=custom','--file',full,'--host',url.hostname,'--port',url.port||'5432','--username',decodeURIComponent(url.username),url.pathname.slice(1)],{env:{...process.env,PGPASSWORD:decodeURIComponent(url.password)},stdio:'ignore'});
      p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error(`pg_dump exit ${code}`)));
    });
    await new Promise<void>((resolve,reject)=>{
      const p=spawn('pg_restore',['--file=/dev/null',full],{stdio:'ignore'});
      p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error(`pg_restore exit ${code}`)));
    });
    const size=(await stat(full)).size;
    await pool.query("UPDATE backup_records SET status='complete',size_bytes=$2,updated_at=now() WHERE id=$1",[id,size]);
  }catch(e){await unlink(full).catch(()=>{});await pool.query("UPDATE backup_records SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,next_attempt_at=now()+interval '5 minutes',updated_at=now(),error=$2 WHERE id=$1",[id,e instanceof Error?e.message:String(e)]);throw e;}
}
async function tick(){
  await pool.query("UPDATE backup_records SET status='queued',next_attempt_at=now(),updated_at=now() WHERE status='running' AND attempts<3 AND updated_at<now()-interval '15 minutes'");
  const queued=await pool.query("SELECT id,filename FROM backup_records WHERE status='queued' AND next_attempt_at<=now() AND attempts<3 ORDER BY created_at LIMIT 5");
  for(const item of queued.rows)try{await backup(item);}catch(e){console.error('manual backup',e);}
  for(const w of await autosaveDue()){
    const actor={groupId:w.group_id,userId:'worker',messageId:uid(),requestId:uid(),keyId:'worker',permissions:['save']};
    try{await createSave(actor,w.id,'auto','自动存档');}catch(e){console.error('autosave',w.id,e);}
  }
  await pool.query("DELETE FROM idempotency WHERE created_at<now()-interval '30 days'");
  await pool.query('DELETE FROM admin_sessions WHERE expires_at<now()');
  await pool.query("DELETE FROM confirmations WHERE expires_at<now()");
  await pool.query("DELETE FROM saves WHERE deleted_at<now()-interval '7 days'");
  await pool.query("DELETE FROM worlds WHERE deleted_at<now()-interval '7 days'");
  await pool.query('DELETE FROM world_exports WHERE expires_at<now()');
  await pool.query('DELETE FROM world_imports WHERE expires_at<now()');
  const today=new Date().toISOString().slice(0,10);
  const old=await pool.query('SELECT 1 FROM backup_records WHERE filename=$1',[`dnd-${today}.dump`]);
  if(!old.rows.length)try{await backup();}catch(e){console.error('backup',e);}
  const settings=(await pool.query('SELECT daily_backup_retention,manual_backup_retention,backup_quota_bytes FROM server_settings WHERE id=true')).rows[0];
  const files=(await readdir(backupDir)).filter(x=>/^dnd-\d{4}-\d{2}-\d{2}\.dump$/.test(x)).sort().reverse();
  for(const file of files.slice(settings.daily_backup_retention))await unlink(join(backupDir,file));
  await pool.query("DELETE FROM backup_records WHERE status='complete' AND filename LIKE 'dnd-%' AND filename<>ALL($1::text[])",[files.slice(0,settings.daily_backup_retention)]);
  const manual=await pool.query("SELECT id,filename FROM backup_records WHERE status='complete' AND filename LIKE 'manual-%' ORDER BY created_at DESC OFFSET $1",[settings.manual_backup_retention]);
  for(const item of manual.rows){await unlink(join(backupDir,item.filename));await pool.query('DELETE FROM backup_records WHERE id=$1',[item.id]);}
  const retained=await pool.query("SELECT id,filename,size_bytes FROM backup_records WHERE status='complete' ORDER BY created_at DESC");
  let bytes=retained.rows.reduce((sum:number,item:any)=>sum+Number(item.size_bytes||0),0);
  for(let i=retained.rows.length-1;i>0&&bytes>Number(settings.backup_quota_bytes);i--){
    const item=retained.rows[i];await unlink(join(backupDir,item.filename));
    await pool.query('DELETE FROM backup_records WHERE id=$1',[item.id]);bytes-=Number(item.size_bytes||0);
  }
  if(bytes>Number(settings.backup_quota_bytes))console.error('最新备份超过备份容量配置');
}
let lastCleanup='';
async function runTick(){
  const db=await pool.connect();let locked=false;
  try{
    const r=await db.query("SELECT pg_try_advisory_lock(hashtextextended('dnd-worker',0)) AS locked");
    locked=r.rows[0].locked;if(!locked)return;
    await tick();
    const today=new Date().toISOString().slice(0,10);
    if(lastCleanup!==today){
      await pool.query("DELETE FROM audit_logs WHERE created_at<now()-interval '30 days'");
      await pool.query("DELETE FROM backup_records WHERE status='failed' AND created_at<now()-interval '30 days'");
      await pool.query(`DELETE FROM game_events WHERE id IN (
        SELECT e.id FROM (SELECT id,world_id,created_at,row_number() OVER(PARTITION BY world_id ORDER BY id DESC) AS rn FROM game_events) e
        JOIN worlds w ON w.id=e.world_id WHERE e.rn>10000 AND e.created_at<now()-interval '90 days' AND length(coalesce(w.state->>'summary',''))>0
      )`);
      await pool.query(`DELETE FROM dice_rolls d USING worlds w WHERE d.world_id=w.id
        AND d.created_at<now()-interval '90 days' AND length(coalesce(w.state->>'summary',''))>0
        AND (d.action_id IS NULL OR NOT EXISTS(SELECT 1 FROM actions a WHERE a.id=d.action_id AND a.status='pending'))`);
      await pool.query(`DELETE FROM actions a USING worlds w WHERE a.world_id=w.id AND a.status='resolved'
        AND a.created_at<now()-interval '90 days' AND length(coalesce(w.state->>'summary',''))>0`);
      lastCleanup=today;
    }
  }finally{if(locked)await db.query("SELECT pg_advisory_unlock(hashtextextended('dnd-worker',0))");db.release();}
}
await runTick();
setInterval(()=>{void runTick().catch(console.error);},60_000);
