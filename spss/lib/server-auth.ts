import {env} from "../server/runtime.js";
import {z} from "zod";
import {defaultConfig,readConfig,type AppConfig} from "./config.js";
import type {Identity} from "./model.js";

export class ApiError extends Error {constructor(public status:number,message:string){super(message);}}
export function database(){if(!env.DB)throw new ApiError(503,"Baza de date nu este disponibilă.");return env.DB;}
export function json(value:unknown,status=200,headers:Record<string,string>={}) {
  return Response.json(value,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...headers}});
}
type AuthUser={id:string;email:string;name:string;role:Identity["role"];designer:string;enabled:number;password_hash:string|null;temporary_hash:string|null;temporary_expires:string|null;auth_version:number};
type Session={token_hash:string;user_id:string;auth_version:number;requires_change:number;kind:string;platform_user_id:string|null;temporary_proof:string|null;created_at:string;last_seen_at:string;expires_at:string};
const localHTTP=process.env.ALLOW_INSECURE_LOCAL_HTTP==="true";
const cookieName=localHTTP?"spss-local-session":"__Host-spss-session";
const emailSchema=z.string().trim().email("Introduceți o adresă de email validă.").max(254).transform(s=>s.toLowerCase());
export const newPassword=z.string().min(12,"Parola trebuie să aibă cel puțin 12 caractere.").max(128,"Parola poate avea cel mult 128 de caractere.");
const encoder=new TextEncoder();
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
const unhex=(s:string)=>Uint8Array.from(s.match(/.{2}/g)||[],b=>parseInt(b,16));
const random=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
export const sha=async(value:string)=>hex(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value))));
async function derive(password:string,salt:Uint8Array<ArrayBuffer>,iterations=600000){
  const key=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations},key,256)));
}
export async function hashPassword(password:string){const salt=crypto.getRandomValues(new Uint8Array(16));return `pbkdf2-sha256$600000$${hex(salt)}$${await derive(password,salt)}`;}
export async function verifyPassword(password:string,stored:string|null){
  const parts=stored?.split("$");
  if(!parts||parts.length!==4||parts[0]!=="pbkdf2-sha256"||parts[1]!=="600000"||!/^\w{32}$/.test(parts[2])||!/^\w{64}$/.test(parts[3])){
    await derive(password,new Uint8Array(16));return false;
  }
  const actual=await derive(password,unhex(parts[2]));let mismatch=0;
  for(let i=0;i<actual.length;i++)mismatch|=actual.charCodeAt(i)^parts[3].charCodeAt(i);
  return mismatch===0;
}
function tokenFrom(req:Request){const match=req.headers.get("cookie")?.split(";").map(s=>s.trim()).find(s=>s.startsWith(cookieName+"="));const token=match?.slice(cookieName.length+1);return token&&/^[a-f0-9]{64}$/.test(token)?token:null;}
function cookie(token:string,seconds:number){return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${localHTTP?"":"; Secure"}`;}
function identityOf(user:AuthUser,kind:string):Identity{return {userId:user.id,email:user.email,name:user.name,role:user.role,designer:user.designer,authMethod:kind};}
export async function auditAuth(actor:string,action:string,designer:string|null=null){
  await database().prepare("INSERT INTO audit(id,actor,action,designer,created_at) VALUES(?,?,?,?,?)").bind(crypto.randomUUID(),actor,action,designer,new Date().toISOString()).run();
}
async function session(req:Request){
  const token=tokenFrom(req);if(!token)return null;
  const sql=database(),key=await sha(token);
  const s=await sql.prepare("SELECT * FROM auth_sessions WHERE token_hash=?").bind(key).first<Session>();
  if(!s)return null;
  const user=await sql.prepare("SELECT * FROM auth_users WHERE id=?").bind(s.user_id).first<AuthUser>();
  const config=await readConfig(sql);const now=Date.now();
  if(!user?.enabled||user.auth_version!==s.auth_version||Date.parse(s.expires_at)<=now||Date.parse(s.created_at)+config.sessionHours*3600000<=now||Date.parse(s.last_seen_at)+config.idleMinutes*60000<=now){
    await sql.prepare("DELETE FROM auth_sessions WHERE token_hash=?").bind(key).run();return null;
  }
  if(s.kind==="bootstrap")return null;
  // Automatic polling does not count as user activity.
  if(req.method!=="GET"||req.headers.get("x-spss-active")==="1")await sql.prepare("UPDATE auth_sessions SET last_seen_at=? WHERE token_hash=?").bind(new Date().toISOString(),key).run();
  return {s,user,identity:identityOf(user,s.kind)};
}
export async function requireIdentity(req:Request):Promise<Identity>{
  const auth=await session(req);if(!auth)throw new ApiError(401,"Conectați-vă cu email și parolă.");
  if(auth.s.requires_change)throw new ApiError(428,"Schimbați parola temporară pentru a continua.");
  return auth.identity;
}
async function newSession(req:Request,user:AuthUser,kind:string,requiresChange=false,platformId:string|null=null,temporaryProof:string|null=null){
  const sql=database(),config=await readConfig(sql),token=random(),now=new Date().toISOString();
  const expires=new Date(Date.now()+(requiresChange?15*60000:config.sessionHours*3600000)).toISOString();
  await sql.batch([
    sql.prepare("DELETE FROM auth_sessions WHERE expires_at<?").bind(now),
    sql.prepare("DELETE FROM auth_limits WHERE window_start<?").bind(Date.now()-86400000),
    sql.prepare("INSERT INTO auth_sessions(token_hash,user_id,auth_version,requires_change,kind,platform_user_id,temporary_proof,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(await sha(token),user.id,user.auth_version,Number(requiresChange),kind,platformId,temporaryProof,now,now,expires)
  ]);
  return json({identity:identityOf(user,kind),requiresPasswordChange:requiresChange},200,{"Set-Cookie":cookie(token,Math.ceil((Date.parse(expires)-Date.now())/1000))});
}
export async function rateLimit(key:string,maximum:number,windowMs:number){
  const now=Date.now();
  const row=await database().prepare("INSERT INTO auth_limits(key,count,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start<=? THEN 1 ELSE count+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END RETURNING count")
    .bind(await sha(key),now,now-windowMs,now-windowMs).first<{count:number}>();
  if(!row||row.count>maximum)throw new ApiError(429,"Prea multe încercări. Reîncercați după expirarea intervalului de blocare.");
}
function mailReady(config:AppConfig){return config.mail.provider!=="none"&&!!config.mail.from&&!!env.SPSS_MAIL_API_TOKEN&&(config.mail.provider!=="https"||!!config.mail.endpoint);}
export function mailStatus(config:AppConfig){return {ready:mailReady(config),tokenConfigured:!!env.SPSS_MAIL_API_TOKEN};}
export async function issueTemporary(userId:string,actor:string,origin:string){
  const sql=database(),config=await readConfig(sql);
  if(!mailReady(config))throw new ApiError(503,"Serviciul de email nu este configurat. Contul rămâne pregătit; expedierea se activează după configurare.");
  const user=await sql.prepare("SELECT * FROM auth_users WHERE id=? AND enabled=1").bind(userId).first<AuthUser>();
  if(!user)throw new ApiError(404,"Contul activ nu a fost găsit.");
  const password=hex(crypto.getRandomValues(new Uint8Array(16)));
  const hash=await hashPassword(password),expires=new Date(Date.now()+config.temporaryHours*3600000).toISOString();
  const changed=await sql.prepare("UPDATE auth_users SET temporary_hash=?,temporary_expires=? WHERE id=? AND enabled=1 AND auth_version=?").bind(hash,expires,user.id,user.auth_version).run();
  if(!changed.meta.changes)throw new ApiError(409,"Contul a fost modificat între timp.");
  const endpoint=config.mail.provider==="resend"?"https://api.resend.com/emails":config.mail.endpoint;
  const message={from:config.mail.from,to:[user.email],subject:"SPSS · Parola temporară pentru autentificare",text:`Bună ziua, ${user.name}!\n\nContul dvs. SPSS Monitorizarea proiectării: ${user.email}\nParola temporară: ${password}\nConectare: ${origin}\n\nParola expiră în ${config.temporaryHours} ore și se poate utiliza o singură dată. La prima conectare veți stabili o parolă personală de cel puțin 12 caractere.\nDacă nu ați solicitat accesul, contactați administratorul.\n\nSPSS`};
  try{
    const response=await fetch(endpoint,{method:"POST",headers:{Authorization:`Bearer ${env.SPSS_MAIL_API_TOKEN}`,"Content-Type":"application/json","Idempotency-Key":crypto.randomUUID()},body:JSON.stringify(message),signal:AbortSignal.timeout(12000),redirect:"manual"});
    if(!response.ok)throw new Error("mail rejected");
  }catch{
    await sql.prepare("UPDATE auth_users SET temporary_hash=NULL,temporary_expires=NULL WHERE id=? AND temporary_hash=?").bind(user.id,hash).run();
    await auditAuth(actor,`Expedierea parolei temporare nu a reușit pentru ${user.name}.`);
    throw new ApiError(502,"Serviciul de email nu a confirmat expedierea. Parola personală existentă rămâne valabilă. Reîncercați.");
  }
  await auditAuth(actor,`A solicitat expedierea unei parole temporare pentru ${user.name}.`);
  return {ok:true,message:"Serviciul de email a acceptat mesajul cu parola temporară."};
}
export async function handleAuth(req:Request,path:string[]):Promise<Response>{
  const sql=database();const action=path[1];
  if(action==="status"&&req.method==="GET"){
    const auth=await session(req);
    return json({identity:auth?.identity||null,requiresPasswordChange:!!auth?.s.requires_change,bootstrapAvailable:false,bootstrapEmail:null,mailReady:mailReady(await readConfig(sql))});
  }
  if(action==="bootstrap")throw new ApiError(403,"Administratorul inițial se configurează local de către responsabilul serverului.");
  if(action==="login"&&req.method==="POST"){
    const body=z.object({email:emailSchema,password:z.string().min(1).max(128)}).parse(await req.json());
    const config=await readConfig(sql),ip=req.headers.get("cf-connecting-ip")||"unknown";
    await rateLimit(`login-ip:${ip}`,50,config.lockMinutes*60000);
    await rateLimit(`login:${body.email}`,config.loginAttempts,config.lockMinutes*60000);
    const user=await sql.prepare("SELECT * FROM auth_users WHERE email=?").bind(body.email).first<AuthUser>();
    const permanent=await verifyPassword(body.password,user?.password_hash||null);
    const temporary=!!user?.temporary_hash&&Date.parse(user.temporary_expires||"")>Date.now()&&await verifyPassword(body.password,user.temporary_hash);
    if(!user?.enabled||(!permanent&&!temporary))throw new ApiError(401,"Emailul sau parola nu este corectă, ori parola temporară a expirat.");
    if(temporary&&!permanent){
      const result=await sql.prepare("UPDATE auth_users SET temporary_hash=NULL,temporary_expires=NULL WHERE id=? AND temporary_hash=? AND enabled=1 AND auth_version=?").bind(user.id,user.temporary_hash,user.auth_version).run();
      if(!result.meta.changes)throw new ApiError(401,"Parola temporară a fost deja utilizată. Solicitați una nouă.");
    }
    await sql.batch([
      sql.prepare("DELETE FROM auth_limits WHERE key=?").bind(await sha(`login:${body.email}`)),
      sql.prepare("UPDATE auth_users SET last_login_at=? WHERE id=?").bind(new Date().toISOString(),user.id)
    ]);
    await auditAuth(user.name,"S-a autentificat în aplicație.",user.designer||null);
    return newSession(req,user,temporary&&!permanent?"temporary":"password",temporary&&!permanent,null,temporary&&!permanent?user.temporary_hash:null);
  }
  if(action==="forgot"&&req.method==="POST"){
    const {email}=z.object({email:emailSchema}).parse(await req.json());
    if(!mailReady(await readConfig(sql)))throw new ApiError(503,"Recuperarea prin email se activează după configurarea serviciului. Contactați administratorul.");
    await rateLimit(`forgot-ip:${req.headers.get("cf-connecting-ip")||"unknown"}`,20,3600000);
    await rateLimit(`forgot:${email}`,3,3600000);
    const user=await sql.prepare("SELECT id FROM auth_users WHERE email=? AND enabled=1").bind(email).first<{id:string}>();
    if(user){try{await issueTemporary(user.id,"Recuperare cont",new URL(req.url).origin);}catch{/* Same response for every address; no account disclosure. */}}
    return json({ok:true,message:"Dacă adresa corespunde unui cont activ, a fost solicitată expedierea unei parole temporare. Dacă mesajul nu sosește, contactați administratorul."});
  }
  if(action==="logout"&&req.method==="POST"){
    const token=tokenFrom(req);if(token)await sql.prepare("DELETE FROM auth_sessions WHERE token_hash=?").bind(await sha(token)).run();
    return json({ok:true},200,{"Set-Cookie":cookie("",0)});
  }
  if(action==="change-password"&&req.method==="POST"){
    const auth=await session(req);if(!auth)throw new ApiError(401,"Sesiunea a expirat. Conectați-vă din nou.");
    const body=z.object({currentPassword:z.string().max(128).default(""),password:newPassword}).parse(await req.json());
    if(auth.s.requires_change&&await verifyPassword(body.password,auth.s.temporary_proof))throw new ApiError(400,"Parola personală trebuie să difere de parola temporară.");
    if(auth.s.kind!=="bootstrap"&&!auth.s.requires_change&&!await verifyPassword(body.currentPassword,auth.user.password_hash))throw new ApiError(400,"Parola curentă nu este corectă.");
    if(auth.user.password_hash&&await verifyPassword(body.password,auth.user.password_hash))throw new ApiError(400,"Alegeți o parolă diferită de cea curentă.");
    const result=await sql.prepare("UPDATE auth_users SET password_hash=?,temporary_hash=NULL,temporary_expires=NULL,auth_version=auth_version+1 WHERE id=? AND auth_version=? AND enabled=1").bind(await hashPassword(body.password),auth.user.id,auth.user.auth_version).run();
    if(!result.meta.changes)throw new ApiError(409,"Contul a fost modificat între timp. Conectați-vă din nou.");
    await sql.prepare("DELETE FROM auth_sessions WHERE user_id=?").bind(auth.user.id).run();
    await auditAuth(auth.user.name,"A stabilit o parolă personală; sesiunile anterioare au fost revocate.",auth.user.designer||null);
    return newSession(req,{...auth.user,auth_version:auth.user.auth_version+1},"password");
  }
  throw new ApiError(404,"Operațiunea de autentificare nu a fost găsită.");
}
