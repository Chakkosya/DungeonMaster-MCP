import { randomInt } from 'node:crypto';
import type { Actor } from './auth.js';
import { requirePermission } from './auth.js';
import { pool, tx, lockWorld, idempotent, uid } from './db.js';
import { abilityModifier, proficiencyBonus, spellcastingAbility } from './rules.js';

async function checkWorld(db: any, actor: Actor, id: string) {
  const r=await db.query('SELECT id,status FROM worlds WHERE id=$1 AND group_id=$2 AND deleted_at IS NULL',[id,actor.groupId]);
  if(!r.rows.length) throw new Error('世界不存在或无权访问');
  return r.rows[0];
}
async function applyDamage(db:any,worldId:string,target:any,damage:number,critical=false){
  if(damage<=0)return;
  if(target.kind==='enemy'){target.hp=Math.max(0,target.hp-damage);return;}
  const before=target.hp,absorbed=Math.min(target.tempHp||0,damage),remaining=damage-absorbed;
  target.tempHp=(target.tempHp||0)-absorbed;
  target.hp=Math.max(0,before-remaining);
  const death=target.deathSaves||{successes:0,failures:0,stable:false,dead:false};
  if(before===0&&!death.dead){death.stable=false;if(remaining>=target.hpMax)death.dead=true;else death.failures+=critical?2:1;}
  else if(before>0&&remaining-before>=target.hpMax)death.dead=true;
  if(death.failures>=3)death.dead=true;
  target.deathSaves=death;
  const c=await db.query('SELECT sheet FROM characters WHERE id=$1 AND world_id=$2',[target.id,worldId]);
  await db.query('UPDATE characters SET sheet=$2 WHERE id=$1',[target.id,JSON.stringify({...c.rows[0].sheet,hp:target.hp,tempHp:target.tempHp,deathSaves:death})]);
}
export async function startCombat(actor: Actor,id: string,enemies: {name:string;hp:number;ac:number;initiativeBonus:number}[]) {
  requirePermission(actor,'dm');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);const w=await checkWorld(db,actor,id);
    if(w.status!=='active')throw new Error('战役尚未开始');
    const old=await db.query('SELECT active FROM combats WHERE world_id=$1',[id]);if(old.rows[0]?.active) throw new Error('战斗已经开始');
    const chars=await db.query('SELECT c.id,c.name,c.sheet FROM characters c JOIN members m ON m.world_id=c.world_id AND m.user_id=c.user_id WHERE c.world_id=$1 AND m.active',[id]);
    const order=[...chars.rows.map(c=>{const raw=randomInt(1,21);return {id:c.id,name:c.name,kind:'player',hp:c.sheet.hp,hpMax:c.sheet.hpMax,tempHp:c.sheet.tempHp||0,deathSaves:c.sheet.deathSaves||{successes:0,failures:0,stable:false,dead:false},ac:c.sheet.ac||10,speed:c.sheet.speed||30,attackBonus:c.sheet.attackBonus||0,initiativeRoll:raw,initiative:raw+(c.sheet.initiativeBonus||0)};}),
      ...enemies.map((e,i)=>{const raw=randomInt(1,21);return {id:`enemy-${i}`,name:e.name,kind:'enemy',hp:e.hp,ac:e.ac,initiativeRoll:raw,initiative:raw+e.initiativeBonus};})]
      .sort((a,b)=>b.initiative-a.initiative);
    for(const combatant of order)await db.query('INSERT INTO dice_rolls(id,world_id,character_id,expression,raw,modifier,total) VALUES($1,$2,$3,$4,$5,$6,$7)',[uid(),id,combatant.kind==='player'?combatant.id:null,'1d20',JSON.stringify([combatant.initiativeRoll]),combatant.initiative-combatant.initiativeRoll,combatant.initiative]);
    const state={order,index:0,round:1,usedAction:false,usedBonus:false,deathSaveRolled:false,movement:0};
    await db.query('INSERT INTO combats(world_id,state,active) VALUES($1,$2,true) ON CONFLICT(world_id) DO UPDATE SET state=$2,active=true',[id,JSON.stringify(state)]);
    await db.query("INSERT INTO game_events(world_id,type,payload) VALUES($1,'combat_started',$2)",[id,JSON.stringify({order})]);
    await db.query('UPDATE worlds SET version=version+1,important_actions=important_actions+1 WHERE id=$1',[id]);
    return state;
  }));
}
export async function combatState(actor: Actor,id: string) {
  requirePermission(actor,'read');await checkWorld(pool,actor,id);
  const r=await pool.query('SELECT state,active FROM combats WHERE world_id=$1',[id]);return r.rows[0]||{active:false};
}
export async function combatAction(actor: Actor,id: string,kind: 'attack'|'move',targetId: string,amount=0) {
  requirePermission(actor,'game');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);await checkWorld(db,actor,id);
    const r=await db.query('SELECT state FROM combats WHERE world_id=$1 AND active=true FOR UPDATE',[id]);if(!r.rows.length) throw new Error('当前没有战斗');
    const s=r.rows[0].state;const current=s.order[s.index];
    if(current.kind==='player') {const c=await db.query('SELECT user_id FROM characters WHERE id=$1 AND world_id=$2',[current.id,id]);if(c.rows[0]?.user_id!==actor.userId) throw new Error('尚未轮到你的角色');}
    else requirePermission(actor,'dm');
    if(current.hp<=0)throw new Error('当前战斗单位已失去行动能力；玩家角色须进行死亡豁免');
    if(kind==='move') {if(amount<0||s.movement+amount>(current.speed||30)) throw new Error('移动距离超出本回合上限');s.movement+=amount;}
    else {if(s.usedAction) throw new Error('本回合已使用动作');s.usedAction=true;}
    let outcome:any={kind,actorId:current.id};
    if(kind==='attack'){
      const target=s.order.find((x:any)=>x.id===targetId);if(!target) throw new Error('目标不存在');
      const roll=randomInt(1,21);const hit=roll===20||roll!==1&&roll+(current.attackBonus||0)>=target.ac;
      const critical=roll===20;
      const attackRollId=uid();await db.query('INSERT INTO dice_rolls(id,world_id,character_id,expression,raw,modifier,total) VALUES($1,$2,$3,$4,$5,$6,$7)',[attackRollId,id,current.kind==='player'?current.id:null,'1d20',JSON.stringify([roll]),current.attackBonus||0,roll+(current.attackBonus||0)]);
      const damageRolls=hit?Array.from({length:critical?2:1},()=>randomInt(1,9)):[];
      const damage=damageRolls.reduce((sum:number,value:number)=>sum+value,0);
      const damageRollId=hit?uid():null;
      if(damageRollId)await db.query('INSERT INTO dice_rolls(id,world_id,character_id,expression,raw,modifier,total) VALUES($1,$2,$3,$4,$5,$6,$7)',[damageRollId,id,current.kind==='player'?current.id:null,critical?'2d8':'1d8',JSON.stringify(damageRolls),0,damage]);
      await applyDamage(db,id,target,damage,critical);
      outcome={...outcome,targetId,attackRollId,damageRollId,roll,hit,critical,damage,targetHp:target.hp};
    }
    await db.query('UPDATE combats SET state=$2 WHERE world_id=$1',[id,JSON.stringify(s)]);
    await db.query("INSERT INTO game_events(world_id,type,payload) VALUES($1,'combat_action',$2)",[id,JSON.stringify(outcome)]);
    await db.query('UPDATE worlds SET version=version+1,important_actions=important_actions+1 WHERE id=$1',[id]);
    return outcome;
  }));
}
export async function castSpell(actor:Actor,id:string,spell:'fire_bolt'|'magic_missile'|'cure_wounds',targetId:string,slotLevel:number){
  requirePermission(actor,'game');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);await checkWorld(db,actor,id);
    const r=await db.query('SELECT state FROM combats WHERE world_id=$1 AND active=true FOR UPDATE',[id]);if(!r.rows.length)throw new Error('当前没有战斗');
    const s=r.rows[0].state,current=s.order[s.index];
    if(current.kind!=='player')throw new Error('当前不是玩家角色回合');
    const c=await db.query('SELECT user_id,sheet FROM characters WHERE id=$1 AND world_id=$2',[current.id,id]);
    if(c.rows[0]?.user_id!==actor.userId)throw new Error('尚未轮到你的角色');
    if(current.hp<=0)throw new Error('当前角色无法施法');
    if(s.usedAction)throw new Error('本回合已使用动作');
    const target=s.order.find((x:any)=>x.id===targetId);if(!target)throw new Error('目标不存在');
    const sheet=c.rows[0].sheet,className=String(sheet.class).toLowerCase();
    const allowed:Record<typeof spell,string[]>={
      fire_bolt:['wizard','法师','sorcerer','术士'],
      magic_missile:['wizard','法师','sorcerer','术士'],
      cure_wounds:['bard','吟游诗人','cleric','牧师','druid','德鲁伊','paladin','圣武士','ranger','游侠']
    };
    if(!allowed[spell].includes(className)||!sheet.spells?.includes(spell))throw new Error('角色未掌握可用的此职业法术');
    const ability=spellcastingAbility(className)!;
    const modifier=abilityModifier(Number(sheet.abilities?.[ability]??10));
    if(spell==='fire_bolt'){if(slotLevel!==0)throw new Error('戏法不消耗法术位');}
    else if(!Number.isInteger(slotLevel)||slotLevel<1||slotLevel>9||Number(sheet.spellSlots?.[String(slotLevel)]||0)<1)throw new Error('对应等级的法术位不足');
    let result:any={spell,actorId:current.id,targetId,slotLevel};
    if(spell==='fire_bolt'){
      const attack=randomInt(1,21),attackBonus=modifier+proficiencyBonus(Number(sheet.level));
      const attackRollId=uid();await db.query('INSERT INTO dice_rolls(id,world_id,character_id,expression,raw,modifier,total) VALUES($1,$2,$3,$4,$5,$6,$7)',[attackRollId,id,current.id,'1d20',JSON.stringify([attack]),attackBonus,attack+attackBonus]);
      const hit=attack===20||attack!==1&&attack+attackBonus>=target.ac;
      const dice=Number(sheet.level)>=17?4:Number(sheet.level)>=11?3:Number(sheet.level)>=5?2:1;
      const rolls=hit?Array.from({length:dice*(attack===20?2:1)},()=>randomInt(1,11)):[];
      const damage=rolls.reduce((sum:number,value:number)=>sum+value,0),damageRollId=hit?uid():null;
      if(damageRollId)await db.query('INSERT INTO dice_rolls(id,world_id,character_id,expression,raw,modifier,total) VALUES($1,$2,$3,$4,$5,$6,$7)',[damageRollId,id,current.id,`${rolls.length}d10`,JSON.stringify(rolls),0,damage]);
      await applyDamage(db,id,target,damage,attack===20);
      result={...result,attackRollId,damageRollId,attack,hit,critical:attack===20,rolls,damage,targetHp:target.hp};
    }else if(spell==='magic_missile'){
      const darts=slotLevel+2,rolls=Array.from({length:darts},()=>randomInt(1,5));
      const damage=rolls.reduce((sum,value)=>sum+value+1,0),rollId=uid();
      await db.query('INSERT INTO dice_rolls(id,world_id,character_id,expression,raw,modifier,total) VALUES($1,$2,$3,$4,$5,$6,$7)',[rollId,id,current.id,`${darts}d4+${darts}`,JSON.stringify(rolls),darts,damage]);
      for(const roll of rolls)await applyDamage(db,id,target,roll+1);
      result={...result,rollId,rolls,damage,targetHp:target.hp};
    }else{
      if(target.kind!=='player')throw new Error('疗伤术目标必须是玩家角色');
      if(target.deathSaves?.dead)throw new Error('无法以疗伤术复活死亡角色');
      const rolls=Array.from({length:slotLevel},()=>randomInt(1,9));
      const healing=Math.max(0,rolls.reduce((sum,value)=>sum+value,0)+modifier),rollId=uid();
      await db.query('INSERT INTO dice_rolls(id,world_id,character_id,expression,raw,modifier,total) VALUES($1,$2,$3,$4,$5,$6,$7)',[rollId,id,current.id,`${slotLevel}d8`,JSON.stringify(rolls),modifier,healing]);
      target.hp=Math.min(target.hpMax,target.hp+healing);
      if(target.hp>0)target.deathSaves={successes:0,failures:0,stable:false,dead:false};
      const healed=await db.query('SELECT sheet FROM characters WHERE id=$1 AND world_id=$2',[target.id,id]);
      await db.query('UPDATE characters SET sheet=$2 WHERE id=$1',[target.id,JSON.stringify({...healed.rows[0].sheet,hp:target.hp,deathSaves:target.deathSaves})]);
      result={...result,rollId,rolls,healing,targetHp:target.hp};
    }
    if(spell!=='fire_bolt'){
      const latest=await db.query('SELECT sheet FROM characters WHERE id=$1 AND world_id=$2',[current.id,id]);
      const currentSheet=latest.rows[0].sheet;
      await db.query('UPDATE characters SET sheet=$2 WHERE id=$1',[current.id,JSON.stringify({...currentSheet,spellSlots:{...currentSheet.spellSlots,[slotLevel]:Number(currentSheet.spellSlots[slotLevel])-1}})]);
    }
    s.usedAction=true;
    await db.query('UPDATE combats SET state=$2 WHERE world_id=$1',[id,JSON.stringify(s)]);
    await db.query("INSERT INTO game_events(world_id,type,payload) VALUES($1,'spell_cast',$2)",[id,JSON.stringify(result)]);
    await db.query('UPDATE worlds SET version=version+1,important_actions=important_actions+1 WHERE id=$1',[id]);
    return result;
  }));
}
export async function deathSave(actor:Actor,id:string){
  requirePermission(actor,'game');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);await checkWorld(db,actor,id);
    const r=await db.query('SELECT state FROM combats WHERE world_id=$1 AND active=true FOR UPDATE',[id]);if(!r.rows.length)throw new Error('当前没有战斗');
    const s=r.rows[0].state,current=s.order[s.index];
    if(current.kind!=='player')throw new Error('当前不是玩家角色回合');
    const c=await db.query('SELECT user_id,sheet FROM characters WHERE id=$1 AND world_id=$2',[current.id,id]);
    if(c.rows[0]?.user_id!==actor.userId)throw new Error('尚未轮到你的角色');
    const death=current.deathSaves||{successes:0,failures:0,stable:false,dead:false};
    if(current.hp>0||death.stable||death.dead)throw new Error('当前角色无需死亡豁免');
    if(s.deathSaveRolled)throw new Error('本回合已进行死亡豁免');
    const roll=randomInt(1,21);
    if(roll===20){current.hp=1;current.deathSaves={successes:0,failures:0,stable:false,dead:false};}
    else{if(roll>=10)death.successes++;else death.failures+=roll===1?2:1;
      if(death.successes>=3){death.successes=0;death.failures=0;death.stable=true;}
      if(death.failures>=3)death.dead=true;
      current.deathSaves=death;
    }
    s.deathSaveRolled=true;
    const rollId=uid();await db.query('INSERT INTO dice_rolls(id,world_id,character_id,expression,raw,modifier,total) VALUES($1,$2,$3,$4,$5,$6,$7)',[rollId,id,current.id,'1d20',JSON.stringify([roll]),0,roll]);
    await db.query('UPDATE combats SET state=$2 WHERE world_id=$1',[id,JSON.stringify(s)]);
    await db.query('UPDATE characters SET sheet=$2 WHERE id=$1',[current.id,JSON.stringify({...c.rows[0].sheet,hp:current.hp,deathSaves:current.deathSaves})]);
    await db.query("INSERT INTO game_events(world_id,type,payload) VALUES($1,'death_save',$2)",[id,JSON.stringify({characterId:current.id,rollId,roll,hp:current.hp,deathSaves:current.deathSaves})]);
    await db.query('UPDATE worlds SET version=version+1,important_actions=important_actions+1 WHERE id=$1',[id]);
    return {characterId:current.id,rollId,roll,hp:current.hp,deathSaves:current.deathSaves};
  }));
}
export async function useItem(actor:Actor,id:string,item:'healing_potion'){
  requirePermission(actor,'game');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);await checkWorld(db,actor,id);
    const r=await db.query('SELECT state FROM combats WHERE world_id=$1 AND active=true FOR UPDATE',[id]);if(!r.rows.length)throw new Error('当前没有战斗');
    const s=r.rows[0].state,current=s.order[s.index];
    if(current.kind!=='player')throw new Error('当前不是玩家角色回合');
    const c=await db.query('SELECT user_id,sheet FROM characters WHERE id=$1 AND world_id=$2',[current.id,id]);
    if(c.rows[0]?.user_id!==actor.userId)throw new Error('尚未轮到你的角色');
    if(current.hp<=0)throw new Error('当前角色无法使用道具');
    if(s.usedAction)throw new Error('本回合已使用动作');
    const sheet=c.rows[0].sheet,equipment=[...(sheet.equipment||[])];
    const index=equipment.findIndex((x:any)=>['治疗药水','potion of healing'].includes(String(x.name).toLowerCase())&&x.quantity>0);
    if(item!=='healing_potion'||index<0)throw new Error('角色没有治疗药水');
    const rolls=[randomInt(1,5),randomInt(1,5)],healing=rolls[0]+rolls[1]+2;
    const rollId=uid();await db.query('INSERT INTO dice_rolls(id,world_id,character_id,expression,raw,modifier,total) VALUES($1,$2,$3,$4,$5,$6,$7)',[rollId,id,current.id,'2d4+2',JSON.stringify(rolls),2,healing]);
    current.hp=Math.min(current.hpMax,current.hp+healing);
    equipment[index]={...equipment[index],quantity:equipment[index].quantity-1};
    if(equipment[index].quantity===0)equipment.splice(index,1);
    s.usedAction=true;
    await db.query('UPDATE combats SET state=$2 WHERE world_id=$1',[id,JSON.stringify(s)]);
    await db.query('UPDATE characters SET sheet=$2 WHERE id=$1',[current.id,JSON.stringify({...sheet,hp:current.hp,equipment})]);
    const result={item,characterId:current.id,rollId,rolls,healing,hp:current.hp};
    await db.query("INSERT INTO game_events(world_id,type,payload) VALUES($1,'item_used',$2)",[id,JSON.stringify(result)]);
    await db.query('UPDATE worlds SET version=version+1,important_actions=important_actions+1 WHERE id=$1',[id]);
    return result;
  }));
}
export async function endTurn(actor: Actor,id: string) {
  requirePermission(actor,'game');
  return tx(async db=>idempotent(db,id,actor.requestId,async()=>{await lockWorld(db,id);await checkWorld(db,actor,id);
    const r=await db.query('SELECT state FROM combats WHERE world_id=$1 AND active=true FOR UPDATE',[id]);if(!r.rows.length) throw new Error('当前没有战斗');
    const s=r.rows[0].state;const current=s.order[s.index];
    if(current.kind==='player'){const c=await db.query('SELECT user_id FROM characters WHERE id=$1',[current.id]);if(c.rows[0]?.user_id!==actor.userId)throw new Error('尚未轮到你的角色');}
    else requirePermission(actor,'dm');
    if(current.kind==='player'&&current.hp===0&&!current.deathSaves?.stable&&!current.deathSaves?.dead&&!s.deathSaveRolled)throw new Error('请先进行死亡豁免');
    let attempts=0;
    do{s.index=(s.index+1)%s.order.length;if(s.index===0)s.round++;attempts++;}while((s.order[s.index].kind==='enemy'&&s.order[s.index].hp<=0||s.order[s.index].deathSaves?.stable||s.order[s.index].deathSaves?.dead)&&attempts<s.order.length);
    s.usedAction=false;s.usedBonus=false;s.deathSaveRolled=false;s.movement=0;
    await db.query('UPDATE combats SET state=$2 WHERE world_id=$1',[id,JSON.stringify(s)]);
    await db.query('UPDATE worlds SET version=version+1 WHERE id=$1',[id]);
    return {round:s.round,current:s.order[s.index]};
  }));
}
export async function endCombat(actor: Actor,id: string) {
  requirePermission(actor,'dm');
  return tx(async db=>{await lockWorld(db,id);await checkWorld(db,actor,id);
    const ended=await db.query('UPDATE combats SET active=false WHERE world_id=$1 AND active=true RETURNING world_id',[id]);
    if(!ended.rows.length)throw new Error('当前没有战斗');
    await db.query("INSERT INTO game_events(world_id,type,payload) VALUES($1,'combat_ended','{}')",[id]);
    await db.query('UPDATE worlds SET version=version+1,important_actions=important_actions+1,autosave_requested=true WHERE id=$1',[id]);
    return {ended:true};
  });
}
