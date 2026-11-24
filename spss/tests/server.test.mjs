import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {blankTask} from '../dist/server/lib/model.js';
const temp=mkdtempSync(join(tmpdir(),'spss-selfhost-'));
process.env.SPSS_DB_PATH=join(temp,'source.sqlite');process.env.APP_ORIGIN='https://spss.example.test';process.env.ALLOW_INSECURE_LOCAL_HTTP='false';
const {env}=await import('../dist/server/server/runtime.js');
const {createApplication,validateOrigin}=await import('../dist/server/server/main.js');
const {provision}=await import('../dist/server/server/provision.js');
const {Storage}=await import('../dist/server/server/storage.js');
const {importSnapshot}=await import('../dist/server/server/migration.js');
const server=createApplication();server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
let admin,designer,auditor,head,ownId,otherId,projectA,projectB,snapshot;const accounts={},adminPassword='Synthetic selfhost admin password 2049';
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));env.DB.close();rmSync(temp,{recursive:true,force:true});});
async function call(path,method='GET',body,cookie=admin,extra={}){const r=await fetch(base+'/api/'+path,{method,headers:{...(cookie?{cookie}:{}),...(method!=='GET'?{'content-type':'application/json',origin:process.env.APP_ORIGIN}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],rawCookie:r.headers.get('set-cookie')};}
async function login(email,password){const r=await call('auth/login','POST',{email,password},null);assert.equal(r.status,200,JSON.stringify(r.body));return r;}
async function user(role,name,email,assigned=''){const c=await call('admin/users','POST',{role,name,email,designer:assigned,enabled:true});assert.equal(c.status,201);let u=(await call('admin/overview')).body.users.find(v=>v.id===c.body.id);const tempPass='Synthetic temporary '+role+' password 2049';assert.equal((await call('admin/users/'+u.id+'/password','POST',{password:tempPass,confirmPassword:tempPass,authVersion:u.authVersion})).status,200);const entry=await login(email,tempPass);assert.equal((await call('state','GET',null,entry.cookie)).status,428);const password='Synthetic personal '+role+' password 2049';const changed=await call('auth/change-password','POST',{password},entry.cookie);assert.equal(changed.status,200);accounts[role]={id:u.id,email,password};return changed.cookie;}
async function p(id){const r=await call('projects/'+id);assert.equal(r.status,200);return r.body.project;}

test('standalone entrypoint serves built assets and security headers without exposing server files',async()=>{
 const r=await fetch(base);assert.equal(r.status,200);const html=await r.text();assert.ok(html.includes('SPSS'));assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);assert.equal(r.headers.get('x-frame-options'),'DENY');assert.ok(r.headers.get('strict-transport-security'));
 const asset=html.match(/src="([^"]+\.js)"/)[1];assert.equal((await fetch(base+asset)).status,200);assert.match((await fetch(base+asset)).headers.get('cache-control'),/immutable/);
 for(const path of ['/.env','/server/main.ts','/drizzle/0000_faithful_nebula.sql','/node_modules/zod/package.json','/..%2F.env'])assert.equal((await fetch(base+path)).status,404,path);
 assert.equal((await fetch(base+'/healthz')).status,200);assert.throws(()=>validateOrigin('http://remote.example.test',true));assert.throws(()=>validateOrigin('https://spss.example.test/sub'));assert.throws(()=>validateOrigin(undefined));assert.throws(()=>validateOrigin('https://spss.example.test',true));
});
test('public requests cannot bootstrap ownership or forge platform identity; CSRF is enforced',async()=>{
 assert.equal((await call('state','GET',null,null)).status,401);assert.equal((await call('auth/bootstrap','POST',{},null,{'oai-authenticated-user-email':'owner@example.test','oai-authenticated-user-id':'owner'})).status,403);
 assert.equal((await call('auth/status','GET',null,null)).body.bootstrapAvailable,false);
 assert.equal((await call('auth/login','POST',{email:'nobody@example.test',password:'synthetic'},null,{origin:'https://evil.example.test'})).status,403);
 const missing=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(missing.status,403);
});
test('initial administrator is provisioned locally and uses protected opaque sessions',async()=>{
 await provision(env.DB,{email:'owner@example.test',name:'Local Administrator',password:adminPassword});const result=await login('owner@example.test',adminPassword);admin=result.cookie;
 assert.match(result.rawCookie,/__Host-spss-session=[a-f0-9]{64}/);for(const flag of ['Secure','HttpOnly','SameSite=Strict'])assert.ok(result.rawCookie.includes(flag));
 await assert.rejects(provision(env.DB,{email:'another@example.test',name:'Another admin',password:adminPassword}),/Există deja/);
 const state=(await call('state')).body;assert.equal(state.identity.role,'admin');assert.equal(state.projects.length,3);assert.ok((await call('admin/export')).body.tables.settings.some(s=>s.key==='app_config'));
 assert.ok(env.DB.raw.prepare("SELECT password_hash FROM auth_users WHERE email='owner@example.test'").get().password_hash.startsWith('pbkdf2-sha256$600000$'));
});
test('all four roles authenticate with single-use temporary passwords and personal password changes',async()=>{
 designer=await user('designer','Proiectant Demo A','designer@example.test','Proiectant Demo A');auditor=await user('audit','Auditor','audit@example.test');head=await user('owner','Head','head@example.test');
 for(const [cookie,role]of [[designer,'designer'],[auditor,'audit'],[head,'owner']])assert.equal((await call('state','GET',null,cookie)).body.identity.role,role);
});
test('own-work authorization and registry rules are preserved on SQLite',async()=>{
 const own={...blankTask('Proiectant Demo A'),projectId:'p-003',title:'Portable own work',dueDate:'2026-12-10'},other={...own,designer:'Proiectant Demo B',title:'Portable other work'};
 const a=await call('tasks','POST',own,designer);assert.equal(a.status,201);ownId=a.body.id;const b=await call('tasks','POST',other);assert.equal(b.status,201);otherId=b.body.id;
 assert.equal((await call('state','GET',null,designer)).body.tasks.length,1);assert.equal((await call('state','GET',null,auditor)).body.tasks.length,2);
 assert.equal((await call('tasks/'+otherId,'PATCH',{...other,version:1},designer)).status,403);
 assert.equal((await call('tasks/'+ownId,'PATCH',{...own,status:'Returnată',version:1},designer)).status,200);assert.equal((await call('tasks/'+ownId,'PATCH',{...own,version:1},designer)).status,409);
 const saved=(await call('state')).body.tasks.find(t=>t.id===ownId);assert.equal(saved.returnCount,1);assert.ok(saved.returnedDate);
});
test('Audit consults all compartments but cannot mutate records or export credential hashes',async()=>{
 const overview=await call('admin/overview','GET',null,auditor);assert.equal(overview.status,200);assert.equal(overview.body.users.length,4);assert.ok(!JSON.stringify(overview.body).includes('password_hash'));
 const before=env.DB.raw.prepare('SELECT count(*) AS n FROM audit').get().n;
 for(const [path,method]of [['tasks','POST'],['tasks/'+ownId,'PATCH'],['tasks/'+ownId,'DELETE'],['projects','POST'],['projects/p-003','PATCH'],['projects/p-003/archive','POST'],['projects/bulk','PATCH'],['people','POST'],['admin/users','POST'],['admin/config','PATCH'],['admin/users/'+accounts.designer.id+'/password','POST']])assert.equal((await call(path,method,{},auditor)).status,403,path);
 assert.equal((await call('admin/export','GET',null,auditor)).status,403);assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM audit').get().n,before);
});
test('portfolio supports atomic bulk changes, archive and restore while retaining work associations',async()=>{
 const body={name:'Portable portfolio A',designer:'Proiectant Demo A',manager:'',status:'Activ'},a=await call('projects','POST',body);assert.equal(a.status,201);projectA=a.body.project;
 const b=await call('projects','POST',{...body,name:'Portable portfolio B'});assert.equal(b.status,201);projectB=b.body.project;
 assert.equal((await call('projects','POST',{...body,name:'PORTABLE  PORTFOLIO A'})).status,409);
 const refs=[projectA,projectB].map(({id,version})=>({id,version}));assert.equal((await call('projects/bulk','PATCH',{projects:[refs[0],{...refs[1],version:7}],changes:{status:'Inactiv'}})).status,409);assert.equal((await p(projectA.id)).status,'Activ');
 assert.equal((await call('projects/bulk','PATCH',{projects:refs,changes:{status:'Inactiv'}})).status,200);projectA=await p(projectA.id);projectB=await p(projectB.id);
 const task=(await call('state')).body.tasks.find(t=>t.id===ownId);assert.equal((await call('tasks/'+ownId,'PATCH',{...task,projectId:projectA.id},designer)).status,200);
 assert.equal((await call('projects/'+projectA.id+'/archive','POST',{version:projectA.version},head)).status,403);const archived=await call('projects/'+projectA.id+'/archive','POST',{version:projectA.version,reason:'Test'});assert.equal(archived.status,200);projectA=archived.body.project;
 assert.equal((await call('tasks','POST',{...blankTask('Proiectant Demo A'),title:'Blocked new work',projectId:projectA.id},designer)).status,400);
 const retained=(await call('state')).body.tasks.find(t=>t.id===ownId);assert.equal((await call('tasks/'+ownId,'PATCH',{...retained,notes:'Still editable'},designer)).status,200);
 const restored=await call('projects/'+projectA.id+'/restore','POST',{version:projectA.version});assert.equal(restored.status,200);projectA=restored.body.project;assert.equal(projectA.status,'Inactiv');
 assert.ok((await call('projects/'+projectA.id+'/history','GET',null,auditor)).body.items.some(h=>h.action==='A arhivat sistemul'));
});
test('complete protected migration export preserves configuration and excludes live sessions and temporary credentials',async()=>{
 const config=(await call('admin/overview')).body.config;assert.equal((await call('admin/config','PATCH',{...config,warningDays:14})).status,200);
 const exported=await call('admin/export');assert.equal(exported.status,200);snapshot=exported.body;assert.equal(snapshot.complete,true);assert.equal(snapshot.tables.projects.length,5);assert.equal(snapshot.tables.tasks.length,2);
 assert.equal(JSON.parse(snapshot.tables.settings.find(s=>s.key==='app_config').value).warningDays,14);assert.ok(!snapshot.tables.settings.some(s=>s.key==='owner_user_id'));
 assert.equal(snapshot.tables.auth_sessions,undefined);for(const u of snapshot.tables.auth_users){assert.equal(u.temporary_hash,null);assert.equal(u.temporary_expires,null);}
});
test('snapshot import validates all data and refuses partial snapshots and overwrites',async()=>{
 const target=new Storage(join(temp,'import.sqlite'));
 try{
  assert.throws(()=>importSnapshot(target,{...snapshot,complete:false}));assert.equal(target.raw.prepare('SELECT count(*) AS n FROM projects').get().n,0);
  const broken=structuredClone(snapshot);broken.tables.tasks[0].data=JSON.stringify({...JSON.parse(broken.tables.tasks[0].data),projectId:'missing'});assert.throws(()=>importSnapshot(target,broken),/Legătura/);assert.equal(target.raw.prepare('SELECT count(*) AS n FROM projects').get().n,0);
  const counts=importSnapshot(target,snapshot);assert.equal(counts.projects,5);assert.equal(counts.tasks,2);assert.equal(counts.auth_users,4);assert.equal(target.raw.prepare('SELECT count(*) AS n FROM auth_sessions').get().n,0);
  assert.equal(target.raw.prepare("SELECT password_hash FROM auth_users WHERE email='owner@example.test'").get().password_hash,snapshot.tables.auth_users.find(u=>u.email==='owner@example.test').password_hash);
  assert.throws(()=>importSnapshot(target,snapshot),/fără înregistrări/);
 }finally{target.close();}
});
test('an imported database authenticates the same personal password after starting a separate server process',async()=>{
 const child=spawn(process.execPath,['--input-type=module','-e',`import {createApplication} from './dist/server/server/main.js';import {env} from './dist/server/server/runtime.js';const app=createApplication();app.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:app.address().port})));process.on('SIGTERM',()=>app.close(()=>{env.DB.close();process.exit(0)}));`],{cwd:process.cwd(),env:{...process.env,SPSS_DB_PATH:join(temp,'import.sqlite')},stdio:['ignore','pipe','pipe']});
 let ready;try{ready=await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(new Error('Server startup timeout')),10000);child.stdout.on('data',data=>{output+=data;try{const r=JSON.parse(output.trim());clearTimeout(timeout);resolve(r);}catch{}});child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Server exited '+code));});});const local='http://127.0.0.1:'+ready.port;const login=await fetch(local+'/api/auth/login',{method:'POST',headers:{origin:process.env.APP_ORIGIN,'content-type':'application/json'},body:JSON.stringify({email:'owner@example.test',password:adminPassword})});assert.equal(login.status,200);const state=await fetch(local+'/api/state',{headers:{cookie:login.headers.get('set-cookie').split(';')[0]}});const data=await state.json();assert.equal(data.tasks.length,2);assert.equal(data.projects.length,5);assert.equal(data.config.warningDays,14);}finally{child.kill('SIGTERM');await once(child,'exit');}
});
test('online backup is consistent and offline restoration revokes sessions',async()=>{
 const backupFile=join(temp,'verified-backup.sqlite');const backup=spawnSync(process.execPath,['scripts/backup.mjs',backupFile],{cwd:process.cwd(),env:process.env,encoding:'utf8'});assert.equal(backup.status,0,backup.stderr);const check=new DatabaseSync(backupFile,{readOnly:true});assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(check.prepare('SELECT count(*) AS n FROM tasks').get().n,2);check.close();
 const restore=spawnSync(process.execPath,['scripts/restore.mjs',backupFile,'--server-stopped'],{cwd:process.cwd(),env:{...process.env,SPSS_DB_PATH:join(temp,'import.sqlite')},encoding:'utf8'});assert.equal(restore.status,0,restore.stderr);const restored=new DatabaseSync(join(temp,'import.sqlite'));assert.equal(restored.prepare('SELECT count(*) AS n FROM auth_sessions').get().n,0);restored.close();
});
test('failed storage transactions roll back every update and migration hashes detect altered SQL',async()=>{
 const db=new Storage(join(temp,'atomic.sqlite'));await db.prepare("INSERT INTO settings VALUES('test','before')").run();await assert.rejects(db.batch([db.prepare("UPDATE settings SET value='after' WHERE key='test'"),db.prepare("INSERT INTO settings VALUES('test','duplicate')")]));assert.equal((await db.prepare("SELECT value FROM settings WHERE key='test'").first()).value,'before');db.close();
 const folder=join(temp,'migrations');cpSync(resolve('drizzle'),folder,{recursive:true});writeFileSync(join(folder,'0000_faithful_nebula.sql'),readFileSync(join(folder,'0000_faithful_nebula.sql'),'utf8')+'\n-- modified\n');assert.throws(()=>new Storage(join(temp,'atomic.sqlite'),{directory:folder}),/checksum mismatch/);
});
