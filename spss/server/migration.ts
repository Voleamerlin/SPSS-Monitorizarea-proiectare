import {z} from "zod";
import {randomUUID} from "node:crypto";
import {type Storage} from "./storage.js";
import {configSchema} from "../lib/server-admin.js";
import {taskSchema} from "./api.js";
const text=z.string(),integer=z.number().int(),iso=z.string().datetime(),nullableISO=iso.nullable();
const project=z.object({id:text.min(1),name:text.min(2).max(500),designer:text,manager:text,status:z.enum(["Activ","Inactiv"]),version:integer.positive(),name_key:text.nullable(),archived_at:nullableISO,archived_by:text.nullable(),archive_reason:text,created_at:nullableISO,updated_at:nullableISO,last_change_id:text}).strict();
const work=z.object({id:integer.positive(),designer:text,data:text,version:integer.positive(),created_at:iso,updated_at:iso}).strict();
const person=z.object({id:text,name:text,role:z.enum(["designer","manager"]),identity_key:text,created_at:iso}).strict();
const member=z.object({email:text,user_id:text.nullable(),designer:text,enabled:z.union([z.literal(0),z.literal(1)])}).strict();
const event=z.object({id:text,task_id:integer.nullable(),designer:text.nullable(),actor:text,action:text,created_at:iso}).strict();
const history=z.object({id:text,project_id:text,actor:text,action:text,before_data:text.nullable(),after_data:text,created_at:iso}).strict();
const account=z.object({id:text,email:z.string().email(),name:text,role:z.enum(["admin","owner","designer","audit"]),designer:text,enabled:z.union([z.literal(0),z.literal(1)]),password_hash:z.string().regex(/^pbkdf2-sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}$/).nullable(),temporary_hash:z.null(),temporary_expires:z.null(),auth_version:integer.positive(),created_at:iso,last_login_at:nullableISO}).strict();
const schemas={settings:z.object({key:z.enum(["app_config","catalog_imported"]),value:text}).strict(),projects:project,tasks:work,team_people:person,members:member,audit:event,project_history:history,auth_users:account};
export function importSnapshot(db:Storage,input:unknown){
 const base=z.object({format:z.literal("ctif-spss-migration-v1"),complete:z.literal(true),exportedAt:iso,tables:z.object(Object.fromEntries(Object.keys(schemas).map(k=>[k,z.array(z.unknown())])) as {[K in keyof typeof schemas]:z.ZodArray<z.ZodUnknown>}).strict()}).parse(input);
 const tables=Object.fromEntries(Object.entries(schemas).map(([name,schema])=>[name,base.tables[name as keyof typeof schemas].map(row=>schema.parse(row))])) as unknown as Record<keyof typeof schemas,Record<string,unknown>[]>;
 const config=tables.settings.find(r=>r.key==="app_config");if(!config)throw new Error("Snapshotul trebuie să conțină configurația completă. Exportați din Administrare → Export pentru migrare.");configSchema.parse(JSON.parse(String(config.value)));
 const projects=new Set(tables.projects.map(p=>p.id)),tasks=new Set(tables.tasks.map(t=>t.id));
 for(const row of tables.tasks){const data=taskSchema.parse(JSON.parse(String(row.data)));if(!projects.has(data.projectId)||data.designer!==row.designer)throw new Error("Legătura sistem–lucrare sau proiectantul nu este valid.");}
 for(const row of tables.project_history){if(!projects.has(row.project_id))throw new Error("Istoric fără sistem asociat.");if(row.before_data)JSON.parse(String(row.before_data));JSON.parse(String(row.after_data));}
 for(const row of tables.audit)if(row.task_id!==null&&!tasks.has(row.task_id)){/* Audit may refer to a deliberately deleted work. */}
 db.raw.exec("BEGIN IMMEDIATE");
 try{
  for(const name of ["projects","tasks","team_people","auth_users","audit","project_history","members"])if(Number(db.raw.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n)>0)throw new Error("Importul necesită o bază de date fără înregistrări. Utilizați o bază nouă; datele existente nu sunt suprascrise.");
  if(db.raw.prepare("SELECT key FROM settings WHERE key='app_config'").get())throw new Error("Configurația destinației există deja. Utilizați o bază nouă.");
  for(const [name,rows]of Object.entries(tables))for(const row of rows){const keys=Object.keys(row);db.raw.prepare(`INSERT INTO ${name} (${keys.map(k=>'"'+k+'"').join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(row) as (string|number|null)[]);}
  if(!tables.settings.some(r=>r.key==="catalog_imported"))db.raw.prepare("INSERT INTO settings VALUES('catalog_imported',?)").run(base.exportedAt);
  db.raw.prepare("INSERT INTO audit(id,actor,action,created_at) VALUES(?,?,?,?)").run(randomUUID(),"Migrare","A importat snapshotul validat pe serverul propriu; sesiunile nu au fost transferate.",new Date().toISOString());
  db.raw.exec("COMMIT");return Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,rows.length]));
 }catch(e){db.raw.exec("ROLLBACK");throw e;}
}
