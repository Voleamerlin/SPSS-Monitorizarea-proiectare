import {env} from "./runtime.js";
import { z } from "zod";
import {ApiError,requireIdentity,handleAuth} from "../lib/server-auth.js";
import {handleAdmin} from "../lib/server-admin.js";
import {handlePortfolio,projectFromRow} from "../lib/server-portfolio.js";
import {readConfig,lookupOptions} from "../lib/config.js";
import catalog from "../data/catalog.json" with {type:"json"};
import { statuses, priorities, today, canEdit, isClosed, managesRegistry, readsAll, type Identity, type Task, type TaskData } from "../lib/model.js";

export const dynamic = "force-dynamic";
const str = z.string().trim().max(5000).default("");
const date = z.string().refine(s=>s === "" || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s),"Data nu este validă.").default("");
export const taskSchema = z.object({
  title:z.string().trim().min(2,"Completați denumirea livrabilului.").max(500),projectId:z.string().min(1,"Selectați sistemul/proiectul."),designer:z.string().trim().min(1,"Selectați proiectantul.").max(150),manager:str,beneficiary:str,module:str,subactivity:str,documentType:str,revision:str,priority:z.enum(priorities),requestedDate:date,startDate:date,dueDate:date,finishedDate:date,progress:z.number().int().min(0).max(100),status:z.enum(statuses),stage:str,sentDate:date,returnedDate:date,returnCount:z.number().int().min(0).max(999),returnReason:str,resentDate:date,approvedDate:date,blockers:str,nextStep:str,notes:str,
  documentUrl:z.string().trim().max(2000).refine(s=>!s || /^https?:\/\//i.test(s),"Linkul trebuie să înceapă cu https:// sau http://.").default("")
});
function db() { if(!env.DB) throw new ApiError(503,"Baza de date nu este disponibilă. Reîncercați."); return env.DB; }
function json(data: unknown, status = 200) { return Response.json(data,{status,headers:{"Cache-Control":"no-store"}}); }
async function seed() {
  const sql = db();
  if (await sql.prepare("SELECT value FROM settings WHERE key='catalog_imported'").first()) return;
  const now = new Date().toISOString();
  await sql.batch([
    ...catalog.projects.map(p=>sql.prepare("INSERT OR IGNORE INTO projects(id,name,designer,manager,status) VALUES(?,?,?,?,?)").bind(p.id,p.name,p.designer,p.manager,p.status)),
    sql.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('catalog_imported',?)").bind(now),
    sql.prepare("INSERT OR IGNORE INTO audit(id,actor,action,created_at) VALUES('initial-import','Sistem',?,?)").bind("Catalogul a fost importat din Excel: 71 de înregistrări. Registrul lucrărilor este pregătit.",now)
  ]);
}
function requireOwner(i: Identity) { if(!managesRegistry(i)) throw new ApiError(403,"Această acțiune este disponibilă șefului secției."); }
function taskRow(row: Record<string,unknown>): Task { return {...JSON.parse(row.data as string),id:Number(row.id),version:Number(row.version),createdAt:row.created_at as string,updatedAt:row.updated_at as string}; }
async function log(i: Identity, action: string, taskId: number|null=null, designer:string|null=null) {
  await db().prepare("INSERT INTO audit(id,task_id,designer,actor,action,created_at) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(),taskId,designer,i.name,action,new Date().toISOString()).run();
}
async function validateTask(value: unknown, old?:Task):Promise<TaskData> {
  const t=taskSchema.parse(value);
  const project=await db().prepare("SELECT id,archived_at FROM projects WHERE id=?").bind(t.projectId).first<{id:string;archived_at:string|null}>();
  if(!project)throw new ApiError(400,"Sistemul selectat nu există.");
  if(project.archived_at&&old?.projectId!==t.projectId)throw new ApiError(400,"Sistemul este arhivat și nu poate primi lucrări noi. Selectați un sistem din portofoliu.");
  const config=await readConfig(db());
  for(const [field,group] of [["documentType","documentTypes"],["beneficiary","beneficiaries"],["stage","stages"]] as const){
    if(t[field] && t[field]!==old?.[field] && !lookupOptions(config,group).includes(t[field]))throw new ApiError(400,"Valoarea selectată nu mai este activă în nomenclator. Reîncărcați formularul.");
  }
  if(t.startDate && t.dueDate && t.dueDate<t.startDate) throw new ApiError(400,"Termenul planificat nu poate fi anterior începerii.");
  if(isClosed(t)) { t.progress=100; t.finishedDate=t.finishedDate||today(); }
  if(t.status==="Aprobată") { t.approvedDate=t.approvedDate||today(); t.stage="Aprobat"; }
  if(t.finishedDate && t.startDate && t.finishedDate<t.startDate) throw new ApiError(400,"Data finalizării nu poate fi anterioară începerii.");
  if(t.status==="Returnată" && old?.status!=="Returnată") { t.returnCount=Math.max(t.returnCount,(old?.returnCount||0)+1); t.returnedDate=t.returnedDate||today(); }
  if(t.status==="În coordonare" && !t.sentDate) t.sentDate=today();
  return t;
}
async function handle(req:Request) {
  try {
    if(req.method!=="GET") {
      const origin=req.headers.get("origin");
      if(origin && origin!==new URL(req.url).origin) throw new ApiError(403,"Originea cererii nu este permisă.");
      if(!req.headers.get("content-type")?.includes("application/json")) throw new ApiError(415,"Este necesar un conținut JSON.");
      if(Number(req.headers.get("content-length")||0)>100000) throw new ApiError(413,"Cererea este prea mare.");
    }
    const path=new URL(req.url).pathname.split("/").filter(Boolean).slice(1);
    if(path[0]==="auth")return await handleAuth(req,path);
    const i=await requireIdentity(req);
    if(i.role==="audit"&&req.method!=="GET")throw new ApiError(403,"Rolul Audit permite numai vizualizarea datelor.");
    await seed();
    if(path[0]==="admin")return await handleAdmin(req,path,i);
    if(path[0]==="projects")return await handlePortfolio(req,path,i);
    const sql=db();
    if(req.method==="GET" && path[0]==="state") {
      const [projectRows,taskRows,memberRows,auditRows,peopleRows]=await Promise.all([
        sql.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE").all(),
        (readsAll(i)?sql.prepare("SELECT * FROM tasks ORDER BY updated_at DESC"):sql.prepare("SELECT * FROM tasks WHERE designer=? ORDER BY updated_at DESC").bind(i.designer)).all(),
        (readsAll(i)?sql.prepare("SELECT email,designer,enabled,id as userId FROM auth_users WHERE role='designer' ORDER BY designer"):sql.prepare("SELECT email,designer,enabled,id as userId FROM auth_users WHERE email=?").bind(i.email.toLowerCase())).all(),
        (readsAll(i)?sql.prepare("SELECT id,task_id as taskId,actor,action,created_at as createdAt FROM audit ORDER BY created_at DESC LIMIT 80"):sql.prepare("SELECT id,task_id as taskId,actor,action,created_at as createdAt FROM audit WHERE designer=? ORDER BY created_at DESC LIMIT 80").bind(i.designer)).all(),
        sql.prepare("SELECT name,role FROM team_people ORDER BY name COLLATE NOCASE").all<{name:string;role:string}>()
      ]);
      const designers=[...new Set([...catalog.designers,...projectRows.results.map(p=>p.designer as string),...memberRows.results.map(m=>m.designer as string),...taskRows.results.map(t=>t.designer as string),...peopleRows.results.filter(p=>p.role==="designer").map(p=>p.name)])].filter(Boolean).sort((a,b)=>a.localeCompare(b,"ro"));
      const managers=[...new Set([...catalog.managers,...projectRows.results.map(p=>p.manager as string),...peopleRows.results.filter(p=>p.role==="manager").map(p=>p.name)])].filter(Boolean).sort((a,b)=>a.localeCompare(b,"ro"));
      return json({projects:projectRows.results.map(projectFromRow),tasks:taskRows.results.map(taskRow),members:memberRows.results,designers,managers,audit:auditRows.results,identity:i,config:await readConfig(sql)});
    }
    if(path[0]==="people" && !path[1] && req.method==="POST") {
      requireOwner(i);
      const p=z.object({
        name:z.string().trim().min(2,"Completați numele și prenumele colegului.").max(150,"Numele este prea lung.").transform(s=>s.replace(/\s+/g," ")),
        role:z.enum(["designer","manager"])
      }).parse(await req.json());
      const key=(name:string)=>name.normalize("NFKC").trim().replace(/\s+/g," ").toLocaleLowerCase("ro-MD");
      const existing=await (p.role==="designer"
        ?sql.prepare("SELECT designer AS name FROM projects UNION SELECT designer AS name FROM tasks UNION SELECT designer AS name FROM members UNION SELECT name FROM team_people WHERE role='designer'")
        :sql.prepare("SELECT manager AS name FROM projects UNION SELECT name FROM team_people WHERE role='manager'")
      ).all<{name:string}>();
      const sourceNames=p.role==="designer"?catalog.designers:catalog.managers;
      const duplicate=()=>new ApiError(409,`Colegul este deja înregistrat ca ${p.role==="designer"?"proiectant":"manager de proiect"}.`);
      if([...sourceNames,...existing.results.map(r=>r.name)].some(name=>key(name)===key(p.name))) throw duplicate();
      const id="person-"+crypto.randomUUID();
      const result=await sql.prepare("INSERT INTO team_people(id,name,role,identity_key,created_at) VALUES(?,?,?,?,?) ON CONFLICT(identity_key) DO NOTHING")
        .bind(id,p.name,p.role,`${p.role}:${key(p.name)}`,new Date().toISOString()).run();
      if(!result.meta.changes) throw duplicate();
      await log(i,`A adăugat în echipă: ${p.name} (${p.role==="designer"?"proiectant":"manager de proiect"}).`);
      return json({id,name:p.name,role:p.role},201);
    }
    if(path[0]==="tasks") {
      const id=Number(path[1]);
      if(req.method==="POST" && !path[1]) {
        const t=await validateTask(await req.json());
        if(!canEdit(i,t)) throw new ApiError(403,"Puteți crea lucrări numai în numele dvs.");
        const now=new Date().toISOString();
        const r=await sql.prepare("INSERT INTO tasks(designer,data,created_at,updated_at) SELECT ?,?,?,? FROM projects WHERE id=? AND archived_at IS NULL").bind(t.designer,JSON.stringify(t),now,now,t.projectId).run();
        if(!r.meta.changes)throw new ApiError(409,"Sistemul a fost arhivat între timp. Reîncărcați portofoliul.");
        const newId=Number(r.meta.last_row_id);
        await log(i,`A creat lucrarea «${t.title}».`,newId,t.designer);
        return json({id:newId},201);
      }
      if(!Number.isSafeInteger(id) || id<1) throw new ApiError(400,"ID lucrare invalid.");
      const row=await sql.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first<Record<string,unknown>>();
      if(!row) throw new ApiError(404,"Lucrarea nu a fost găsită.");
      const old=taskRow(row);
      if(!canEdit(i,old)) throw new ApiError(403,"Puteți actualiza numai propriile lucrări.");
      const body=await req.json() as Record<string,unknown>;
      if(body.version!==old.version) throw new ApiError(409,"Lucrarea a fost modificată de alt utilizator. Reîncărcați datele și redeschideți lucrarea.");
      if(req.method==="PATCH") {
        const t=await validateTask(body,old);
        if(!canEdit(i,t)) throw new ApiError(403,"Reatribuirea lucrării este disponibilă șefului secției.");
        const result=await sql.prepare("UPDATE tasks SET designer=?,data=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND (?=? OR EXISTS(SELECT 1 FROM projects WHERE id=? AND archived_at IS NULL))").bind(t.designer,JSON.stringify(t),new Date().toISOString(),id,body.version,t.projectId,old.projectId,t.projectId).run();
        if(!result.meta.changes) throw new ApiError(409,"Lucrarea a fost modificată între timp. Reîncărcați datele.");
        await log(i,old.status!==t.status?`A schimbat starea lucrării «${t.title}»: ${old.status} → ${t.status}.`:`A actualizat lucrarea «${t.title}» (${t.progress}%).`,id,t.designer);
        return json({ok:true});
      }
      if(req.method==="DELETE") {
        requireOwner(i);
        const result=await sql.prepare("DELETE FROM tasks WHERE id=? AND version=?").bind(id,body.version).run();
        if(!result.meta.changes) throw new ApiError(409,"Lucrarea a fost modificată între timp.");
        await log(i,`A șters lucrarea «${old.title}».`,id,old.designer);
        return json({ok:true});
      }
    }
    if(path[0]==="members")throw new ApiError(410,"Conturile se gestionează acum în Administrare → Utilizatori.");
    throw new ApiError(404,"Operațiunea nu a fost găsită.");
  } catch(e) {
    if(e instanceof z.ZodError) return json({error:e.issues[0]?.message||"Verificați câmpurile completate."},400);
    if(e instanceof ApiError) return json({error:e.message},e.status);
    if(e instanceof SyntaxError) return json({error:"Conținutul cererii nu este valid."},400);
    console.error("Registry operation failed",e instanceof Error ? e.name : "UnknownError");
    return json({error:"Operațiunea nu a putut fi efectuată. Reîncercați; datele din formular au fost păstrate."},500);
  }
}
export {handle as GET,handle as POST,handle as PATCH,handle as DELETE};
