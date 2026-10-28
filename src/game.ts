import { randomInt } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Actor } from './auth.js';
import { requirePermission } from './auth.js';
import { pool, tx, lockWorld, idempotent, uid, type Db } from './db.js';
import { xpForLevel,hitDieForClass,abilityModifier,proficiencyBonus,spellSlotsForClass } from './rules.js';

const fail = (message: string): never => { throw new Error(message); };
async function world(db: Db, actor: Actor, id: string) {
  const r = await db.query('SELECT * FROM worlds WHERE id=$1 AND group_id=$2 AND deleted_at IS NULL',[id,actor.groupId]);
  if (!r.rows.length) fail('世界不存在或不属于当前 QQ 群');
  return r.rows[0];
}
async function member(db: Db, actor: Actor, id: string) {
  const r = await db.query('SELECT * FROM members WHERE world_id=$1 AND user_id=$2 AND active',[id,actor.userId]);
  if (!r.rows.length) fail('你尚未加入该世界');
  return r.rows[0];
}
async function owner(db: Db, actor: Actor, id: string) {
  requirePermission(actor,'owner');
  const w = await world(db,actor,id);
  if (w.owner_id !== actor.userId) fail('此操作需要房主身份');
  return w;
}
export async function requestConfirmation(actor: Actor,id: string,kind:'world_delete'|'world_purge'|'save_delete'|'save_restore'|'save_purge'|'branch_delete',targetId?:string) {
  return tx(async db=>{if(kind==='world_purge'){
      requirePermission(actor,'owner');const r=await db.query("SELECT owner_id FROM worlds WHERE id=$1 AND group_id=$2 AND deleted_at>now()-interval '7 days'",[id,actor.groupId]);
      if(r.rows[0]?.owner_id!==actor.userId)fail('回收站中未找到可清理的房主世界');
    }else await owner(db,actor,id);
    if(kind==='branch_delete'){
      const r=await db.query('SELECT id FROM world_branches WHERE id=$1 AND world_id=$2 AND NOT active',[targetId,id]);if(!r.rows.length)fail('只能删除非活动分支');
    }else if(targetId){const r=await db.query('SELECT id,name,kind,deleted_at FROM saves WHERE id=$1 AND world_id=$2',[targetId,id]);if(!r.rows.length)fail('存档不存在');if(kind==='save_delete'&&(r.rows[0].kind!=='manual'||r.rows[0].deleted_at))fail('只能删除有效手动存档');if(kind==='save_restore'&&r.rows[0].deleted_at)fail('存档已删除');if(kind==='save_purge'&&!r.rows[0].deleted_at)fail('存档不在回收站');}
    const token=uid();await db.query("INSERT INTO confirmations(token,world_id,user_id,kind,target_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",[token,id,actor.userId,kind,targetId||null]);
    return {confirmationToken:token,expiresInSeconds:600,kind,targetId:targetId||id};
  });
}
async function consumeConfirmation(db:Db,actor:Actor,id:string,kind:string,targetId:string|null,token:string){
  const r=await db.query('DELETE FROM confirmations WHERE token=$1 AND world_id=$2 AND user_id=$3 AND kind=$4 AND target_id IS NOT DISTINCT FROM $5::uuid AND expires_at>now() RETURNING token',[token,id,actor.userId,kind,targetId]);
  if(!r.rows.length)fail('确认令牌无效或已过期');
}
async function event(db: Db, id: string, type: string, payload: unknown) {
  const r = await db.query('INSERT INTO game_events(world_id,type,payload) VALUES($1,$2,$3) RETURNING id',[id,type,JSON.stringify(payload)]);
  await db.query('UPDATE worlds SET version=version+1,important_actions=important_actions+1,updated_at=now() WHERE id=$1',[id]);
  return r.rows[0].id;
}
export async function createWorld(actor: Actor, name: string, settings: unknown) {
  requirePermission(actor,'world');
  const config=settings as Record<string,unknown>;
  if(config.rulesVersion&&config.rulesVersion!=='srd-5.1')fail('当前仅支持 SRD 5.1 规则');
  if(config.startingLevel!==undefined&&(!Number.isInteger(config.startingLevel)||Number(config.startingLevel)<1||Number(config.startingLevel)>20))fail('起始等级必须为 1–20');
  return tx(async db => idempotent(db,actor.groupId,actor.requestId,async () => {
    const id=uid();
    await db.query('INSERT INTO worlds(id,group_id,name,owner_id,settings,state) VALUES($1,$2,$3,$4,$5,$6)',
      [id,actor.groupId,name,actor.userId,JSON.stringify({...config,rulesVersion:'srd-5.1'}),JSON.stringify({chapter:1,scene:'',location:'',summary:''})]);
    await db.query("INSERT INTO members(world_id,user_id,role) VALUES($1,$2,'owner')",[id,actor.userId]);
    await db.query('INSERT INTO world_branches(id,world_id,name,active) VALUES($1,$2,$3,true)',[uid(),id,'主线']);
    await db.query('INSERT INTO group_active_worlds(group_id,world_id) VALUES($1,$2) ON CONFLICT(group_id) DO NOTHING',[actor.groupId,id]);
    return {worldId:id,name,groupId:actor.groupId,status:'setup'};
  }));
}
export async function listWorlds(actor: Actor,offset=0,limit=20) {
  requirePermission(actor,'read');
  const r=await pool.query('SELECT id,name,status,version,created_at FROM worlds WHERE group_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $2 OFFSET $3',[actor.groupId,Math.min(limit,50),offset]);
  return r.rows;
}
export async function getWorld(actor: Actor,id: string) {
  requirePermission(actor,'read');
  const w=await world(pool,actor,id);
  return {id:w.id,name:w.name,status:w.status,settings:w.settings,state:w.state,version:w.version};
}
export async function groupContext(actor: Actor) {
  const worlds=await listWorlds(actor);
  const r=await pool.query('SELECT world_id FROM group_active_worlds WHERE group_id=$1',[actor.groupId]);
  return {groupId:actor.groupId,activeWorldId:r.rows[0]?.world_id || null,worlds};
}
export async function selectWorld(actor: Actor,id: string) {
  return tx(async db=>{ await owner(db,actor,id); await db.query('INSERT INTO group_active_worlds(group_id,world_id) VALUES($1,$2) ON CONFLICT(group_id) DO UPDATE SET world_id=$2',[actor.groupId,id]); return {activeWorldId:id}; });
}
export async function joinWorld(actor: Actor,id: string) {
  requirePermission(actor,'game');
  return tx(async db=>{ await lockWorld(db,id); const w=await world(db,actor,id);
    const old=await db.query('SELECT * FROM members WHERE world_id=$1 AND user_id=$2',[id,actor.userId]);
    if (old.rows[0]?.active) return {joined:true,rejoined:true};
    const battle=await db.query('SELECT active FROM combats WHERE world_id=$1',[id]);if(battle.rows[0]?.active)fail('战斗进行中，暂不能加入世界');
    if(old.rows.length){await db.query('UPDATE members SET active=true WHERE world_id=$1 AND user_id=$2',[id,actor.userId]);await event(db,id,'member_rejoined',{userId:actor.userId});return {joined:true,rejoined:true};}
    const count=await db.query('SELECT count(*)::int AS n FROM members WHERE world_id=$1',[id]);
    if (count.rows[0].n>=8) fail('世界已满，最多 8 名玩家');
    if(w.status==='archived')fail('世界已归档，请房主先继续战役');
    await db.query('INSERT INTO members(world_id,user_id) VALUES($1,$2)',[id,actor.userId]);
    await event(db,id,'member_joined',{userId:actor.userId});
    return {joined:true,count:count.rows[0].n+1};
  });
}
export async function players(actor: Actor,id: string) {
  requirePermission(actor,'read'); await world(pool,actor,id);
  const r=await pool.query('SELECT m.user_id,m.ready,m.active,m.role,c.id AS character_id,c.name AS character_name FROM members m LEFT JOIN characters c ON c.world_id=m.world_id AND c.user_id=m.user_id WHERE m.world_id=$1 ORDER BY m.joined_at',[id]);
  return r.rows;
}
export async function leaveWorld(actor: Actor,id: string) {
  requirePermission(actor,'game');
  return tx(async db=>{await lockWorld(db,id);const w=await world(db,actor,id);await member(db,actor,id);
    if(w.owner_id===actor.userId)fail('房主需先转移房主身份');
    const battle=await db.query('SELECT active FROM combats WHERE world_id=$1',[id]);if(battle.rows[0]?.active)fail('战斗进行中，暂不能退出世界');
    await db.query('UPDATE members SET active=false,ready=false WHERE world_id=$1 AND user_id=$2',[id,actor.userId]);
    await event(db,id,'member_left',{userId:actor.userId});return {left:true};
  });
}
export async function transferOwner(actor: Actor,id: string,userId: string) {
  return tx(async db=>{await lockWorld(db,id);await owner(db,actor,id);
    const r=await db.query('SELECT 1 FROM members WHERE world_id=$1 AND user_id=$2 AND active',[id,userId]);if(!r.rows.length)fail('目标不是在线世界成员');
    await db.query('UPDATE worlds SET owner_id=$2 WHERE id=$1',[id,userId]);
    await db.query("UPDATE members SET role=CASE WHEN user_id=$2 THEN 'owner' ELSE 'player' END WHERE world_id=$1",[id,userId]);
    await event(db,id,'owner_transferred',{from:actor.userId,to:userId});return {ownerId:userId};
  });
}
export async function removePlayer(actor: Actor,id: string,userId: string) {
  return tx(async db=>{await lockWorld(db,id);await owner(db,actor,id);
    if(userId===actor.userId)fail('房主不能移除自己');
    const battle=await db.query('SELECT active FROM combats WHERE world_id=$1',[id]);if(battle.rows[0]?.active)fail('战斗进行中，暂不能移除成员');
    await db.query('DELETE FROM members WHERE world_id=$1 AND user_id=$2',[id,userId]);
    await event(db,id,'member_removed',{userId});return {removed:true};
  });
}
export async function updateWorld(actor: Actor,id: string,name: string,settings: Record<string,unknown>) {
  if(settings.rulesVersion&&settings.rulesVersion!=='srd-5.1')fail('当前仅支持 SRD 5.1 规则');
  if(settings.startingLevel!==undefined&&(!Number.isInteger(settings.startingLevel)||Number(settings.startingLevel)<1||Number(settings.startingLevel)>20))fail('起始等级必须为 1–20');
  return tx(async db=>{await lockWorld(db,id);await owner(db,actor,id);
    await db.query('UPDATE worlds SET name=$2,settings=$3 WHERE id=$1',[id,name,JSON.stringify({...settings,rulesVersion:'srd-5.1'})]);
    await event(db,id,'world_updated',{name});return {updated:true};
  });
}
export async function archiveWorld(actor: Actor,id: string) {
  return tx(async db=>{await owner(db,actor,id);await db.query("UPDATE worlds SET status='archived' WHERE id=$1",[id]);
    await event(db,id,'world_archived',{});return {archived:true};});
}
export async function resumeWorld(actor: Actor,id: string) {
  return tx(async db=>{await lockWorld(db,id);await owner(db,actor,id);
    const prior=await db.query("SELECT 1 FROM game_events WHERE world_id=$1 AND type='campaign_started' LIMIT 1",[id]);
    const r=await db.query("UPDATE worlds SET status=$2 WHERE id=$1 AND status='archived' RETURNING id",[id,prior.rows.length?'active':'setup']);
    if(!r.rows.length)fail('世界未归档');await event(db,id,'world_resumed',{});return {resumed:true};});
}
export async function deleteWorld(actor: Actor,id: string,confirmationToken: string) {
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);await owner(db,actor,id);
    await consumeConfirmation(db,actor,id,'world_delete',null,confirmationToken);
    const trash=await db.query('SELECT count(*)::int AS n FROM worlds WHERE group_id=$1 AND deleted_at IS NOT NULL',[actor.groupId]);if(trash.rows[0].n>=3)fail('当前 QQ 群世界回收站已满，请先恢复或等待过期清理');
    await db.query('UPDATE worlds SET deleted_at=now() WHERE id=$1',[id]);
    await db.query('DELETE FROM group_active_worlds WHERE world_id=$1',[id]);
    await db.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',[actor.userId,'world_deleted',JSON.stringify({worldId:id})]);
    return {deleted:true,recoverableDays:7};
  }));
}
export async function recoverWorld(actor: Actor,id: string) {
  requirePermission(actor,'owner');
  return tx(async db=>{await lockWorld(db,id);
    const r=await db.query("UPDATE worlds SET deleted_at=NULL WHERE id=$1 AND group_id=$2 AND owner_id=$3 AND deleted_at>now()-interval '7 days' RETURNING id",[id,actor.groupId,actor.userId]);
    if(!r.rows.length)fail('回收站中未找到可恢复的世界');return {recovered:true};
  });
}
export async function purgeWorld(actor:Actor,id:string,token:string){
  requirePermission(actor,'owner');
  return tx(async db=>{await lockWorld(db,id);
    const r=await db.query("SELECT owner_id FROM worlds WHERE id=$1 AND group_id=$2 AND deleted_at>now()-interval '7 days'",[id,actor.groupId]);
    if(r.rows[0]?.owner_id!==actor.userId)fail('回收站中未找到可清理的房主世界');
    await consumeConfirmation(db,actor,id,'world_purge',null,token);
    await db.query('DELETE FROM worlds WHERE id=$1',[id]);
    await db.query('INSERT INTO audit_logs(actor,action,detail) VALUES($1,$2,$3)',[actor.userId,'world_purged',JSON.stringify({worldId:id})]);
    return {purged:true,worldId:id};
  });
}
export async function deletedWorlds(actor: Actor) {
  requirePermission(actor,'read');
  const r=await pool.query("SELECT id,name,deleted_at FROM worlds WHERE group_id=$1 AND deleted_at>now()-interval '7 days' ORDER BY deleted_at DESC",[actor.groupId]);return r.rows;
}
export async function preference(actor: Actor,id: string,data: Record<string,unknown>) {
  requirePermission(actor,'game');
  return tx(async db=>{await world(db,actor,id);await member(db,actor,id);
    await db.query('UPDATE members SET preference=$3 WHERE world_id=$1 AND user_id=$2',[id,actor.userId,JSON.stringify(data)]);
    await event(db,id,'preference_submitted',{userId:actor.userId});return {saved:true};
  });
}
export async function sessionStatus(actor: Actor,id: string) {
  requirePermission(actor,'read');await world(pool,actor,id);
  const r=await pool.query('SELECT user_id,preference FROM members WHERE world_id=$1 ORDER BY joined_at',[id]);return r.rows;
}
export async function scene(actor: Actor,id: string) {const w=await getWorld(actor,id);return {state:w.state,version:w.version};}
export async function advanceScene(actor: Actor,id: string,changes: Record<string,unknown>) {
  requirePermission(actor,'dm');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);const w=await world(db,actor,id);
    const next={...w.state,...changes};await db.query('UPDATE worlds SET state=$2 WHERE id=$1',[id,JSON.stringify(next)]);
    await event(db,id,'scene_advanced',changes);
    if('chapter' in changes||changes.majorNode===true)await db.query('UPDATE worlds SET autosave_requested=true WHERE id=$1',[id]);
    return {state:next};
  }));
}
export async function getCharacter(actor: Actor,id: string,characterId: string) {
  requirePermission(actor,'read');await world(pool,actor,id);
  const r=await pool.query('SELECT id,user_id,name,sheet FROM characters WHERE world_id=$1 AND id=$2',[id,characterId]);
  if(!r.rows.length)fail('角色不存在');return r.rows[0];
}
export async function updateCharacter(actor: Actor,id: string,characterId: string,changes: Record<string,unknown>) {
  requirePermission(actor,'game');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);await world(db,actor,id);
    const r=await db.query('SELECT * FROM characters WHERE id=$1 AND world_id=$2 FOR UPDATE',[characterId,id]);
    if(!r.rows.length)fail('角色不存在');if(r.rows[0].user_id!==actor.userId)fail('只能修改自己的角色');
    const allowed=['personality','goal','background','notes'];
    if(Object.keys(changes).some(k=>!allowed.includes(k)))fail('数值、装备、等级和生命值只能由规则裁定更新');
    const sheet={...r.rows[0].sheet,...changes};await db.query('UPDATE characters SET sheet=$2 WHERE id=$1',[characterId,JSON.stringify(sheet)]);
    await event(db,id,'character_updated',{characterId,changes});return {characterId,sheet};
  }));
}
export async function awardExperience(actor:Actor,id:string,characterId:string,amount:number){
  requirePermission(actor,'dm');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);await world(db,actor,id);
    const r=await db.query('SELECT sheet FROM characters WHERE id=$1 AND world_id=$2 FOR UPDATE',[characterId,id]);if(!r.rows.length)fail('角色不存在');
    const sheet={...r.rows[0].sheet,experience:Number(r.rows[0].sheet.experience||0)+amount};
    await db.query('UPDATE characters SET sheet=$2 WHERE id=$1',[characterId,JSON.stringify(sheet)]);
    await event(db,id,'experience_awarded',{characterId,amount,total:sheet.experience});return {characterId,experience:sheet.experience};
  }));
}
export async function grantItem(actor:Actor,id:string,characterId:string,item:'healing_potion',quantity:number){
  requirePermission(actor,'dm');
  if(item!=='healing_potion'||!Number.isInteger(quantity)||quantity<1||quantity>10)fail('道具或数量无效');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);await world(db,actor,id);
    const r=await db.query('SELECT sheet FROM characters WHERE id=$1 AND world_id=$2 FOR UPDATE',[characterId,id]);if(!r.rows.length)fail('角色不存在');
    const sheet=r.rows[0].sheet,equipment=[...(sheet.equipment||[])];
    const index=equipment.findIndex((x:any)=>x.name==='治疗药水');
    if(index<0)equipment.push({name:'治疗药水',quantity});
    else{if(equipment[index].quantity+quantity>100)fail('治疗药水数量超过上限');equipment[index]={...equipment[index],quantity:equipment[index].quantity+quantity};}
    await db.query('UPDATE characters SET sheet=$2 WHERE id=$1',[characterId,JSON.stringify({...sheet,equipment})]);
    await event(db,id,'item_granted',{characterId,item,quantity});return {characterId,item,quantity};
  }));
}
export async function levelUpCharacter(actor:Actor,id:string,characterId:string){
  requirePermission(actor,'game');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);await world(db,actor,id);
    const r=await db.query('SELECT user_id,sheet FROM characters WHERE id=$1 AND world_id=$2 FOR UPDATE',[characterId,id]);if(!r.rows.length)fail('角色不存在');
    if(r.rows[0].user_id!==actor.userId)fail('只能升级自己的角色');
    const sheet=r.rows[0].sheet,level=Number(sheet.level);
    if(level>=20)fail('角色已达最高等级');
    if(Number(sheet.experience||0)<xpForLevel[level])fail(`经验值不足，升至 ${level+1} 级需要 ${xpForLevel[level]} XP`);
    const die=hitDieForClass(String(sheet.class));if(!die)throw new Error('职业未包含在 SRD 5.1 升级规则中');
    const constitution=Number(sheet.abilities?.constitution??sheet.abilities?.['体质']??10);
    const gained=Math.max(1,Math.floor(die/2)+1+abilityModifier(constitution));
    const oldSlots=spellSlotsForClass(String(sheet.class),level),newSlots=spellSlotsForClass(String(sheet.class),level+1);
    const spellSlots=Object.fromEntries(Object.entries(newSlots).map(([slot,max])=>[slot,Math.min(max,Number(sheet.spellSlots?.[slot]??oldSlots[slot]??0)+max-(oldSlots[slot]||0))]));
    const next={...sheet,level:level+1,hpMax:Number(sheet.hpMax)+gained,hp:Number(sheet.hp)+gained,spellSlots,proficiencyBonus:proficiencyBonus(level+1)};
    await db.query('UPDATE characters SET sheet=$2 WHERE id=$1',[characterId,JSON.stringify(next)]);
    await event(db,id,'character_leveled',{characterId,level:next.level,hpGained:gained});return {characterId,sheet:next,hpGained:gained};
  }));
}
export async function ready(actor: Actor,id: string,value: boolean) {
  requirePermission(actor,'game');
  return tx(async db=>{await lockWorld(db,id);await world(db,actor,id); await member(db,actor,id);
    if(value){const c=await db.query('SELECT id FROM characters WHERE world_id=$1 AND user_id=$2',[id,actor.userId]);if(!c.rows.length) fail('请先创建角色');}
    await db.query('UPDATE members SET ready=$3 WHERE world_id=$1 AND user_id=$2',[id,actor.userId,value]);
    await event(db,id,'player_ready',{userId:actor.userId,ready:value});return {ready:value};
  });
}
export async function startCampaign(actor: Actor,id: string) {
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);const w=await owner(db,actor,id);
    if(w.status!=='setup') fail('世界不是建团状态');
    const r=await db.query('SELECT count(*)::int AS total,count(*) FILTER (WHERE ready AND active)::int AS ready FROM members WHERE world_id=$1',[id]);
    if(r.rows[0].total<2||r.rows[0].total>8||r.rows[0].ready!==r.rows[0].total) fail('开团需要 2–8 名成员且所有成员已创建角色并准备');
    await db.query("UPDATE worlds SET status='active' WHERE id=$1",[id]);await event(db,id,'campaign_started',{});
    return {started:true,players:r.rows[0].total};
  }));
}
export async function createCharacter(actor: Actor,id: string,sheet: any) {
  requirePermission(actor,'game');
  return tx(async db=>{await lockWorld(db,id);const w=await world(db,actor,id);await member(db,actor,id);
    const existing=await db.query('SELECT id FROM characters WHERE world_id=$1 AND user_id=$2',[id,actor.userId]);
    if(existing.rows.length) fail('每位玩家只能拥有一名主角色');
    const charId=uid();const hp=Number(sheet.hpMax);
    if(!Number.isInteger(hp)||hp<1||hp>500) fail('生命值无效');
    const level=Number(sheet.level||1);if(!Number.isInteger(level)||level<1||level>20) fail('等级无效');
    if(level!==Number(w.settings.startingLevel||1))fail('角色等级与世界起始等级不符');
    const die=hitDieForClass(String(sheet.class));if(die===null)throw new Error('职业不在 SRD 5.1 支持列表中');
    const abilities={strength:10,dexterity:10,constitution:10,intelligence:10,wisdom:10,charisma:10,...sheet.abilities};
    if(Object.values(abilities).some(score=>!Number.isInteger(score)||Number(score)<1||Number(score)>30))fail('属性值无效');
    if(hp>Math.max(1,die+abilityModifier(Number(abilities.constitution))+3)*level)fail('初始生命值超出职业与体质的可用范围');
    const abilityModifiers=Object.fromEntries(Object.entries(abilities).map(([key,score])=>[key,abilityModifier(Number(score))]));
    const money={cp:0,sp:0,ep:0,gp:0,pp:0,...sheet.money};
    if(Object.values(money).some(amount=>!Number.isInteger(amount)||Number(amount)<0||Number(amount)>1000000))fail('金钱数值无效');
    const maximumSlots=spellSlotsForClass(String(sheet.class),level);
    const spellSlots={...maximumSlots,...sheet.spellSlots};
    if(Object.entries(spellSlots).some(([slot,count])=>!Object.hasOwn(maximumSlots,slot)||!Number.isInteger(count)||Number(count)<0||Number(count)>maximumSlots[slot]))fail('法术位超出职业等级上限');
    const data={subclass:'',skills:[],equipment:[],spells:[],classFeatures:[],alignment:'',conditions:[],...sheet,abilities,abilityModifiers,money,spellSlots,level,hpMax:hp,hp:hp,tempHp:0,deathSaves:{successes:0,failures:0,stable:false,dead:false},experience:0,proficiencyBonus:proficiencyBonus(level)};
    await db.query('INSERT INTO characters(id,world_id,user_id,name,sheet) VALUES($1,$2,$3,$4,$5)',[charId,id,actor.userId,String(sheet.name),JSON.stringify(data)]);
    await event(db,id,'character_created',{characterId:charId,userId:actor.userId});
    return {characterId:charId,sheet:data};
  });
}
export async function finishLongRest(actor:Actor,id:string){
  requirePermission(actor,'dm');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);const w=await world(db,actor,id);
    if(w.status!=='active')fail('战役尚未开始');
    const combat=await db.query('SELECT active FROM combats WHERE world_id=$1',[id]);if(combat.rows[0]?.active)fail('战斗进行中不能完成长休');
    const characters=await db.query('SELECT c.id,c.sheet FROM characters c JOIN members m ON m.world_id=c.world_id AND m.user_id=c.user_id WHERE c.world_id=$1 AND m.active',[id]);
    let rested=0;
    for(const c of characters.rows){const sheet=c.sheet;
      if(sheet.hp<=0||sheet.deathSaves?.dead)continue;
      const next={...sheet,hp:sheet.hpMax,tempHp:0,spellSlots:spellSlotsForClass(String(sheet.class),Number(sheet.level)),deathSaves:{successes:0,failures:0,stable:false,dead:false}};
      await db.query('UPDATE characters SET sheet=$2 WHERE id=$1',[c.id,JSON.stringify(next)]);
      rested++;
    }
    await event(db,id,'long_rest_completed',{characters:rested});
    return {rested:true,characters:rested};
  }));
}
export async function characters(actor: Actor,id: string) {
  requirePermission(actor,'read');await world(pool,actor,id);
  const r=await pool.query('SELECT id,user_id,name,sheet FROM characters WHERE world_id=$1 ORDER BY name',[id]);return r.rows;
}
export async function submitAction(actor: Actor,id: string,text: string) {
  requirePermission(actor,'game');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await world(db,actor,id);await member(db,actor,id);
    const c=await db.query('SELECT id FROM characters WHERE world_id=$1 AND user_id=$2',[id,actor.userId]);if(!c.rows.length) fail('尚未创建角色');
    const old=await db.query('SELECT id,status FROM actions WHERE world_id=$1 AND message_id=$2',[id,actor.messageId]);
    if(old.rows.length)return {actionId:old.rows[0].id,status:old.rows[0].status};
    const actionId=uid();await db.query('INSERT INTO actions(id,world_id,user_id,character_id,message_id,message_time,text) VALUES($1,$2,$3,$4,$5,$6,$7)',[actionId,id,actor.userId,c.rows[0].id,actor.messageId,actor.messageTime||null,text]);
    await event(db,id,'action_submitted',{actionId,userId:actor.userId,text});return {actionId,status:'pending'};
  }));
}
export async function adjudicateAction(actor:Actor,id:string,actionId:string,ability:string,dc:number){
  requirePermission(actor,'dm');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await world(db,actor,id);
    const r=await db.query('SELECT a.status,a.character_id,c.sheet FROM actions a JOIN characters c ON c.id=a.character_id WHERE a.id=$1 AND a.world_id=$2',[actionId,id]);
    if(!r.rows.length||r.rows[0].status!=='pending')fail('待裁定行动不存在');
    const score=Number(r.rows[0].sheet.abilities?.[ability]||10);
    const modifier=abilityModifier(score);const raw=randomInt(1,21),total=raw+modifier,success=raw===20||raw!==1&&total>=dc;
    const rollId=uid();
    await db.query('INSERT INTO dice_rolls(id,world_id,action_id,character_id,expression,raw,modifier,total) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[rollId,id,actionId,r.rows[0].character_id,'1d20',JSON.stringify([raw]),modifier,total]);
    await event(db,id,'action_check',{actionId,rollId,ability,dc,raw,modifier,total,success});
    return {actionId,rollId,ability,dc,raw,modifier,total,success};
  }));
}
export async function resolveAction(actor: Actor,id: string,actionId: string,result: string,changes: Record<string,unknown>) {
  requirePermission(actor,'dm');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);const w=await world(db,actor,id);
    const a=await db.query('SELECT * FROM actions WHERE id=$1 AND world_id=$2 FOR UPDATE',[actionId,id]);if(!a.rows.length) fail('行动不存在');
    if(a.rows[0].status==='resolved') return a.rows[0].resolution;
    const next={...w.state,...changes};
    await db.query('UPDATE worlds SET state=$2 WHERE id=$1',[id,JSON.stringify(next)]);
    const resolution={actionId,result,state:next};
    await db.query("UPDATE actions SET status='resolved',resolution=$2 WHERE id=$1",[actionId,JSON.stringify(resolution)]);
    await event(db,id,'action_resolved',{actionId,result,changes});return resolution;
  }));
}
export async function recentEvents(actor: Actor,id: string,after=0,limit=20) {
  requirePermission(actor,'read');await world(pool,actor,id);
  const r=await pool.query('SELECT id,type,payload,created_at FROM game_events WHERE world_id=$1 AND id>$2 ORDER BY id LIMIT $3',[id,after,Math.min(limit,50)]);return r.rows;
}
export async function rollDice(actor: Actor,id: string,expression: string,advantage='none',actionId?:string) {
  requirePermission(actor,'game');
  const m=/^(\d{1,2})d(4|6|8|10|12|20|100)([+-]\d{1,3})?$/.exec(expression);
  if(!m||Number(m[1])>20) throw new Error('骰子表达式无效');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await world(db,actor,id);await member(db,actor,id);
    const character=await db.query('SELECT id FROM characters WHERE world_id=$1 AND user_id=$2',[id,actor.userId]);
    if(!character.rows.length)fail('尚未创建角色');
    if(actionId){const a=await db.query('SELECT id FROM actions WHERE id=$1 AND world_id=$2 AND user_id=$3',[actionId,id,actor.userId]);if(!a.rows.length)fail('行动不存在或不属于你');}
    const count=Number(m[1]),sides=Number(m[2]),modifier=Number(m[3]||0);
    if(advantage!=='none'&&(count!==1||sides!==20)) fail('优势/劣势仅适用于 1d20');
    const raw=Array.from({length:advantage==='none'?count:2},()=>randomInt(1,sides+1));
    const total=(advantage==='advantage'?Math.max(...raw):advantage==='disadvantage'?Math.min(...raw):raw.reduce((a,b)=>a+b,0))+modifier;
    const rollId=uid();
    await db.query('INSERT INTO dice_rolls(id,world_id,action_id,character_id,expression,raw,modifier,total) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[rollId,id,actionId||null,character.rows[0].id,expression,JSON.stringify(raw),modifier,total]);
    await event(db,id,'dice_rolled',{rollId,actionId:actionId||null,characterId:character.rows[0].id,expression,raw,total});return {rollId,actionId:actionId||null,characterId:character.rows[0].id,expression,raw,modifier,total};
  }));
}
export async function snapshot(db: Db,id: string) {
  const w=await db.query('SELECT name,owner_id,settings,state,status,version FROM worlds WHERE id=$1',[id]);
  const m=await db.query('SELECT user_id,ready,active,role,preference FROM members WHERE world_id=$1',[id]);
  const c=await db.query('SELECT id,user_id,name,sheet FROM characters WHERE world_id=$1',[id]);
  const s=await db.query('SELECT public,private FROM story WHERE world_id=$1',[id]);
  const n=await db.query('SELECT id,name,visibility,data FROM npcs WHERE world_id=$1',[id]);
  const q=await db.query('SELECT id,name,visibility,data FROM quests WHERE world_id=$1',[id]);
  const combat=await db.query('SELECT state,active FROM combats WHERE world_id=$1',[id]);
  return {world:w.rows[0],members:m.rows,characters:c.rows,story:s.rows[0]||null,npcs:n.rows,quests:q.rows,combat:combat.rows[0]||null};
}
export async function createSave(actor: Actor,id: string,kind:'auto'|'manual',name: string,note='') {
  requirePermission(actor,'save');
  for(let attempt=0;attempt<3;attempt++)try{
    return await tx(async db=>{await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');return idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);const w=await world(db,actor,id);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('global-saves',0))");
    const settings=(await db.query('SELECT * FROM server_settings WHERE id=true')).rows[0];
    if(kind==='manual') {await member(db,actor,id);const count=await db.query("SELECT count(*)::int AS n FROM saves WHERE world_id=$1 AND kind='manual' AND deleted_at IS NULL",[id]);if(count.rows[0].n>=settings.manual_save_limit) fail(`手动存档已达 ${settings.manual_save_limit} 个，请先删除一个`);}
    const data=await snapshot(db,id);const compressed=gzipSync(JSON.stringify(data));
    JSON.parse(gunzipSync(compressed).toString());
    const used=await db.query("SELECT coalesce(sum(size_bytes),0)::bigint AS bytes FROM saves WHERE world_id=$1 AND deleted_at IS NULL AND (kind='manual' OR kind='auto' AND ($2='manual' OR version IN (SELECT version FROM saves WHERE world_id=$1 AND kind='auto' ORDER BY version DESC LIMIT 2)))",[id,kind]);
    const branchUsed=await db.query('SELECT coalesce(sum(size_bytes),0)::bigint AS bytes FROM world_branches WHERE world_id=$1',[id]);
    if(Number(used.rows[0].bytes)+Number(branchUsed.rows[0].bytes)+compressed.length>Number(settings.world_quota_bytes)) fail('世界存档容量超过配额');
    const total=await db.query(`SELECT coalesce(sum(size_bytes),0)::bigint AS bytes FROM saves WHERE deleted_at IS NULL AND (world_id<>$1 OR $2='manual' OR kind='manual' OR version IN (SELECT version FROM saves WHERE world_id=$1 AND kind='auto' ORDER BY version DESC LIMIT 2))`,[id,kind]);
    const allBranches=await db.query('SELECT coalesce(sum(size_bytes),0)::bigint AS bytes FROM world_branches');
    if(Number(total.rows[0].bytes)+Number(allBranches.rows[0].bytes)+compressed.length>Number(settings.server_quota_bytes))fail('服务器存档容量超过配额');
    const version=kind==='auto'?w.save_sequence+1:Number((await db.query("SELECT nextval('manual_save_version_seq') AS n")).rows[0].n);const saveId=uid();
    await db.query('INSERT INTO saves(id,world_id,kind,version,name,note,snapshot,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[saveId,id,kind,version,name,note,compressed,compressed.length]);
    if(kind==='auto') {
      await db.query('UPDATE worlds SET save_sequence=$2,last_autosave_at=now(),important_actions=0,autosave_requested=false WHERE id=$1',[id,version]);
      await db.query(`DELETE FROM saves WHERE id IN (SELECT id FROM saves WHERE world_id=$1 AND kind='auto' ORDER BY version DESC OFFSET 3)`,[id]);
    }
    return {saveId,kind,version,sizeBytes:compressed.length};
    });});
  }catch(error){if((error as {code?:string}).code!=='40001'||attempt===2)throw error;}
  throw new Error('存档事务重试失败');
}
export async function listSaves(actor: Actor,id: string) {
  requirePermission(actor,'read');await world(pool,actor,id);
  const r=await pool.query('SELECT id,kind,version,name,note,size_bytes,created_at,deleted_at FROM saves WHERE world_id=$1 ORDER BY created_at DESC',[id]);return r.rows;
}
export async function autosaveStatus(actor:Actor,id:string){
  requirePermission(actor,'read');const w=await world(pool,actor,id);
  const r=await pool.query("SELECT id,version,name,size_bytes,created_at FROM saves WHERE world_id=$1 AND kind='auto' ORDER BY version DESC",[id]);
  return {worldId:id,lastAutosaveAt:w.last_autosave_at,slots:r.rows,maxSlots:3};
}
export async function deleteSave(actor: Actor,id: string,saveId: string,confirmationToken: string) {
  return tx(async db=>{await lockWorld(db,id);await owner(db,actor,id);
    await consumeConfirmation(db,actor,id,'save_delete',saveId,confirmationToken);
    const settings=(await db.query('SELECT recycle_save_limit,recycle_quota_bytes FROM server_settings WHERE id=true')).rows[0];
    const trash=await db.query('SELECT count(*)::int AS n,coalesce(sum(size_bytes),0)::bigint AS bytes FROM saves WHERE world_id=$1 AND deleted_at IS NOT NULL',[id]);
    const selected=await db.query("SELECT size_bytes FROM saves WHERE id=$1 AND world_id=$2 AND kind='manual' AND deleted_at IS NULL",[saveId,id]);
    if(!selected.rows.length)fail('只能删除有效手动存档');
    if(trash.rows[0].n>=settings.recycle_save_limit||Number(trash.rows[0].bytes)+selected.rows[0].size_bytes>Number(settings.recycle_quota_bytes))fail('存档回收站已满，请先清理');
    const r=await db.query("UPDATE saves SET deleted_at=now() WHERE id=$1 AND world_id=$2 AND kind='manual' AND deleted_at IS NULL RETURNING id",[saveId,id]);
    if(!r.rows.length)fail('只能删除有效手动存档');return {deleted:true};
  });
}
export async function previewCleanup(actor:Actor,id:string){
  requirePermission(actor,'read');await world(pool,actor,id);
  const r=await pool.query('SELECT id,name,kind,size_bytes,deleted_at FROM saves WHERE world_id=$1 AND deleted_at IS NOT NULL ORDER BY deleted_at',[id]);
  return {deletedSaves:r.rows,totalBytes:r.rows.reduce((sum:number,x:any)=>sum+Number(x.size_bytes),0)};
}
export async function cleanupSave(actor:Actor,id:string,saveId:string,token:string){
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);await owner(db,actor,id);
    await consumeConfirmation(db,actor,id,'save_purge',saveId,token);
    const r=await db.query('DELETE FROM saves WHERE id=$1 AND world_id=$2 AND deleted_at IS NOT NULL RETURNING id',[saveId,id]);
    if(!r.rows.length)fail('存档不在回收站');return {purged:true,saveId};
  }));
}
export async function recoverSave(actor: Actor,id: string,saveId: string) {
  return tx(async db=>{await owner(db,actor,id);await lockWorld(db,id);
    const settings=(await db.query('SELECT manual_save_limit FROM server_settings WHERE id=true')).rows[0];
    const count=await db.query("SELECT count(*)::int AS n FROM saves WHERE world_id=$1 AND kind='manual' AND deleted_at IS NULL",[id]);
    if(count.rows[0].n>=settings.manual_save_limit)fail('手动存档已满');
    const r=await db.query("UPDATE saves SET deleted_at=NULL WHERE id=$1 AND world_id=$2 AND kind='manual' AND deleted_at>now()-interval '7 days' RETURNING id",[saveId,id]);
    if(!r.rows.length)fail('回收站中未找到此存档');return {recovered:true};
  });
}
export async function storageStatus(actor: Actor,id: string) {
  requirePermission(actor,'read');await world(pool,actor,id);
  const [r,s,b,t,total,backups]=await Promise.all([
    pool.query('SELECT kind,count(*)::int AS count,coalesce(sum(size_bytes),0)::bigint AS bytes FROM saves WHERE world_id=$1 AND deleted_at IS NULL GROUP BY kind',[id]),
    pool.query('SELECT world_quota_bytes,server_quota_bytes,manual_save_limit,recycle_save_limit,recycle_quota_bytes,backup_quota_bytes FROM server_settings WHERE id=true'),
    pool.query('SELECT count(*)::int AS count,coalesce(sum(size_bytes),0)::bigint AS bytes FROM world_branches WHERE world_id=$1',[id]),
    pool.query('SELECT count(*)::int AS count,coalesce(sum(size_bytes),0)::bigint AS bytes FROM saves WHERE world_id=$1 AND deleted_at IS NOT NULL',[id]),
    pool.query('SELECT coalesce(sum(size_bytes),0)::bigint AS bytes FROM saves WHERE deleted_at IS NULL'),
    pool.query("SELECT coalesce(sum(size_bytes),0)::bigint AS bytes FROM backup_records WHERE status='complete'")]);
  return {worldId:id,quotaBytes:s.rows[0].world_quota_bytes,serverQuotaBytes:s.rows[0].server_quota_bytes,serverSaveBytes:total.rows[0].bytes,manualSaveLimit:s.rows[0].manual_save_limit,saves:r.rows,branches:b.rows[0],recycle:{...t.rows[0],limit:s.rows[0].recycle_save_limit,quotaBytes:s.rows[0].recycle_quota_bytes},backup:{bytes:backups.rows[0].bytes,quotaBytes:s.rows[0].backup_quota_bytes}};
}
export async function backupStatus(actor: Actor) {
  requirePermission(actor,'read');
  const r=await pool.query("SELECT status,created_at FROM backup_records ORDER BY created_at DESC LIMIT 1");
  return r.rows[0]||{status:'none'};
}
export async function restoreSave(actor: Actor,id: string,saveId: string,confirmationToken: string) {
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);await owner(db,actor,id);
    await consumeConfirmation(db,actor,id,'save_restore',saveId,confirmationToken);
    const r=await db.query('SELECT snapshot FROM saves WHERE id=$1 AND world_id=$2 AND deleted_at IS NULL',[saveId,id]);if(!r.rows.length) fail('存档不存在');
    const data=JSON.parse(gunzipSync(r.rows[0].snapshot).toString());
    await applySnapshot(db,id,data);
    await event(db,id,'save_restored',{saveId});return {restored:true,saveId};
  }));
}
export async function applySnapshot(db:Db,id:string,data:any){
  await db.query('UPDATE worlds SET name=$2,owner_id=$3,settings=$4,state=$5,status=$6,version=version+1,updated_at=now() WHERE id=$1',[id,data.world.name,data.world.owner_id,data.world.settings,data.world.state,data.world.status]);
  await db.query("DELETE FROM actions WHERE world_id=$1 AND status='pending'",[id]);
  await db.query('DELETE FROM characters WHERE world_id=$1',[id]);await db.query('DELETE FROM members WHERE world_id=$1',[id]);
  for(const m of data.members)await db.query('INSERT INTO members(world_id,user_id,ready,active,role,preference) VALUES($1,$2,$3,$4,$5,$6)',[id,m.user_id,m.ready,m.active,m.role,m.preference]);
  for(const c of data.characters)await db.query('INSERT INTO characters(id,world_id,user_id,name,sheet) VALUES($1,$2,$3,$4,$5)',[c.id,id,c.user_id,c.name,c.sheet]);
  await db.query('DELETE FROM story WHERE world_id=$1',[id]);if(data.story)await db.query('INSERT INTO story(world_id,public,private) VALUES($1,$2,$3)',[id,data.story.public,data.story.private]);
  await db.query('DELETE FROM npcs WHERE world_id=$1',[id]);for(const n of data.npcs||[])await db.query('INSERT INTO npcs(id,world_id,name,visibility,data) VALUES($1,$2,$3,$4,$5)',[n.id,id,n.name,n.visibility,n.data]);
  await db.query('DELETE FROM quests WHERE world_id=$1',[id]);for(const q of data.quests||[])await db.query('INSERT INTO quests(id,world_id,name,visibility,data) VALUES($1,$2,$3,$4,$5)',[q.id,id,q.name,q.visibility,q.data]);
  await db.query('DELETE FROM combats WHERE world_id=$1',[id]);if(data.combat)await db.query('INSERT INTO combats(world_id,state,active) VALUES($1,$2,$3)',[id,data.combat.state,data.combat.active]);
}
export async function saveStory(actor: Actor,id: string,publicData: unknown,privateData: unknown) {
  requirePermission(actor,'dm');
  return tx(async db=>{await world(db,actor,id);await db.query('INSERT INTO story(world_id,public,private) VALUES($1,$2,$3) ON CONFLICT(world_id) DO UPDATE SET public=$2,private=$3',[id,JSON.stringify(publicData),JSON.stringify(privateData)]);await event(db,id,'story_updated',{});return {saved:true};});
}
export async function storyContext(actor: Actor,id: string,privateView: boolean,offset=0,limit=20) {
  requirePermission(actor,privateView?'dm':'read');await world(pool,actor,id);
  const [r,n,q]=await Promise.all([
    pool.query('SELECT public,private FROM story WHERE world_id=$1',[id]),
    pool.query('SELECT id,name,visibility,data FROM npcs WHERE world_id=$1 AND ($2 OR visibility=$3) ORDER BY name LIMIT $4 OFFSET $5',[id,privateView,'public',Math.min(limit,50),offset]),
    pool.query('SELECT id,name,visibility,data FROM quests WHERE world_id=$1 AND ($2 OR visibility=$3) ORDER BY name LIMIT $4 OFFSET $5',[id,privateView,'public',Math.min(limit,50),offset])]);
  return privateView?{story:r.rows[0]||{},npcs:n.rows,quests:q.rows}:{public:r.rows[0]?.public||{},npcs:n.rows,quests:q.rows};
}
export async function manageEntity(actor: Actor,id: string,kind:'npcs'|'quests',name: string,visibility:'public'|'private',data: Record<string,unknown>,entityId?:string) {
  requirePermission(actor,'dm');
  return tx(async db=>{await world(db,actor,id);const itemId=entityId||uid();
    const old=await db.query(`SELECT id FROM ${kind} WHERE id=$1 AND world_id=$2`,[itemId,id]);
    if(entityId&&!old.rows.length)fail('目标不存在');
    await db.query(`INSERT INTO ${kind}(id,world_id,name,visibility,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET name=$3,visibility=$4,data=$5`,[itemId,id,name,visibility,JSON.stringify(data)]);
    await event(db,id,kind==='npcs'?'npc_updated':'quest_updated',{id:itemId,name});return {id:itemId,name,visibility,data};
  });
}
export async function endingContext(actor: Actor,id: string) {
  requirePermission(actor,'dm');
  const [w,s,e]=await Promise.all([getWorld(actor,id),storyContext(actor,id,true,0,50),pool.query('SELECT id,type,payload,created_at FROM game_events WHERE world_id=$1 ORDER BY id DESC LIMIT 50',[id])]);
  return {world:w,story:s,recentEvents:e.rows.reverse()};
}
export async function pendingActions(actor: Actor,id: string) {
  requirePermission(actor,'dm');await world(pool,actor,id);
  const r=await pool.query("SELECT id,user_id,character_id,text,created_at FROM actions WHERE world_id=$1 AND status='pending' ORDER BY created_at LIMIT 30",[id]);return r.rows;
}
export async function autosaveDue() {
  const r=await pool.query(`SELECT id,group_id FROM worlds WHERE deleted_at IS NULL AND version>0 AND (autosave_requested OR important_actions>=5 OR (important_actions>0 AND (last_autosave_at IS NULL OR last_autosave_at<now()-interval '5 minutes'))) LIMIT 20`);
  return r.rows;
}
