import {beneficiaries,documentTypes,stages} from "./model.js";

export const lookupGroups = {documentTypes:"Tipuri de documente",beneficiaries:"Beneficiari",stages:"Etape de coordonare"} as const;
export type LookupGroup = keyof typeof lookupGroups;
export type LookupValue = {id:string;label:string;enabled:boolean};
export type AppConfig = {
  version:number;
  lookups:Record<LookupGroup,LookupValue[]>;
  warningDays:number;
  idleMinutes:number;
  sessionHours:number;
  temporaryHours:number;
  loginAttempts:number;
  lockMinutes:number;
  mail:{provider:"none"|"resend"|"https";from:string;endpoint:string};
};
export const defaultConfig:AppConfig = {
  version:1,
  lookups:Object.fromEntries(Object.entries({documentTypes,beneficiaries,stages}).map(([group,values])=>[group,values.map((label,index)=>({id:`${group}-${index}`,label,enabled:true}))])) as AppConfig["lookups"],
  warningDays:7,idleMinutes:30,sessionHours:8,temporaryHours:24,loginAttempts:5,lockMinutes:15,
  mail:{provider:"none",from:"",endpoint:""},
};
export const roleLabels = {admin:"Administrator",owner:"Șef SPSS",designer:"Proiectant",audit:"Audit"};
export function lookupOptions(config:AppConfig,group:LookupGroup,current="") {
  const values=config.lookups[group].filter(v=>v.enabled).map(v=>v.label);
  if(current&&!values.includes(current))values.push(current);
  return values;
}
export async function readConfig(db:D1Database):Promise<AppConfig> {
  const row=await db.prepare("SELECT value FROM settings WHERE key='app_config'").first<{value:string}>();
  return row?JSON.parse(row.value) as AppConfig:structuredClone(defaultConfig);
}
