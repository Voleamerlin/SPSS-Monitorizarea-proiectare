import {DatabaseSync} from 'node:sqlite';
import {existsSync,copyFileSync,renameSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
const source=process.argv[2]&&resolve(process.argv[2]),target=resolve(process.env.SPSS_DB_PATH||'./var/spss.sqlite');
if(!process.argv.includes('--server-stopped'))throw new Error('Opriți aplicația și utilizați --server-stopped.');if(!source||!existsSync(source)||source===target)throw new Error('Specificați backupul sursă.');if(!existsSync(target))throw new Error('Inițializați mai întâi schema în destinația configurată.');
const check=new DatabaseSync(source,{readOnly:true});try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Backup invalid.');if(!check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_users'").get())throw new Error('Backupul nu aparține aplicației SPSS.');}finally{check.close();}
const lock=new DatabaseSync(target);try{lock.exec('PRAGMA busy_timeout=5000; BEGIN EXCLUSIVE; ROLLBACK; PRAGMA wal_checkpoint(TRUNCATE)');}finally{lock.close();}
const safety=target+'.before-restore-'+Date.now();copyFileSync(target,safety);for(const suffix of ['-wal','-shm'])if(existsSync(target+suffix))unlinkSync(target+suffix);copyFileSync(source,target+'.restoring');renameSync(target+'.restoring',target);
const db=new DatabaseSync(target);try{db.exec('DELETE FROM auth_sessions; DELETE FROM auth_limits;');}finally{db.close();}console.log(JSON.stringify({restored:target,previous:safety,sessionsRevoked:true}));
