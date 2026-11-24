import {DatabaseSync,type SQLInputValue} from "node:sqlite";
import {readFileSync,readdirSync,mkdirSync,chmodSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {createHash} from "node:crypto";

type Row=Record<string,unknown>;
export class Statement {
 constructor(public owner:Storage,public sql:string,public values:SQLInputValue[]=[]){ }
 bind(...values:unknown[]){return new Statement(this.owner,this.sql,values.map(v=>{if(v===undefined)throw new Error("Undefined SQL value");return v as SQLInputValue;}));}
 async first<T=Row>(column?:string):Promise<T|null>{const row=this.owner.raw.prepare(this.sql).get(...this.values);return (column?row?.[column]:row) as T??null;}
 async all<T=Row>(){return {results:this.owner.raw.prepare(this.sql).all(...this.values) as T[],success:true};}
 execute(){if(/^\s*SELECT\b/i.test(this.sql))return {success:true,results:this.owner.raw.prepare(this.sql).all(...this.values),meta:{changes:0,last_row_id:0}};const r=this.owner.raw.prepare(this.sql).run(...this.values);return {success:true,results:[],meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
 async run(){return this.execute();}
}
export class Storage {
 raw:DatabaseSync;
 constructor(public filename:string,options:{migrate?:boolean;directory?:string}={}){
  if(filename!==":memory:"){mkdirSync(dirname(resolve(filename)),{recursive:true});}
  this.raw=new DatabaseSync(filename);this.raw.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
  if(filename!==":memory:")try{chmodSync(filename,0o600);}catch{/* ACLs are managed by the Windows installer. */}
  try{if(options.migrate!==false)this.migrate(options.directory||resolve("drizzle"));}catch(e){this.raw.close();throw e;}
 }
 prepare(sql:string){return new Statement(this,sql);}
 async batch(statements:Statement[]){
  if(statements.some(s=>s.owner!==this))throw new Error("Statements must use one database");
  this.raw.exec("BEGIN IMMEDIATE");
  try{const r=statements.map(s=>s.execute());this.raw.exec("COMMIT");return r;}catch(e){this.raw.exec("ROLLBACK");throw e;}
 }
 migrate(directory:string){
  this.raw.exec("CREATE TABLE IF NOT EXISTS _spss_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)");
  for(const file of readdirSync(directory).filter(s=>s.endsWith(".sql")).sort()){
   const text=readFileSync(resolve(directory,file),"utf8"),sha=createHash("sha256").update(text).digest("hex"),old=this.raw.prepare("SELECT sha256 FROM _spss_migrations WHERE name=?").get(file);
   if(old){if(old.sha256!==sha)throw new Error("Migration checksum mismatch: "+file);continue;}
   this.raw.exec("BEGIN IMMEDIATE");
   try{this.raw.exec(text);this.raw.prepare("INSERT INTO _spss_migrations VALUES(?,?,?)").run(file,sha,new Date().toISOString());this.raw.exec("COMMIT");}catch(e){this.raw.exec("ROLLBACK");throw e;}
  }
 }
 close(){this.raw.close();}
}
