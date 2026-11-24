import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {env} from '../dist/server/server/runtime.js';
import {importSnapshot} from '../dist/server/server/migration.js';
try{const path=process.argv[2];if(!path)throw new Error('Utilizare: node --env-file=.env scripts/import.mjs C:\\cale\\SPSS_Migrare.json');const text=readFileSync(resolve(path),'utf8').replace(/^\uFEFF/,'');if(Buffer.byteLength(text)>100*1024*1024)throw new Error('Snapshotul depășește 100 MiB.');const counts=importSnapshot(env.DB,JSON.parse(text));console.log(JSON.stringify({imported:counts,credentials:'personal password hashes preserved',sessionsTransferred:false}));}catch(e){console.error(e.name==='ZodError'?'Fișierul nu respectă schema de migrare. Datele destinației nu au fost modificate.':e.message);process.exitCode=1;}finally{env.DB.close();}
