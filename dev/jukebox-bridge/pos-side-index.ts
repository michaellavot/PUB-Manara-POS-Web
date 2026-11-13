// DEV-only proposed POS-side server bridge. NOT deployed to production.
// Invocation is restricted to a trusted server-side service role bearer.
// Never call this function from browser JavaScript.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const enc=new TextEncoder();
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
const hex=(v:Uint8Array)=>Array.from(v).map(x=>x.toString(16).padStart(2,"0")).join("");
Deno.serve(async(req)=>{
 if(req.method!=="POST")return json({error:"method"},405);
 const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 const base=Deno.env.get("SUPABASE_URL");
 const secret=Deno.env.get("JUKEBOX_POS_BRIDGE_SECRET");
 const target=Deno.env.get("JUKEBOX_DEV_BRIDGE_URL");
 if(!key||!base||!secret||secret.length<32||!target)return json({error:"not configured"},503);
 if(req.headers.get("authorization")!=="Bearer "+key)return json({error:"unauthorized"},401);
 let data:{device_id?:string;event_id?:string};
 try{data=await req.json();}catch{return json({error:"json"},400);}
 if(!data.device_id||!data.event_id||!/^[-0-9a-f]{36}$/i.test(data.event_id))return json({error:"payload"},400);
 const url=new URL("/rest/v1/maintenance_device_grants",base);
 // This table is private; access via dedicated security-definer RPC rather than REST.
 const status=await fetch(base+"/rest/v1/rpc/pos_jukebox_bridge_status",{method:"POST",headers:{"apikey":key,"authorization":"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({p_device_id:data.device_id})});
 if(!status.ok)return json({error:"POS state verification failed"},503);
 const state=await status.json();
 if(state?.revoked!==true)return json({error:"maintenance not revoked"},409);
 const body=JSON.stringify({event:"maintenance_disabled",device_id:data.device_id,event_id:data.event_id});
 const stamp=String(Date.now());
 const cryptoKey=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const signature=hex(new Uint8Array(await crypto.subtle.sign("HMAC",cryptoKey,enc.encode(stamp+"."+body))));
 const response=await fetch(target,{method:"POST",headers:{"content-type":"application/json","x-pos-timestamp":stamp,"x-pos-signature":signature},body});
 return new Response(await response.text(),{status:response.status,headers:{"content-type":"application/json","cache-control":"no-store"}});
});