import {z} from "zod";
import catalog from "../data/catalog.json" with {type:"json"};
import {ApiError,database,json} from "./server-auth.js";
import {managesRegistry,readsAll,type Identity,type Project,type ProjectHistory} from "./model.js";

type Row=Record<string,unknown>;
export function projectFromRow(r:Row):Project{return {id:String(r.id),name:String(r.name),designer:String(r.designer||""),manager:String(r.manager||""),status:r.status as Project["status"],version:Number(r.version),archivedAt:r.archived_at as string|null,archivedBy:r.archived_by as string|null,archiveReason:String(r.archive_reason||""),createdAt:r.created_at as string|null,updatedAt:r.updated_at as string|null};}
const normalized=(s:string)=>s.normalize("NFKC").trim().replace(/\s+/g," ").toLocaleLowerCase("ro-MD");
const person=z.string().trim().max(150);
const projectSchema=z.object({name:z.string().trim().min(2,"Completați denumirea sistemului.").max(500).transform(s=>s.replace(/\s+/g," ")),designer:person,manager:person,status:z.enum(["Activ","Inactiv"]),version:z.number().int().positive().optional()});
async function personExists(role:"designer"|"manager",name:string){
  if(!name)return true;
  if((role==="designer"?catalog.designers:catalog.managers).includes(name))return true;
  const query=role==="designer"?"SELECT name FROM team_people WHERE role='designer' AND name=? UNION SELECT designer AS name FROM projects WHERE designer=? UNION SELECT designer AS name FROM tasks WHERE designer=?":"SELECT name FROM team_people WHERE role='manager' AND name=? UNION SELECT manager AS name FROM projects WHERE manager=?";
  return !!await database().prepare(query).bind(...(role==="designer"?[name,name,name]:[name,name])).first();
}
async function validatePeople(value:{designer?:string;manager?:string},old?:Project){
  for(const role of ["designer","manager"] as const)if(value[role]!==undefined&&value[role]!==old?.[role]&&!await personExists(role,value[role]!))throw new ApiError(400,`Selectați un ${role==="designer"?"proiectant":"manager de proiect"} existent în echipă sau lăsați câmpul neatribuit.`);
}
async function uniqueName(name:string,id?:string){const rows=await database().prepare("SELECT id,name FROM projects").all<{id:string;name:string}>();if(rows.results.some(r=>r.id!==id&&normalized(r.name)===normalized(name)))throw new ApiError(409,"Există deja un sistem cu această denumire, inclusiv în arhivă. Verificați înregistrarea existentă.");}
function changeStatements(i:Identity,before:Project|null,after:Project,changeId:string,action:string){
  const sql=database(),now=after.updatedAt!;
  return [
    sql.prepare("INSERT INTO project_history(id,project_id,actor,action,before_data,after_data,created_at) SELECT ?,?,?,?,?,?,? FROM projects WHERE id=? AND last_change_id=?")
      .bind(crypto.randomUUID(),after.id,i.name,action,before?JSON.stringify(before):null,JSON.stringify(after),now,after.id,changeId),
    sql.prepare("INSERT INTO audit(id,actor,action,created_at) SELECT ?,?,?,? FROM projects WHERE id=? AND last_change_id=?")
      .bind(crypto.randomUUID(),i.name,`${action}: «${after.name}».`,now,after.id,changeId)
  ];
}
async function handle(req:Request,path:string[],i:Identity):Promise<Response>{
  const sql=database(),id=path[1];
  if(req.method==="GET"&&id){
    const raw=await sql.prepare("SELECT * FROM projects WHERE id=?").bind(id).first<Row>();if(!raw)throw new ApiError(404,"Sistemul nu a fost găsit.");
    if(path[2]==="history"){
      const offset=z.coerce.number().int().min(0).max(100000).parse(new URL(req.url).searchParams.get("offset")||0);
      const rows=await sql.prepare("SELECT * FROM project_history WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?").bind(id,offset).all<Row>();
      const count=await sql.prepare("SELECT count(*) AS total FROM project_history WHERE project_id=?").bind(id).first<{total:number}>();
      const items:ProjectHistory[]=rows.results.map(r=>({id:String(r.id),projectId:id,actor:String(r.actor),action:String(r.action),before:r.before_data?JSON.parse(String(r.before_data)):null,after:JSON.parse(String(r.after_data)),createdAt:String(r.created_at)}));
      const total=Number(count?.total||0);return json({items,total,nextOffset:offset+items.length<total?offset+items.length:null});
    }
    const stats=await (readsAll(i)?sql.prepare("SELECT data FROM tasks WHERE json_extract(data,'$.projectId')=?").bind(id):sql.prepare("SELECT data FROM tasks WHERE json_extract(data,'$.projectId')=? AND designer=?").bind(id,i.designer)).all<{data:string}>();
    return json({project:projectFromRow(raw),totalWorks:stats.results.length,openWorks:stats.results.filter(r=>!["Finalizată","Aprobată"].includes(JSON.parse(r.data).status)).length});
  }
  if(!managesRegistry(i))throw new ApiError(403,"Nu aveți dreptul de a modifica portofoliul sistemelor.");
  if(id==="bulk"&&req.method==="PATCH"){
    if(i.role!=="admin")throw new ApiError(403,"Actualizarea în masă este disponibilă Administratorului.");
    const ref=z.object({id:z.string().min(1).max(100),version:z.number().int().positive()});
    const body=z.object({projects:z.array(ref).min(1).max(25).refine(a=>new Set(a.map(p=>p.id)).size===a.length,"Selectați înregistrări distincte."),changes:z.object({designer:person.optional(),manager:person.optional(),status:z.enum(["Activ","Inactiv"]).optional()}).refine(p=>Object.keys(p).length>0,"Selectați cel puțin o modificare.")}).parse(await req.json());
    await validatePeople(body.changes);
    const raw=await sql.prepare("SELECT * FROM projects WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))").bind(JSON.stringify(body.projects)).all<Row>();
    const old=raw.results.map(projectFromRow);
    if(old.length!==body.projects.length||old.some(p=>p.archivedAt||body.projects.find(r=>r.id===p.id)?.version!==p.version))throw new ApiError(409,"Unele înregistrări au fost modificate sau arhivate. Reîncărcați portofoliul și selectați din nou.");
    const changeId=crypto.randomUUID(),now=new Date().toISOString(),refs=JSON.stringify(body.projects),c=body.changes;
    const update=sql.prepare("UPDATE projects SET designer=CASE WHEN ? THEN ? ELSE designer END,manager=CASE WHEN ? THEN ? ELSE manager END,status=CASE WHEN ? THEN ? ELSE status END,updated_at=?,last_change_id=?,version=version+1 WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND archived_at IS NULL AND (SELECT count(*) FROM projects p JOIN json_each(?) wanted ON p.id=json_extract(wanted.value,'$.id') WHERE p.version=json_extract(wanted.value,'$.version') AND p.archived_at IS NULL)=?")
      .bind(Number(c.designer!==undefined),c.designer||"",Number(c.manager!==undefined),c.manager||"",Number(c.status!==undefined),c.status||"",now,changeId,refs,refs,body.projects.length);
    const events=old.flatMap(p=>changeStatements(i,p,{...p,...c,version:p.version+1,updatedAt:now},changeId,"A actualizat în masă sistemul"));
    const result=await sql.batch([update,...events]);
    if(Number(result[0].meta.changes)!==body.projects.length)throw new ApiError(409,"Portofoliul a fost modificat între timp. Nu a fost aplicată nicio modificare.");
    return json({ok:true,count:old.length});
  }
  if(!id&&req.method==="POST"){
    const p=projectSchema.parse(await req.json());await validatePeople(p);await uniqueName(p.name);
    const now=new Date().toISOString(),changeId=crypto.randomUUID(),after:Project={id:"p-"+crypto.randomUUID(),name:p.name,designer:p.designer,manager:p.manager,status:p.status,version:1,archivedAt:null,archivedBy:null,archiveReason:"",createdAt:now,updatedAt:now};
    await sql.batch([
      sql.prepare("INSERT INTO projects(id,name,designer,manager,status,version,name_key,created_at,updated_at,last_change_id) VALUES(?,?,?,?,?,1,?,?,?,?)").bind(after.id,p.name,p.designer,p.manager,p.status,normalized(p.name),now,now,changeId),
      ...changeStatements(i,null,after,changeId,"A adăugat sistemul")
    ]);return json({project:after},201);
  }
  const raw=id?await sql.prepare("SELECT * FROM projects WHERE id=?").bind(id).first<Row>():null;
  if(!raw)throw new ApiError(404,"Sistemul nu a fost găsit.");
  const before=projectFromRow(raw),changeId=crypto.randomUUID(),now=new Date().toISOString();
  if((path[2]==="archive"||path[2]==="restore")&&req.method==="POST"){
    if(i.role!=="admin")throw new ApiError(403,"Arhivarea și restaurarea sunt disponibile Administratorului.");
    const body=z.object({version:z.number().int().positive(),reason:z.string().trim().max(2000).default("")}).parse(await req.json());
    if(body.version!==before.version)throw new ApiError(409,"Sistemul a fost modificat între timp. Reîncărcați fișa.");
    const archive=path[2]==="archive";
    if(archive===!!before.archivedAt)throw new ApiError(409,archive?"Sistemul este deja arhivat.":"Sistemul nu este arhivat.");
    const after:Project={...before,version:before.version+1,archivedAt:archive?now:null,archivedBy:archive?i.name:null,archiveReason:archive?body.reason:"",updatedAt:now};
    const result=await sql.batch([
      sql.prepare("UPDATE projects SET archived_at=?,archived_by=?,archive_reason=?,updated_at=?,last_change_id=?,version=version+1 WHERE id=? AND version=?").bind(after.archivedAt,after.archivedBy,after.archiveReason,now,changeId,id,body.version),
      ...changeStatements(i,before,after,changeId,archive?"A arhivat sistemul":"A restaurat sistemul")
    ]);if(!result[0].meta.changes)throw new ApiError(409,"Sistemul a fost modificat între timp.");
    return json({project:after});
  }
  if(req.method==="PATCH"&&!path[2]){
    if(before.archivedAt)throw new ApiError(409,"Restaurați sistemul înainte de a modifica datele sale.");
    const p=projectSchema.parse(await req.json());if(p.version!==before.version)throw new ApiError(409,"Sistemul a fost modificat între timp. Reîncărcați fișa.");
    await validatePeople(p,before);if(p.name!==before.name)await uniqueName(p.name,id);
    const after:Project={...before,name:p.name,designer:p.designer,manager:p.manager,status:p.status,version:before.version+1,updatedAt:now};
    const result=await sql.batch([
      sql.prepare("UPDATE projects SET name=?,name_key=?,designer=?,manager=?,status=?,updated_at=?,last_change_id=?,version=version+1 WHERE id=? AND version=? AND archived_at IS NULL").bind(p.name,p.name===before.name?raw.name_key??null:normalized(p.name),p.designer,p.manager,p.status,now,changeId,id,p.version),
      ...changeStatements(i,before,after,changeId,"A actualizat sistemul")
    ]);if(!result[0].meta.changes)throw new ApiError(409,"Sistemul a fost modificat între timp. Datele introduse au fost păstrate.");
    return json({project:after});
  }
  throw new ApiError(404,"Operațiunea asupra portofoliului nu a fost găsită.");
}
export async function handlePortfolio(req:Request,path:string[],i:Identity){try{return await handle(req,path,i);}catch(e){if(e instanceof Error&&/UNIQUE constraint failed: projects\.name_key/i.test(e.message))throw new ApiError(409,"Există deja un sistem cu această denumire.");throw e;}}
