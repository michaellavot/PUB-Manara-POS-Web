import { createClient } from "npm:@supabase/supabase-js@2.102.0";

const URL_ROOT=Deno.env.get("SUPABASE_URL")||"";
const keyFor=(modern,legacy)=>{
  try {const obj=JSON.parse(Deno.env.get(modern)||"{}");if(typeof obj.default==="string")return obj.default;}catch{}
  return Deno.env.get(legacy)||"";
};
const PUBLIC_KEY=keyFor("SUPABASE_PUBLISHABLE_KEYS","SUPABASE_ANON_KEY");
const SECRET_KEY=keyFor("SUPABASE_SECRET_KEYS","SUPABASE_SERVICE_ROLE_KEY");
const opts={auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false}};
const service=createClient(URL_ROOT,SECRET_KEY,opts);
const publicClient=()=>createClient(URL_ROOT,PUBLIC_KEY,opts);
const allow=(origin)=> origin==="https://michaellavot.github.io" || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
const withCors=(origin)=>({
  "Access-Control-Allow-Origin":allow(origin)?origin:"https://michaellavot.github.io",
  "Access-Control-Allow-Methods":"POST, OPTIONS",
  "Access-Control-Allow-Headers":"authorization,apikey,content-type,x-client-info",
  "Access-Control-Max-Age":"600",
  "Vary":"Origin",
  "Content-Type":"application/json; charset=utf-8",
  "Cache-Control":"no-store",
});
function answer(origin,data,status=200){
 return new Response(JSON.stringify(data),{status,headers:withCors(origin)});
}
function fail(status,reason){throw {httpStatus:status,message:reason};}
function normalizeName(v){
 const text=String(v||"").normalize("NFKC").trim().replace(/\s+/g," ");
 if(Array.from(text).length<2||Array.from(text).length>80)fail(400,"שם עובד חייב להכיל 2–80 תווים");
 return{text,key:text.toLocaleLowerCase("he-IL")};
}
function validatePIN(v){
 const pin=String(v??"");
 if(Array.from(pin).length!==4||/[\s\u0000-\u001f]/u.test(pin))fail(400,"יש להזין סיסמה של ארבעה תווים ללא רווחים");
 return pin.normalize("NFC");
}
function randomPassword(){
 return "Mp-"+Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,"0")).join("");
}
async function pinPassword(id,pin){
 const bytes=new TextEncoder();
 const key=await crypto.subtle.importKey("raw",bytes.encode(SECRET_KEY),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const signed=await crypto.subtle.sign("HMAC",key,bytes.encode("manara-pos-pin-v1|"+id+"|"+pin));
 return "Mp-"+Array.from(new Uint8Array(signed),x=>x.toString(16).padStart(2,"0")).join("");
}
function sessionId(jwt){
 try{
  const p=jwt.split(".")[1].replace(/-/g,"+").replace(/_/g,"/");
  const obj=JSON.parse(atob(p.padEnd(Math.ceil(p.length/4)*4,"=")));
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(String(obj.session_id||"")))fail(401,"אסימון כניסה לא תקין");
  return String(obj.session_id);
 }catch{fail(401,"אסימון כניסה לא תקין");}
}
async function validatedUser(req){
 const raw=req.headers.get("Authorization")||"";
 const jwt=raw.startsWith("Bearer ")?raw.substring(7):"";
 if(!jwt)fail(401,"יש להתחבר לקופה");
 const {data,error}=await service.auth.getUser(jwt);
 if(error||!data?.user?.id)fail(401,"ההתחברות פגה, יש להתחבר מחדש");
 return {user:data.user,session_id:sessionId(jwt),jwt};
}
async function currentStaff(req){
 const current=await validatedUser(req);
 const {data:account}=await service.from("employees").select("user_id,display_name,active,role")
 .eq("user_id",current.user.id).maybeSingle();
 const {data:login}=await service.from("pos_staff_logins")
 .select("user_id,username,owner_terminal").eq("user_id",current.user.id).maybeSingle();
 const {data:session}=await service.from("pos_staff_sessions")
 .select("session_id,user_id,expires_at,revoked_at").eq("session_id",current.session_id)
 .eq("user_id",current.user.id).maybeSingle();
 if(!account?.active||!login||!session||session.revoked_at||Date.parse(session.expires_at)<=Date.now())
   fail(401,"תוקף הכניסה פג. יש להיכנס מחדש");
 return {...current,account,login,session};
}
async function currentElevated(req){
 const st=await currentStaff(req);
 if(!st.login.owner_terminal)fail(403,"ניהול מערכת שמור לבעל החשבון");
 const {data:grant}=await service.from("pos_owner_grants")
 .select("expires_at").eq("session_id",st.session_id).maybeSingle();
 if(!grant||Date.parse(grant.expires_at)<=Date.now())fail(403,"יש לפתוח ניהול מערכת באמצעות מייל וסיסמת הבעלים");
 return st;
}
async function ownerPasswordProof(email,password){
 if(typeof email!=="string"||typeof password!=="string"||password.length<1)fail(401,"פרטי הבעלים אינם נכונים");
 const {data:owner,error}=await service.from("employees").select("user_id").eq("is_owner",true).eq("active",true).maybeSingle();
 if(error||!owner)fail(403,"לא נמצא חשבון בעלים פעיל");
 const check=publicClient();
 const {data,error:authError}=await check.auth.signInWithPassword({email:email.trim(),password});
 if(authError||data.user?.id!==owner.user_id)fail(401,"פרטי הבעלים אינם נכונים");
 // This Auth session stays server-side and is never sent to the POS browser.
 await check.auth.signOut({scope:'local'}).catch(()=>{});
 return owner.user_id;
}
async function throttle(req,name){
 const ip=req.headers.get("cf-connecting-ip")||
  (req.headers.get("x-forwarded-for")||"").split(",")[0].trim()||"unknown";
 const text=new TextEncoder().encode("pin-ip-v1|"+ip+"|"+SECRET_KEY);
 const digest=await crypto.subtle.digest("SHA-256",text);
 const hash=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,"0")).join("");
 const {data,error}=await service.rpc("pos_pin_attempt",{p_username_key:name.slice(0,120),p_ip_hash:hash});
 if(error)fail(503,"אימות העובדים אינו זמין כרגע");
 if(data?.allowed!==true)fail(429,"יותר מדי ניסיונות כניסה. נסה שוב לאחר 15 דקות");
}
async function auditEmployee(actor,target,action){
 await service.from("pos_employee_audit").insert({
  actor_id:actor?.account?.user_id||null,actor_name:actor?.account?.display_name||"אימות בעלים",
  target_id:target.user_id,target_name:target.username,action
 });
}
async function createLogin(username,pin,ownerTerminal,actor){
 const n=normalizeName(username);
 const {data:dupe}=await service.from("pos_staff_logins").select("user_id").eq("username_key",n.key).maybeSingle();
 if(dupe)fail(409,"שם העובד כבר בשימוש");
 const internalEmail="pos-"+crypto.randomUUID()+"@manara-pos.example.com";
 const {data:created,error:authError}=await service.auth.admin.createUser({
  email:internalEmail,password:randomPassword(),email_confirm:true
 });
 if(authError||!created?.user?.id)fail(500,"יצירת עובד נכשלה במערכת ההזדהות");
 const id=created.user.id;
 try{
  const pass=await pinPassword(id,pin);
  const updated=await service.auth.admin.updateUserById(id,{password:pass});
  if(updated.error)throw updated.error;
  const employee=await service.from("employees").insert({
   user_id:id,display_name:n.text,role:"staff",active:true,is_owner:false
  });
  if(employee.error)throw employee.error;
  const login=await service.from("pos_staff_logins").insert({
   user_id:id,username:n.text,username_key:n.key,internal_email:internalEmail,
   owner_terminal:ownerTerminal
  });
  if(login.error)throw login.error;
  await auditEmployee(actor,{user_id:id,username:n.text},ownerTerminal?"owner_pin_bootstrap":"created");
  return {user_id:id,username:n.text,owner_terminal:ownerTerminal};
 }catch(e){
  await service.auth.admin.deleteUser(id).catch(()=>{});
  fail(500,"לא ניתן ליצור משתמש. הנתונים הקיימים נשמרו.");
 }
}
async function pinLogin(req,body){
 const name=normalizeName(body.username),pin=validatePIN(body.pin);
 await throttle(req,name.key);
 const {data:login}=await service.from("pos_staff_logins")
  .select("user_id,internal_email").eq("username_key",name.key).maybeSingle();
 if(!login)fail(401,"שם העובד או הסיסמה אינם נכונים");
 const {data:employee}=await service.from("employees")
  .select("active,display_name").eq("user_id",login.user_id).maybeSingle();
 if(!employee?.active)fail(401,"שם העובד או הסיסמה אינם נכונים");
 const pass=await pinPassword(login.user_id,pin);
 const auth=publicClient();
 const {data,error}=await auth.auth.signInWithPassword({email:login.internal_email,password:pass});
 if(error||!data?.session?.access_token)fail(401,"שם העובד או הסיסמה אינם נכונים");
 const sid=sessionId(data.session.access_token);
 const expires=new Date(Date.now()+24*60*60*1000).toISOString();
 const {error:sessionError}=await service.from("pos_staff_sessions").upsert({
  session_id:sid,user_id:login.user_id,expires_at:expires,revoked_at:null
 },{onConflict:"session_id"});
 if(sessionError){await auth.auth.signOut({scope:'local'}).catch(()=>{});fail(503,"לא ניתן לפתוח משמרת כרגע");}
 return {access_token:data.session.access_token,
  refresh_token:data.session.refresh_token,
  expires_in:data.session.expires_in,
  token_type:"bearer",
  user:{id:login.user_id},
  pos_valid_until:expires,
  display_name:employee.display_name
 };
}
async function bootstrapOwner(req,body){
 await throttle(req,"owner-bootstrap");
 const owner=await ownerPasswordProof(body.email,body.password);
 const n=normalizeName(body.username),pin=validatePIN(body.pin);
 const {data:existing,error}=await service.from("pos_staff_logins")
  .select("user_id,username").eq("owner_terminal",true).maybeSingle();
 if(error)fail(500,"שגיאת קריאת גישת בעלים");
 if(!existing){
  const created=await createLogin(n.text,pin,true,null);
  return {message:"כניסת הבעלים הוגדרה. מעתה נכנסים בשם ובקוד.",username:created.username};
 }
 const {data:other}=await service.from("pos_staff_logins")
  .select("user_id").eq("username_key",n.key).neq("user_id",existing.user_id).maybeSingle();
 if(other)fail(409,"שם העובד כבר בשימוש");
 const pass=await pinPassword(existing.user_id,pin);
 const upd=await service.auth.admin.updateUserById(existing.user_id,{password:pass});
 if(upd.error)fail(500,"לא ניתן לעדכן את קוד הבעלים");
 const a=await service.from("pos_staff_logins").update({
  username:n.text,username_key:n.key,updated_at:new Date().toISOString()
 }).eq("user_id",existing.user_id);
 const b=await service.from("employees").update({display_name:n.text,active:true}).eq("user_id",existing.user_id);
 if(a.error||b.error)fail(500,"עדכון פרטי הבעלים לא הושלם");
 await service.from("pos_staff_sessions").update({revoked_at:new Date().toISOString()})
  .eq("user_id",existing.user_id).is("revoked_at",null);
 await auditEmployee(null,{user_id:existing.user_id,username:n.text},"owner_pin_reset");
 return {message:"קוד הכניסה של הבעלים עודכן. יש להיכנס מחדש.",username:n.text};
}
async function elevateOwner(req,body){
 const staff=await currentStaff(req);
 if(!staff.login.owner_terminal)fail(403,"ניהול מערכת שמור לבעל החשבון");
 await throttle(req,"owner-elevation:"+staff.login.username.toLocaleLowerCase("he-IL"));
 await ownerPasswordProof(body.email,body.password);
 const expiry=new Date(Math.min(Date.now()+30*60*1000,Date.parse(staff.session.expires_at))).toISOString();
 const {error}=await service.from("pos_owner_grants").upsert({
   session_id:staff.session_id,granted_at:new Date().toISOString(),expires_at:expiry
 },{onConflict:"session_id"});
 if(error)fail(500,"לא ניתן לפתוח הרשאות ניהול");
 return {elevated:true,expires_at:expiry};
}
async function listStaff(){
 const {data:users,error}=await service.from("pos_staff_logins")
 .select("user_id,username,owner_terminal,created_at").order("created_at",{ascending:true});
 if(error)fail(500,"לא ניתן להציג עובדים");
 const ids=users.map(u=>u.user_id);
 const {data:emp}=ids.length?
  await service.from("employees").select("user_id,active").in("user_id",ids):
  {data:[]};
 return users.map(u=>({...u,active:emp?.find(e=>e.user_id===u.user_id)?.active===true}));
}
async function manage(req,body){
 const actor=await currentElevated(req);
 const op=String(body.operation||"");
 if(op==="list")return {employees:await listStaff()};
 if(op==="create"){
  const pin=validatePIN(body.pin);
  const created=await createLogin(body.username,pin,false,actor);
  return {employee:created};
 }
 if(!["enable","disable","reset_pin"].includes(op))fail(400,"פעולת ניהול לא מוכרת");
 const id=String(body.user_id||"");
 const {data:target}=await service.from("pos_staff_logins")
  .select("user_id,username,owner_terminal").eq("user_id",id).maybeSingle();
 if(!target||target.owner_terminal)fail(403,"לא ניתן לשנות משתמש זה");
 if(op==="reset_pin"){
  const pin=validatePIN(body.pin);
  const {error}=await service.auth.admin.updateUserById(id,{password:await pinPassword(id,pin)});
  if(error)fail(500,"איפוס הסיסמה נכשל");
  await service.from("pos_staff_sessions").update({revoked_at:new Date().toISOString()})
   .eq("user_id",id).is("revoked_at",null);
  await auditEmployee(actor,target,"pin_reset");
  return {message:"סיסמת העובד עודכנה. כניסות קיימות בוטלו."};
 }
 const active=op==="enable";
 const {error}=await service.from("employees").update({active}).eq("user_id",id);
 if(error)fail(500,"שינוי מצב העובד נכשל");
 if(!active)await service.from("pos_staff_sessions").update({revoked_at:new Date().toISOString()})
    .eq("user_id",id).is("revoked_at",null);
 await auditEmployee(actor,target,active?"enabled":"disabled");
 return {message:active?"העובד הופעל מחדש":"העובד הושבת"};
}
async function signOutStaff(req){
 const staff=await currentStaff(req);
 await service.from("pos_staff_sessions").update({revoked_at:new Date().toISOString()})
 .eq("session_id",staff.session_id).eq("user_id",staff.account.user_id);
 return {signed_out:true};
}
Deno.serve(async(req)=>{
 const origin=req.headers.get("Origin")||"";
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:withCors(origin)});
 if(req.method!=="POST")return answer(origin,{error:"Only POST is allowed"},405);
 try{
  if(!SECRET_KEY||!PUBLIC_KEY||!URL_ROOT)fail(503,"שרת העובדים אינו מוגדר");
  const raw=await req.text();
  if(raw.length>8192)fail(413,"הבקשה גדולה מדי");
  const body=JSON.parse(raw||"{}");
  const action=String(body.action||"");
  let result;
  if(action==="login")result=await pinLogin(req,body);
  else if(action==="bootstrap_owner")result=await bootstrapOwner(req,body);
  else if(action==="elevate")result=await elevateOwner(req,body);
  else if(action==="manage")result=await manage(req,body);
  else if(action==="logout")result=await signOutStaff(req);
  else if(action==="lock_admin"){
   const current=await currentStaff(req);
   await service.from("pos_owner_grants").delete().eq("session_id",current.session_id);
   result={locked:true};
  }
  else fail(400,"פעולה לא מוכרת");
  return answer(origin,result);
 }catch(e){
  const status=Number(e?.httpStatus||500);
  if(status>=500)console.error("staff-auth server error",String(e?.message||e));
  return answer(origin,{error:status>=500?"שגיאת שרת במערכת העובדים":String(e?.message||"בקשה נכשלה")},status);
 }
});
