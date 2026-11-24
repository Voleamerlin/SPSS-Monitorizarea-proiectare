import {createServer,type IncomingMessage,type ServerResponse} from "node:http";
import {readFileSync,statSync} from "node:fs";
import {resolve,sep,extname} from "node:path";
import {isIP} from "node:net";
import {pathToFileURL} from "node:url";
import {GET as handle} from "./api.js";
import {env} from "./runtime.js";

export function validateOrigin(value:string|undefined,local=false){
 if(!value)throw new Error("Configurați APP_ORIGIN în .env");
 const u=new URL(value);if(u.origin!==value||u.username||u.password)throw new Error("APP_ORIGIN trebuie să conțină numai schema și domeniul, fără cale");
 if(local&&u.protocol!=="http:")throw new Error("Modul HTTP local nu poate fi activat pentru un domeniu HTTPS");
 if(u.protocol!=="https:"&&!(local&&u.protocol==="http:"&&["127.0.0.1","localhost"].includes(u.hostname)))throw new Error("APP_ORIGIN trebuie să utilizeze HTTPS");
 return u;
}
const mime:Record<string,string>={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon",".woff2":"font/woff2"};
export function createApplication(options:{origin?:string;clientDirectory?:string;localHTTP?:boolean}={}){
 const local=options.localHTTP??process.env.ALLOW_INSECURE_LOCAL_HTTP==="true",origin=validateOrigin(options.origin||process.env.APP_ORIGIN,local),client=resolve(options.clientDirectory||"dist/client");
 const security={"X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Referrer-Policy":"same-origin","Permissions-Policy":"camera=(), microphone=(), geolocation=()","Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",...(origin.protocol==="https:"?{"Strict-Transport-Security":"max-age=31536000"}:{})};
 const app=createServer(async(req:IncomingMessage,res:ServerResponse)=>{
  for(const [k,v]of Object.entries(security))res.setHeader(k,v);
  res.setHeader("Cache-Control","no-store");
  const respond=(status:number,message:string)=>{res.statusCode=status;res.setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify({error:message}));};
  try{
   const host=req.headers.host?.toLowerCase();if(!host||![origin.host.toLowerCase(),"127.0.0.1:"+(app.address() as {port:number})?.port,"localhost:"+(app.address() as {port:number})?.port].includes(host)){respond(400,"Gazdă nepermisă.");return;}
   const url=new URL(req.url||"/",origin),method=req.method||"GET";
   if(url.pathname==="/healthz"&&["GET","HEAD"].includes(method)){env.DB.raw.prepare("SELECT 1").get();res.setHeader("Content-Type","application/json");res.end(method==="HEAD"?undefined:JSON.stringify({status:"ok"}));return;}
   if(url.pathname.startsWith("/api/")){
    if(!["GET","POST","PATCH","DELETE"].includes(method)){respond(405,"Metodă nepermisă.");return;}
    if(method!=="GET"&&req.headers.origin!==origin.origin){respond(403,"Originea cererii nu este permisă.");return;}
    if(Number(req.headers["content-length"]||0)>100000){respond(413,"Cererea este prea mare.");req.resume();return;}
    let size=0;const chunks:Buffer[]=[];for await(const c of req){const chunk=Buffer.isBuffer(c)?c:Buffer.from(c);size+=chunk.length;if(size>100000){respond(413,"Cererea este prea mare.");return;}chunks.push(chunk);}
    const headers=new Headers();for(const [k,v]of Object.entries(req.headers))if(v&&!/^(cf-connecting-ip|oai-|x-forwarded-|forwarded|host)/i.test(k))headers.set(k,Array.isArray(v)?v.join(","):v);
    const ip=req.headers["x-spss-client-ip"],proxyIP=typeof ip==="string"&&isIP(ip)?ip:req.socket.remoteAddress||"unknown";headers.set("cf-connecting-ip",proxyIP);
    const request=new Request(origin.origin+url.pathname+url.search,{method,headers,...(method!=="GET"?{body:Buffer.concat(chunks)}:{})});
    const result=await handle(request);res.statusCode=result.status;for(const [k,v]of result.headers)if(k!=="set-cookie")res.setHeader(k,v);const cookies=result.headers.getSetCookie();if(cookies.length)res.setHeader("Set-Cookie",cookies);res.end(Buffer.from(await result.arrayBuffer()));return;
   }
   if(!["GET","HEAD"].includes(method)){respond(405,"Metodă nepermisă.");return;}
   const pathname=decodeURIComponent(url.pathname),file=resolve(client,pathname==="/"?"index.html":"."+pathname);
   if(!file.startsWith(client+sep)){respond(404,"Resursa nu există.");return;}
   let stat;try{stat=statSync(file);}catch{respond(404,"Resursa nu există.");return;}if(!stat.isFile()){respond(404,"Resursa nu există.");return;}
   res.setHeader("Content-Type",mime[extname(file)]||"application/octet-stream");res.setHeader("Content-Length",stat.size);if(pathname.startsWith("/assets/"))res.setHeader("Cache-Control","public, max-age=31536000, immutable");res.end(method==="HEAD"?undefined:readFileSync(file));
  }catch{if(!res.headersSent)respond(500,"Operațiunea nu a putut fi efectuată.");else res.end();console.error(JSON.stringify({event:"request_failed",date:new Date().toISOString()}));}
 });
 app.requestTimeout=30000;app.headersTimeout=15000;app.keepAliveTimeout=5000;app.maxConnections=200;return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const port=Number(process.env.PORT||3100);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error("PORT invalid");
 const app=createApplication();app.listen(port,"127.0.0.1",()=>console.log(JSON.stringify({event:"started",port,date:new Date().toISOString()})));
 for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>{app.close(()=>{env.DB.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();});
}
