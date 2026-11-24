import {randomUUID} from "node:crypto";
import {z} from "zod";
import {type Storage} from "./storage.js";
import {hashPassword,newPassword} from "../lib/server-auth.js";
export async function provision(db:Storage,body:{email:string;name:string;password:string;recover?:boolean}){
 const email=z.string().trim().email().max(254).parse(body.email).toLowerCase(),name=z.string().trim().min(2).max(150).parse(body.name),hash=await hashPassword(newPassword.parse(body.password)),now=new Date().toISOString();
 db.raw.exec("BEGIN IMMEDIATE");
 try{
  const old=db.raw.prepare("SELECT * FROM auth_users WHERE email=?").get(email);
  if(body.recover){if(!old||old.role!=="admin")throw new Error("Recuperarea necesită emailul unui Administrator existent.");db.raw.prepare("UPDATE auth_users SET password_hash=?,temporary_hash=NULL,temporary_expires=NULL,enabled=1,auth_version=auth_version+1 WHERE id=?").run(hash,old.id);db.raw.prepare("DELETE FROM auth_sessions WHERE user_id=?").run(old.id);}
  else{if(db.raw.prepare("SELECT id FROM auth_users WHERE role='admin' AND enabled=1 AND password_hash IS NOT NULL").get())throw new Error("Există deja un Administrator cu parolă personală. Utilizați contul existent sau opțiunea --recover.");if(old){if(old.role!=="admin")throw new Error("Emailul aparține altui rol.");db.raw.prepare("UPDATE auth_users SET name=?,password_hash=?,temporary_hash=NULL,temporary_expires=NULL,enabled=1,auth_version=auth_version+1 WHERE id=?").run(name,hash,old.id);}else db.raw.prepare("INSERT INTO auth_users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,'admin',?,?)").run(randomUUID(),email,name,hash,now);}
  db.raw.prepare("INSERT INTO audit(id,actor,action,created_at) VALUES(?,?,?,?)").run(randomUUID(),name,body.recover?"A recuperat local accesul de Administrator; sesiunile au fost revocate.":"A configurat local Administratorul pentru serverul propriu.",now);
  db.raw.exec("COMMIT");return {email};
 }catch(e){db.raw.exec("ROLLBACK");throw e;}
}
