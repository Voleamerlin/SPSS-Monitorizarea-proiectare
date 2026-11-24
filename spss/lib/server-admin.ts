import {z} from "zod";
import catalog from "../data/catalog.json" with {type:"json"};
import {defaultConfig,readConfig,type AppConfig} from "./config.js";
import {ApiError,database,json,auditAuth,issueTemporary,mailStatus,rateLimit,newPassword,hashPassword,sha} from "./server-auth.js";
import {readsAdministration,type Identity} from "./model.js";

const value=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),label:z.string().trim().min(1).max(150),enabled:z.boolean()});
const list=z.array(value).min(1).max(100).superRefine((values,ctx)=>{
  if(!values.some(v=>v.enabled))ctx.addIssue({code:"custom",message:"Păstrați cel puțin o valoare activă în fiecare nomenclator."});
  const ids=new Set<string>(),labels=new Set<string>();
  for(const v of values){const label=v.label.normalize("NFKC").replace(/\s+/g," ").toLowerCase();if(ids.has(v.id)||labels.has(label))ctx.addIssue({code:"custom",message:"Nomenclatorul conține valori duplicate."});ids.add(v.id);labels.add(label);}
});
export const configSchema=z.object({
  version:z.number().int().positive(),lookups:z.object({documentTypes:list,beneficiaries:list,stages:list}),
  warningDays:z.number().int().min(1).max(90),idleMinutes:z.number().int().min(5).max(120),sessionHours:z.number().int().min(1).max(24),
  temporaryHours:z.number().int().min(1).max(72),loginAttempts:z.number().int().min(3).max(10),lockMinutes:z.number().int().min(5).max(60),
  mail:z.object({provider:z.enum(["none","resend","https"]),from:z.string().trim().max(254),endpoint:z.string().trim().max(1000)})
}).superRefine((config,ctx)=>{
  if(!config.lookups.stages.some(v=>v.id==="stages-6"&&v.label==="Aprobat"&&v.enabled))ctx.addIssue({code:"custom",message:"Etapa de sistem «Aprobat» trebuie păstrată activă, cu aceeași denumire."});
  if(config.mail.provider!=="none"&&!z.string().email().safeParse(config.mail.from).success)ctx.addIssue({code:"custom",message:"Completați o adresă de expeditor validă."});
  if(config.mail.provider==="https"){
    try{const u=new URL(config.mail.endpoint);if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash||!u.hostname.includes(".")||/^[\d.]+$/.test(u.hostname)||u.hostname.includes(":")||/\.(local|localhost|internal)$/.test(u.hostname))throw new Error();}
    catch{ctx.addIssue({code:"custom",message:"Gateway-ul trebuie să fie o adresă HTTPS publică, fără credențiale sau parametri în URL."});}
  }
});
const userSchema=z.object({
  email:z.string().trim().email().max(254).transform(s=>s.toLowerCase()),name:z.string().trim().min(2).max(150),
  role:z.enum(["admin","owner","designer","audit"]),designer:z.string().trim().max(150).default(""),enabled:z.boolean().default(true),authVersion:z.number().int().optional(),
});
async function validateDesigner(role:string,name:string){
  if(role!=="designer")return;
  if(!name)throw new ApiError(400,"Selectați proiectantul asociat contului.");
  const exists=catalog.designers.includes(name)||await database().prepare("SELECT name FROM team_people WHERE role='designer' AND name=? UNION SELECT designer AS name FROM projects WHERE designer=? UNION SELECT designer AS name FROM tasks WHERE designer=?").bind(name,name,name).first();
  if(!exists)throw new ApiError(400,"Adăugați mai întâi proiectantul în echipă.");
}
export async function handleAdmin(req:Request,path:string[],i:Identity){
  if(!readsAdministration(i))throw new ApiError(403,"Administrarea este disponibilă numai Administratorului și rolului Audit.");
  if(req.method!=="GET"&&i.role!=="admin")throw new ApiError(403,"Rolul Audit permite numai vizualizare.");
  const sql=database(),section=path[1],id=path[2];
  if(section==="export"&&req.method==="GET"){
    if(i.role!=="admin")throw new ApiError(403,"Exportul pentru migrare este disponibil numai Administratorului.");
    await auditAuth(i.name,"A exportat datele pentru migrarea pe server propriu.");
    const names=["settings","projects","tasks","team_people","members","audit","project_history","auth_users"];
    const queries=[
      "SELECT key,value FROM settings WHERE key IN ('app_config','catalog_imported') UNION ALL SELECT 'app_config',? WHERE NOT EXISTS(SELECT 1 FROM settings WHERE key='app_config')",
      "SELECT * FROM projects ORDER BY id","SELECT * FROM tasks ORDER BY id","SELECT * FROM team_people ORDER BY id",
      "SELECT * FROM members ORDER BY email","SELECT * FROM audit ORDER BY created_at,id","SELECT * FROM project_history ORDER BY created_at,id",
      "SELECT id,email,name,role,designer,enabled,password_hash,NULL AS temporary_hash,NULL AS temporary_expires,auth_version+1 AS auth_version,created_at,last_login_at FROM auth_users ORDER BY id"
    ];
    const rows=await sql.batch(queries.map((q,index)=>index===0?sql.prepare(q).bind(JSON.stringify(defaultConfig)):sql.prepare(q)));
    const tables=Object.fromEntries(names.map((name,index)=>[name,rows[index].results]));
    return json({format:"ctif-spss-migration-v1",complete:true,exportedAt:new Date().toISOString(),includesPasswordHashes:true,sessionsExcluded:true,tables,counts:Object.fromEntries(names.map((name,index)=>[name,rows[index].results.length]))},200,{"Content-Disposition":`attachment; filename="SPSS_Migrare_${new Date().toISOString().slice(0,10)}.json"`});
  }
  if(section==="overview"&&req.method==="GET"){
    const config=await readConfig(sql);
    const users=await sql.prepare("SELECT id,email,name,role,designer,enabled,auth_version AS authVersion,created_at AS createdAt,last_login_at AS lastLoginAt,CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END AS hasPassword,CASE WHEN temporary_hash IS NOT NULL THEN 1 ELSE 0 END AS hasTemporaryPassword,temporary_expires AS temporaryExpires FROM auth_users ORDER BY name COLLATE NOCASE").all();
    return json({config,users:users.results,mail:mailStatus(config)});
  }
  if(section==="config"&&req.method==="PATCH"){
    const config=configSchema.parse(await req.json()) as AppConfig;
    await sql.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('app_config',?)").bind(JSON.stringify(defaultConfig)).run();
    const old=await sql.prepare("SELECT value FROM settings WHERE key='app_config'").first<{value:string}>();
    if(!old||JSON.parse(old.value).version!==config.version)throw new ApiError(409,"Configurația a fost modificată de alt administrator. Reîncărcați pagina.");
    config.version++;
    const result=await sql.prepare("UPDATE settings SET value=? WHERE key='app_config' AND value=?").bind(JSON.stringify(config),old.value).run();
    if(!result.meta.changes)throw new ApiError(409,"Configurația a fost modificată între timp.");
    await auditAuth(i.name,"A actualizat nomenclatoarele sau parametrii aplicației.");
    return json({config,mail:mailStatus(config)});
  }
  if(section==="users"&&!id&&req.method==="POST"){
    const u=userSchema.parse(await req.json());await validateDesigner(u.role,u.designer);
    if(await sql.prepare("SELECT id FROM auth_users WHERE email=?").bind(u.email).first())throw new ApiError(409,"Există deja un cont cu această adresă de email.");
    if(u.role==="designer"&&u.enabled&&await sql.prepare("SELECT id FROM auth_users WHERE designer=? AND role='designer' AND enabled=1").bind(u.designer).first())throw new ApiError(409,"Proiectantul are deja un cont activ.");
    const userId=crypto.randomUUID();
    await sql.prepare("INSERT INTO auth_users(id,email,name,role,designer,enabled,created_at) VALUES(?,?,?,?,?,?,?)").bind(userId,u.email,u.name,u.role,u.role==="designer"?u.designer:"",Number(u.enabled),new Date().toISOString()).run();
    await auditAuth(i.name,`A pregătit contul ${u.name} (${u.role==="admin"?"Administrator":u.role==="owner"?"Șef SPSS":u.role==="audit"?"Audit":"Proiectant"}).`);
    return json({id:userId,message:"Contul a fost pregătit. Puteți seta manual parola sau expedia o parolă temporară prin email după configurarea serviciului."},201);
  }
  if(section==="users"&&id){
    const old=await sql.prepare("SELECT id,email,name,role,designer,enabled,auth_version FROM auth_users WHERE id=?").bind(id).first<{id:string;email:string;name:string;role:string;designer:string;enabled:number;auth_version:number}>();
    if(!old)throw new ApiError(404,"Contul nu a fost găsit.");
    if(path[3]==="password"&&req.method==="POST"){
      if(id===i.userId)throw new ApiError(400,"Pentru contul propriu utilizați «Schimbă parola» din meniul contului.");
      if(!old.enabled)throw new ApiError(400,"Activați contul înainte de a seta parola.");
      const body=z.object({password:newPassword,confirmPassword:z.string().max(128),authVersion:z.number().int().positive()}).refine(v=>v.password===v.confirmPassword,{message:"Cele două parole nu coincid.",path:["confirmPassword"]}).parse(await req.json());
      if(body.authVersion!==old.auth_version)throw new ApiError(409,"Contul a fost modificat între timp. Reîncărcați lista și redeschideți formularul.");
      await rateLimit(`admin-password:${i.userId}`,20,3600000);
      await rateLimit(`manual-password:${id}`,5,3600000);
      const config=await readConfig(sql),hash=await hashPassword(body.password),version=old.auth_version+1;
      const expiresAt=new Date(Date.now()+config.temporaryHours*3600000).toISOString();
      // Credential change, session revocation and audit are one transaction.
      // Dependent statements require the installed hash and version, so a lost CAS has no side effects.
      const results=await sql.batch([
        sql.prepare("UPDATE auth_users SET password_hash=NULL,temporary_hash=?,temporary_expires=?,auth_version=auth_version+1 WHERE id=? AND auth_version=? AND enabled=1").bind(hash,expiresAt,id,old.auth_version),
        sql.prepare("DELETE FROM auth_sessions WHERE user_id=? AND EXISTS(SELECT 1 FROM auth_users WHERE id=? AND auth_version=? AND temporary_hash=?)").bind(id,id,version,hash),
        sql.prepare("DELETE FROM auth_limits WHERE key=? AND EXISTS(SELECT 1 FROM auth_users WHERE id=? AND auth_version=? AND temporary_hash=?)").bind(await sha(`login:${old.email}`),id,version,hash),
        sql.prepare("INSERT OR REPLACE INTO settings(key,value) SELECT 'owner_password_initialized','1' FROM auth_users WHERE id='bootstrap-admin' AND id=? AND auth_version=? AND temporary_hash=?").bind(id,version,hash),
        sql.prepare("INSERT INTO audit(id,actor,action,created_at) SELECT ?,?,?,? FROM auth_users WHERE id=? AND auth_version=? AND temporary_hash=?").bind(crypto.randomUUID(),i.name,`A setat manual o parolă temporară pentru ${old.name}; parola anterioară și sesiunile au fost invalidate.`,new Date().toISOString(),id,version,hash),
      ]);
      if(!results[0].meta.changes)throw new ApiError(409,"Contul a fost modificat între timp. Parola nu a fost schimbată.");
      return json({ok:true,expiresAt,message:"Parola a fost setată. Comunicați-o utilizatorului printr-un canal sigur; acesta trebuie să o schimbe la prima conectare. Sesiunile anterioare au fost închise."});
    }
    if(path[3]==="invite"&&req.method==="POST"){
      await rateLimit(`admin-mail:${i.userId}`,20,3600000);await rateLimit(`invite:${id}`,3,3600000);
      return json(await issueTemporary(id,i.name,new URL(req.url).origin));
    }
    if(path[3]==="sessions"&&req.method==="DELETE"){
      await sql.batch([sql.prepare("UPDATE auth_users SET auth_version=auth_version+1 WHERE id=?").bind(id),sql.prepare("DELETE FROM auth_sessions WHERE user_id=?").bind(id)]);
      await auditAuth(i.name,`A revocat toate sesiunile contului ${old.name}.`);return json({ok:true});
    }
    if(req.method==="PATCH"&&!path[3]){
      const u=userSchema.parse(await req.json());if(u.email!==old.email)throw new ApiError(400,"Adresa contului este fixă. Pentru altă adresă, pregătiți un cont nou.");
      if(u.authVersion!==old.auth_version)throw new ApiError(409,"Contul a fost modificat între timp. Reîncărcați lista.");
      await validateDesigner(u.role,u.designer);
      if(id===i.userId&&(!u.enabled||u.role!=="admin"))throw new ApiError(400,"Nu puteți dezactiva sau retrage propriul rol de Administrator.");
      if(u.role==="designer"&&u.enabled&&await sql.prepare("SELECT id FROM auth_users WHERE designer=? AND role='designer' AND enabled=1 AND id<>?").bind(u.designer,id).first())throw new ApiError(409,"Proiectantul are deja un alt cont activ.");
      const designer=u.role==="designer"?u.designer:"",revoke=old.role!==u.role||old.designer!==designer||old.enabled!==Number(u.enabled);
      const removingAdmin=old.role==="admin"&&!!old.enabled&&(u.role!=="admin"||!u.enabled);
      const result=await sql.prepare("UPDATE auth_users SET name=?,role=?,designer=?,enabled=?,auth_version=auth_version+? WHERE id=? AND auth_version=? AND (?=0 OR (SELECT count(*) FROM auth_users WHERE role='admin' AND enabled=1)>1)").bind(u.name,u.role,designer,Number(u.enabled),Number(revoke),id,old.auth_version,Number(removingAdmin)).run();
      if(!result.meta.changes)throw new ApiError(409,"Modificarea nu este permisă: păstrați un Administrator activ și reîncărcați lista.");
      if(revoke)await sql.prepare("DELETE FROM auth_sessions WHERE user_id=?").bind(id).run();
      await auditAuth(i.name,`A actualizat contul ${u.name}${revoke?"; sesiunile au fost revocate":""}.`);
      return json({ok:true});
    }
  }
  throw new ApiError(404,"Operațiunea de administrare nu a fost găsită.");
}
