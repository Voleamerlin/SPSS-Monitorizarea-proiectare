import {env} from '../dist/server/server/runtime.js';
import {provision} from '../dist/server/server/provision.js';
import {ask,secret} from './prompt.mjs';
try{const email=await ask('Email Administrator: '),name=await ask('Nume și prenume: '),password=await secret('Parolă personală nouă (minimum 12 caractere): '),confirmation=await secret('Confirmați parola: ');if(password!==confirmation)throw new Error('Parolele nu coincid.');const result=await provision(env.DB,{email,name,password,recover:process.argv.includes('--recover')});console.log('Contul Administrator este pregătit: '+result.email);}catch(e){console.error(e.message);process.exitCode=1;}finally{env.DB.close();}
