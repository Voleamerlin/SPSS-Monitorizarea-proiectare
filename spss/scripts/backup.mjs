import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,existsSync,renameSync,chmodSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const filename=resolve(process.env.SPSS_DB_PATH||'./var/spss.sqlite'),target=resolve(process.argv[2]||'./backups/SPSS_'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite');
if(!existsSync(filename))throw new Error('Baza de date nu există.');if(existsSync(target)||existsSync(target+'.tmp'))throw new Error('Destinația backupului există deja.');mkdirSync(dirname(target),{recursive:true});
const db=new DatabaseSync(filename,{readOnly:true});db.exec('PRAGMA busy_timeout=5000');
try{await backup(db,target+'.tmp');const verify=new DatabaseSync(target+'.tmp',{readOnly:true});try{if(verify.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Verificarea backupului a eșuat.');}finally{verify.close();}renameSync(target+'.tmp',target);try{chmodSync(target,0o600);}catch{}console.log(JSON.stringify({backup:target,integrity:'ok',createdAt:new Date().toISOString()}));}finally{db.close();}
