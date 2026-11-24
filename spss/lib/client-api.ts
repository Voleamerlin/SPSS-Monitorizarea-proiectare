export async function request<T=Record<string,unknown>>(path:string,method="GET",body?:unknown):Promise<T>{
  const active=typeof window!=="undefined"&&(window as Window&{spssActive?:boolean}).spssActive;
  if(typeof window!=="undefined")(window as Window&{spssActive?:boolean}).spssActive=false;
  const response=await fetch(`/api/${path}`,{method,headers:{...(body?{"Content-Type":"application/json"}:{}),...(active?{"X-SPSS-Active":"1"}:{})},body:body?JSON.stringify(body):undefined,cache:"no-store"});
  const value=await response.json() as T&{error?:string};
  if(!response.ok){if((response.status===401||response.status===428)&&!path.startsWith("auth/"))window.dispatchEvent(new Event("spss-auth-check"));throw new Error(value.error||"Operațiunea nu a reușit.");}
  return value;
}
