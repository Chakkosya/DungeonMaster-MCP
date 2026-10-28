export const xpForLevel=[0,300,900,2700,6500,14000,23000,34000,48000,64000,85000,100000,120000,140000,165000,195000,225000,265000,305000,355000];

const hitDice:Record<string,number>={
  barbarian:12,'野蛮人':12,
  fighter:10,'战士':10,paladin:10,'圣武士':10,ranger:10,'游侠':10,
  bard:8,'吟游诗人':8,cleric:8,'牧师':8,druid:8,'德鲁伊':8,monk:8,'武僧':8,rogue:8,'游荡者':8,warlock:8,'邪术师':8,
  sorcerer:6,'术士':6,wizard:6,'法师':6
};
export function hitDieForClass(name:string){return hitDice[name.toLowerCase()]||null;}
export function abilityModifier(score:number){return Math.floor((score-10)/2);}
export function proficiencyBonus(level:number){return 2+Math.floor((level-1)/4);}

const fullCasterSlots:number[][]=[
  [],[2],[3],[4,2],[4,3],[4,3,2],[4,3,3],[4,3,3,1],[4,3,3,2],
  [4,3,3,3,1],[4,3,3,3,2],[4,3,3,3,2,1],[4,3,3,3,2,1],
  [4,3,3,3,2,1,1],[4,3,3,3,2,1,1],[4,3,3,3,2,1,1,1],
  [4,3,3,3,2,1,1,1],[4,3,3,3,2,1,1,1,1],
  [4,3,3,3,3,1,1,1,1],[4,3,3,3,3,2,1,1,1],[4,3,3,3,3,2,2,1,1]
];
const halfCasterSlots:number[][]=[
  [],[2],[3],[3],[4,2],[4,2],[4,3],[4,3],[4,3,2],[4,3,2],
  [4,3,3],[4,3,3],[4,3,3,1],[4,3,3,1],[4,3,3,2],[4,3,3,2],
  [4,3,3,3,1],[4,3,3,3,1],[4,3,3,3,2],[4,3,3,3,2]
];
const casterAbility:Record<string,'intelligence'|'wisdom'|'charisma'>={
  wizard:'intelligence','法师':'intelligence',
  cleric:'wisdom','牧师':'wisdom',druid:'wisdom','德鲁伊':'wisdom',ranger:'wisdom','游侠':'wisdom',
  bard:'charisma','吟游诗人':'charisma',sorcerer:'charisma','术士':'charisma',
  paladin:'charisma','圣武士':'charisma'
};
export function spellcastingAbility(className:string){return casterAbility[className.toLowerCase()]||null;}
export function spellSlotsForClass(className:string,level:number){
  const name=className.toLowerCase();
  const half=['paladin','圣武士','ranger','游侠'].includes(name);
  const slots=half?halfCasterSlots[level-1]:spellcastingAbility(name)?fullCasterSlots[level]:[];
  return Object.fromEntries((slots||[]).map((count,index)=>[String(index+1),count])) as Record<string,number>;
}
