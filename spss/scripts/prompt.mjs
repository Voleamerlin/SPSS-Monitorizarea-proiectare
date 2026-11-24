import {createInterface} from 'node:readline/promises';
export async function ask(label){if(!process.stdin.isTTY)throw new Error('Folosiți o consolă interactivă locală.');const rl=createInterface({input:process.stdin,output:process.stdout});try{return await rl.question(label);}finally{rl.close();}}
export async function secret(label){
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Parola se introduce numai într-o consolă interactivă locală.');
 process.stdout.write(label);process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();
 return new Promise((resolve,reject)=>{let value='';const finish=(error)=>{process.stdin.off('data',data);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');if(error)reject(error);else resolve(value);};const data=chunk=>{for(const char of chunk){if(char==='\u0003'){finish(new Error('Operație anulată.'));return;}if(char==='\r'||char==='\n'){finish();return;}if(char==='\u007f'||char==='\b')value=value.slice(0,-1);else if(char>=' '&&value.length<129)value+=char;}};process.stdin.on('data',data);});
}
