'use strict';
/* PUB Manara POS V0.9 — direct Supabase Auth / PostgREST / Realtime client.
   The only key in this public bundle is a PUBLISHABLE key; RLS enforces access.
   Server is authoritative: no payment is considered saved until RPC confirms. */
const POS_CLOUD_URL='https://vvrilytybmrutxzeknab.supabase.co';
const POS_PUBLISHABLE_KEY='sb_publishable_igJ3C6h4Mm7qkkBMcj2Qjw_aSZW5z4d';
const POS_SESSION_KEY='manara-pos-web-supabase-session-v1';
const POS_TEST_KEY='manara-pos-web-owner-test-toggle-v1';
const POS_MAINTENANCE_KEY='manara-pos-maintenance-device-v205';
const POS_STAFF_ENDPOINT=POS_CLOUD_URL+'/functions/v1/pos-staff-auth';
const RemotePos={
 active:false,session:null,employee:null,linkedCustomerId:null,testMode:false,isImported:false,users:[],products:[],customers:[],archive:[],priceHistory:[],audit:[],poll:null,socket:null,reconnect:null,loading:false,onChange:null,statusCallback:null,seq:0,authenticated:false,staffAdminUnlocked:false,_transactionRows:[],_lastFullSync:0,_realtimeConnected:false,_pendingChanges:[],_retrySync:false,networkStatus:'checking',networkCallback:null,networkPoll:null,_networkProbe:null,_networkCheckedAt:0,_networkGeneration:0,
 setStatus(message,kind=''){if(typeof this.statusCallback==='function')this.statusCallback(message,kind);},
 setNetworkStatus(mode){
  if(!['online','degraded','checking','offline'].includes(mode))return;
  if(this.networkStatus===mode)return;
  this.networkStatus=mode;
  if(typeof this.networkCallback==='function')this.networkCallback(mode);
 },
 async checkConnection(force=false){
  if(!this.active||!this.authenticated)return false;
  if(this._networkProbe)return this._networkProbe;
  if(!force&&Date.now()-this._networkCheckedAt<12000&&this.networkStatus!=='checking')return this.networkStatus!=='offline';
  const generation=this._networkGeneration;
  const job=(async()=>{
   if(!navigator.onLine){this.setNetworkStatus('offline');this._networkCheckedAt=Date.now();return false;}
   if(this.networkStatus==='offline')this.setNetworkStatus('checking');
   const controller=new AbortController();
   const timeout=setTimeout(()=>controller.abort(),6500);
   try{
    // Tiny authenticated GET: never POST a financial transaction to test connectivity.
    const response=await fetch(POS_CLOUD_URL+'/rest/v1/pos_settings?select=id&id=eq.1',{
     method:'GET',cache:'no-store',signal:controller.signal,headers:this.apiHeaders()
    });
    if(generation!==this._networkGeneration)return false;
    if(response.status===401||response.status===403){
     // Permission/session failure is not proof that the network is offline.
     this.setNetworkStatus('checking');return false;
    }
    if(!response.ok){this.setNetworkStatus('offline');return false;}
    this._networkCheckedAt=Date.now();
    this.setNetworkStatus(this._realtimeConnected?'online':'degraded');
    return true;
   }catch(error){
    if(generation===this._networkGeneration){this._networkCheckedAt=Date.now();this.setNetworkStatus('offline');}
    return false;
   }finally{clearTimeout(timeout);}
  })();
  this._networkProbe=job;
  try{return await job;}finally{if(this._networkProbe===job)this._networkProbe=null;}
 },
 async requireConnectionBeforeCharge(){
  if(!this.active||!this.authenticated)throw new Error('נדרשת התחברות לקופה');
  // Always revalidate immediately before a new financial write, even if status appeared green.
  if(!await this.checkConnection(true))throw new Error('לא אומת חיבור לשרת. ההזמנה נשמרה במסך ולא נשלח חיוב.');
 },
 apiHeaders(jwt=this.session?.access_token){return {apikey:POS_PUBLISHABLE_KEY,Authorization:'Bearer '+(jwt||POS_PUBLISHABLE_KEY),'Content-Type':'application/json'};},
 async request(path,{method='GET',body,query,headers={}}={}){
   this.assertShift();
   if(this.session&&this.session.expires_at-Date.now()<75000)await this.refreshSession();
   const url=new URL(path,POS_CLOUD_URL);
   if(query)for(const [key,value] of Object.entries(query))url.searchParams.set(key,value);
   let response;
   try{response=await fetch(url.toString(),{method,headers:{...this.apiHeaders(),...headers},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});}catch{
    // A transaction can have reached the server before the response was lost.
    // Never claim it was not saved; the idempotency key remains available for reconciliation.
    this.setNetworkStatus('offline');
    throw new Error('הקשר לשרת אבד. ייתכן שפעולה שנשלחה נקלטה; יש לבדוק את הארכיון לפני ניסיון חוזר.');
   }
   if(response.status===401){this.setStatus('ההתחברות פגה. יש להתחבר מחדש','error');throw new Error('יש להתחבר מחדש לשרת');}
   if(!response.ok){let error;try{error=await response.json();}catch{}throw new Error(error?.message||error?.error_description||`שגיאת שרת ${response.status}`);}
   if(response.status===204)return null;
   const text=await response.text();return text?JSON.parse(text):null;
 },
 assertShift(){
   if(this.session&&(!this.session.pos_valid_until||Date.now()>=this.session.pos_valid_until))
      throw new Error('חלפו 24 שעות מתחילת המשמרת. יש להיכנס מחדש בשם ובסיסמה.');
 },
 async staffAction(action,details={},requiresLogin=true){
   if(requiresLogin)this.assertShift();
   let response;
   try{
    response=await fetch(POS_STAFF_ENDPOINT,{
      method:'POST',cache:'no-store',headers:{
       apikey:POS_PUBLISHABLE_KEY,'Content-Type':'application/json',
       ...(requiresLogin&&this.session?.access_token?{Authorization:'Bearer '+this.session.access_token}:{})
      },body:JSON.stringify({action,...details})
    });
   }catch{throw new Error('אין חיבור לשרת ההתחברות. בדוק את האינטרנט.');}
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(data.error||'פעולת ניהול נכשלה');
   return data;
 },
 async authRequest(grant,details){
   this.assertShift();
   let response;
   try{response=await fetch(POS_CLOUD_URL+'/auth/v1/token?grant_type='+grant,{
     method:'POST',cache:'no-store',
     headers:{apikey:POS_PUBLISHABLE_KEY,'Content-Type':'application/json'},body:JSON.stringify(details)
   });}catch{throw new Error('לא ניתן להתחבר לשרת. בדוק את האינטרנט.');}
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error('יש להתחבר מחדש לקופה');
   if(!data.access_token||!data.refresh_token)throw new Error('השרת לא החזיר פרטי התחברות תקינים');
   const validUntil=this.session?.pos_valid_until;
   this.session={...data,user:data.user||this.session?.user,
     expires_at:Date.now()+Number(data.expires_in||3600)*1000,
     pos_valid_until:validUntil};
   localStorage.setItem(POS_SESSION_KEY,JSON.stringify(this.session));
   return this.session;
 },
 async listLoginEmployees({signal}={}){
   // Read-only public staff-name lookup; do not alter authentication or staff data.
   // Bound each request so an unresponsive connection cannot leave the picker stuck.
   const controller=new AbortController();
   const timeout=setTimeout(()=>controller.abort('timeout'),9000);
   const cancel=()=>controller.abort('cancelled');
   if(signal?.aborted){clearTimeout(timeout);throw Object.assign(new Error('הבקשה בוטלה'),{code:'cancelled',retryable:false});}
   signal?.addEventListener('abort',cancel,{once:true});
   let response;
   try{
     // Simple cross-origin POST: no custom headers, no credentials and a
     // CORS-safelisted Content-Type. The endpoint is intentionally public
     // for ACTIVE employee names only; authentication actions stay unchanged.
     response=await fetch(POS_STAFF_ENDPOINT,{
       method:'POST',mode:'cors',credentials:'omit',cache:'no-store',
       signal:controller.signal,
       headers:{'Content-Type':'text/plain;charset=UTF-8'},
       body:JSON.stringify({action:'list_login_users'})
     });
     // Backward compatibility for gateways that insist on an API key;
     // this fallback retains the previous, preflight-based request.
     if(response.status===401||response.status===403){
       response=await fetch(POS_STAFF_ENDPOINT,{
         method:'POST',cache:'no-store',signal:controller.signal,
         headers:{apikey:POS_PUBLISHABLE_KEY,'Content-Type':'application/json'},
         body:JSON.stringify({action:'list_login_users'})
       });
     }
   }catch(error){
     const cancelled=signal?.aborted||controller.signal.reason==='cancelled';
     const code=cancelled?'cancelled':controller.signal.aborted?'timeout':'network';
     const message=code==='timeout'?'שרת העובדים לא הגיב בזמן.':code==='cancelled'?'הבקשה בוטלה.':'לא ניתן להתחבר לשרת העובדים. בדוק את חיבור האינטרנט.';
     throw Object.assign(new Error(message),{code,retryable:!cancelled});
   }finally{
     clearTimeout(timeout);signal?.removeEventListener('abort',cancel);
   }
   let data;
   try{data=await response.json();}
   catch{throw Object.assign(new Error('השרת החזיר תגובה לא תקינה. נא לנסות שוב.'),{code:'invalid_response',retryable:true});}
   if(!response.ok){
     const retryable=response.status===408||response.status===429||response.status>=500;
     const message=response.status===429?'שרת העובדים עמוס. נא לנסות שוב.':
       response.status>=500?'שרת העובדים אינו זמין כרגע (שגיאה '+response.status+').':
       response.status===401||response.status===403?'השרת דחה את בקשת רשימת העובדים (שגיאה '+response.status+').':
       'טעינת העובדים נכשלה (שגיאה '+response.status+').';
     throw Object.assign(new Error(message),{code:'http_'+response.status,retryable});
   }
   if(!Array.isArray(data?.employees))
     throw Object.assign(new Error('לא התקבלה רשימת עובדים תקינה מהשרת.'),{code:'invalid_response',retryable:true});
   return data.employees.filter(name=>typeof name==='string'&&name.length>=2);
 },
 async loginPin(username,pin){
   const data=await this.staffAction('login',{username,pin},false);
   if(!data?.access_token||!data?.refresh_token||!data?.user?.id)throw new Error('ההתחברות לא הושלמה');
   const previous=this.captureSwitchSession();
   this.session={access_token:data.access_token,refresh_token:data.refresh_token,
     user:data.user,expires_at:Date.now()+Number(data.expires_in||3600)*1000,
     pos_valid_until:Date.parse(data.pos_valid_until)};
   localStorage.setItem(POS_SESSION_KEY,JSON.stringify(this.session));
   try{return await this.authorize();}
   catch(error){
     if(previous.session&&previous.authenticated)this.restoreSwitchSession(previous);
     else{this.session=null;this.employee=null;this.authenticated=false;this.active=false;this.testMode=false;localStorage.removeItem(POS_SESSION_KEY);}
     throw error;
   }
 },
 captureSwitchSession(){
   return {session:this.session?{...this.session}:null,employee:this.employee,
     active:this.active,authenticated:this.authenticated,testMode:this.testMode,
     storedTestMode:localStorage.getItem(POS_TEST_KEY)};
 },
 restoreSwitchSession(saved){
   if(!saved?.session||!saved?.authenticated)throw new Error('אין התחברות קודמת תקינה לשחזור');
   this.stop();
   this.session=saved.session;this.employee=saved.employee;this.active=saved.active;
   this.authenticated=saved.authenticated;this.testMode=saved.testMode;
   localStorage.setItem(POS_SESSION_KEY,JSON.stringify(saved.session));
   if(saved.storedTestMode===null)localStorage.removeItem(POS_TEST_KEY);
   else localStorage.setItem(POS_TEST_KEY,saved.storedTestMode);
 },
 async revokePriorSession(saved){
   if(!saved?.session?.access_token)return;
   const response=await fetch(POS_STAFF_ENDPOINT,{
     method:'POST',cache:'no-store',headers:{
       apikey:POS_PUBLISHABLE_KEY,
       'Content-Type':'application/json',
       Authorization:'Bearer '+saved.session.access_token
     },body:JSON.stringify({action:'logout'})
   });
   if(!response.ok)throw new Error('העובד הוחלף, אך לא ניתן לאמת את ניתוק המשמרת הקודמת');
 },
 async bootstrapOwner(username,pin,email,password){
   return this.staffAction('bootstrap_owner',{username,pin,email,password},false);
 },
 async elevateOwner(email,password){
   await this.staffAction('elevate',{email,password});
   await this.authorize();
   return this.employee;
 },
 async elevateStaffAdmin(email,password){
   const r=await this.staffAction('elevate_staff_admin',{email,password});
   this.staffAdminUnlocked=r.unlocked===true;return r;
 },
 async lockStaffAdmin(){
   await this.staffAction('lock_staff_admin');this.staffAdminUnlocked=false;
 },
 async refreshStaffAdminStatus(){
   if(!this.authenticated||this.employee?.permissions?.manage_system!==true||this.employee?.owner_terminal===true){this.staffAdminUnlocked=false;return;}
   const r=await this.staffAction('staff_admin_status');
   this.staffAdminUnlocked=r.unlocked===true;
 },
 async manageStaff(operation,details={}){
   return this.staffAction('manage',{operation,...details});
 },
 async archiveManage(operation,details={}){
   return this.staffAction('archive_manage',{operation,...details});
 },
 async lockAdmin(){
   await this.staffAction('lock_admin');
   this.testMode=false;localStorage.removeItem(POS_TEST_KEY);
   await this.authorize();
 },
 async refreshSession(){
   if(!this.session?.refresh_token)throw new Error('יש להתחבר מחדש');
   this.assertShift();
   await this.authRequest('refresh_token',{refresh_token:this.session.refresh_token});
 },
 // Closing a browser/PWA is best-effort; the mandatory server reset on restore
 // is the authoritative fallback when the browser cannot send this request.
 lockAdminOnPageHide(){
   if(!this.session?.access_token||(!this.employee?.is_owner&&!this.staffAdminUnlocked))return;
   try{
    fetch(POS_STAFF_ENDPOINT,{method:'POST',cache:'no-store',keepalive:true,
     headers:{apikey:POS_PUBLISHABLE_KEY,'Content-Type':'application/json',Authorization:'Bearer '+this.session.access_token},
     body:JSON.stringify({action:'reset_admin_on_open'})
    }).catch(()=>{});
   }catch{}
 },
 async restoreSession(){
   try{this.session=JSON.parse(localStorage.getItem(POS_SESSION_KEY)||'null');}catch{this.session=null;}
   if(!this.session)return false;
   try{
    this.assertShift();
    if(this.session.expires_at-Date.now()<75000)await this.refreshSession();
    // Never restore elevated privileges from a previous document.
    await this.staffAction('reset_admin_on_open');
    await this.authorize();return true;
   }catch(error){
    this.session=null;this.employee=null;this.authenticated=false;this.active=false;
    localStorage.removeItem(POS_SESSION_KEY);
    this.setStatus('נדרשת כניסה מחדש','error');
    return false;
   }
 },
 async authorize(){
   if(!this.session?.user?.id)throw new Error('פרטי ההתחברות אינם תקינים');
   const entry=await this.request('/rest/v1/rpc/pos_session_profile',{method:'POST',body:{}});
   if(!entry?.active||!entry.pin_login){
     this.authenticated=false;this.active=false;
     throw new Error('יש להגדיר כניסת עובד בקוד בן ארבעה תווים');
   }
   this.employee=entry;this.authenticated=true;
   try{await this.refreshStaffAdminStatus();}catch{this.staffAdminUnlocked=false;}
   localStorage.removeItem(POS_TEST_KEY); // Superseded by owner-authorized device maintenance.
   this.testMode=Boolean(this.maintenanceGrant());
   return entry;
 },
 async signOut(){
   if(this.session?.pos_valid_until>Date.now()){
     try{await this.staffAction('logout');}catch{}
   }
   this.stop();this.session=null;this.employee=null;this.authenticated=false;
   this.active=false;this.testMode=false;this.staffAdminUnlocked=false;
   localStorage.removeItem(POS_SESSION_KEY);localStorage.removeItem(POS_TEST_KEY);
   // Owner's verified device grant persists when staff switch or sign out.
 },
 maintenanceGrant(){
   try{
    const grant=JSON.parse(localStorage.getItem(POS_MAINTENANCE_KEY)||'null');
    if(!grant||typeof grant.token!=='string'||!/^[-0-9a-f]{36}$/i.test(grant.token)||
       grant.deviceId!==localStorage.getItem('manara_device_id'))return null;
    return grant;
   }catch{return null;}
 },
 maintenanceToken(){
   const grant=this.maintenanceGrant();
   if(!grant||Date.parse(grant.expiresAt)<=Date.now())
     throw new Error('הרשאת מצב התחזוקה פגה או חסרה. חיובים חסומים עד הפעלה מחודשת של הבעלים.');
   return grant.token;
 },
 async setMaintenanceMode(enabled,deviceId){
   if(this.employee?.is_owner!==true||!this.authenticated)throw new Error('רק בעל החשבון רשאי להפעיל או לכבות מצב תחזוקה');
   if(!deviceId)throw new Error('חסר מזהה מכשיר');
   if(enabled){
    const token=crypto.randomUUID();
    const result=await this.request('/rest/v1/rpc/pos_maintenance_control',{
      method:'POST',body:{p_device_id:deviceId,p_token:token,p_enabled:true}
    });
    if(!result?.enabled||!result?.expires_at)throw new Error('השרת לא אישר מצב תחזוקה');
    try{
     localStorage.setItem(POS_MAINTENANCE_KEY,JSON.stringify({deviceId,token,expiresAt:result.expires_at}));
    }catch(e){
     await this.request('/rest/v1/rpc/pos_maintenance_control',{
      method:'POST',body:{p_device_id:deviceId,p_token:token,p_enabled:false}
     });
     throw new Error('שמירת הרשאת התחזוקה במכשיר נכשלה; ההפעלה בוטלה.');
    }
    this.testMode=true;
   }else{
    await this.request('/rest/v1/rpc/pos_maintenance_control',{
     method:'POST',body:{p_device_id:deviceId,p_token:'',p_enabled:false}
    });
    localStorage.removeItem(POS_MAINTENANCE_KEY);
    this.testMode=false;
   }
 },
 setTestMode(){throw new Error('יש להשתמש באימות תחזוקה של הבעלים מול השרת');},
 async rows(table,select='*',order=''){
   const all=[];
   for(let from=0;from<50000;from+=1000){const data=await this.request(`/rest/v1/${table}`,{query:{select,...(order?{order}:{})},headers:{Range:`${from}-${from+999}`}});if(!Array.isArray(data))throw new Error('שגיאה בקריאת נתונים מהשרת');all.push(...data);if(data.length<1000)return all;}
   throw new Error('הארכיון גדול מדי לטעינה מלאה. נדרשת חלוקה נוספת לעמודים.');
 },
 _transactionSelect:'id,client_operation_id,customer_name,operator_name,operator_id,employee_charge,employee_charge_user_id,employee_charge_person_name,kind,created_at,is_test,transaction_items!transaction_items_transaction_id_fkey(id,product_name,quantity,line_total,is_test,test_code,archived_deleted_at)',
 applyCustomers(rows){this.customers=rows.map(c=>({id:c.id,name:c.name,normalized:c.name_key,active:c.active,isTestCreated:c.is_test_created===true}));},
 applyProducts(rows){this.products=rows.map(p=>({id:p.id,name:p.name,normalized:p.name_key,category:p.category,type:p.product_type,price:Number(p.price),active:p.active,isTestCreated:p.is_test_created===true,priceHistoryRows:Array.isArray(p.price_history)?p.price_history:[]}));this.priceHistory=rows.flatMap(p=>Array.isArray(p.price_history)?p.price_history:[]);},
 applyTransactions(transactionRows){
    this.archive=transactionRows.flatMap(tx=>{
      const d=new Date(tx.created_at);
      const formatted=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
      const part=k=>formatted.find(p=>p.type===k)?.value||'';
      const dateIso=`${part('year')}-${part('month')}-${part('day')}`;
      const time=d.toLocaleTimeString('en-GB',{timeZone:'Asia/Jerusalem',hour12:false});
      return(tx.transaction_items||[]).filter(item=>!item.archived_deleted_at).map(item=>({
        id:item.id,operationId:tx.client_operation_id,customer:tx.customer_name,operatorName:tx.operator_name||'',operatorId:tx.operator_id,employeeCharge:tx.employee_charge===true,employeeChargeUserId:tx.employee_charge_user_id,employeeChargePerson:tx.employee_charge_person_name||'',
        customerKey:String(tx.customer_name||'').toLocaleLowerCase('he-IL').trim(),
        dateIso,time,drink:item.product_name,qty:item.quantity,price:Number(item.line_total),
        kind:tx.kind,legacyNumber:'',createdAt:tx.created_at,isTest:tx.is_test===true||item.is_test===true,testCode:item.test_code||''
      }));
    });
 },
 async loadAudit(){
  if(this.employee?.is_owner!==true){this.audit=[];return;}
  const [catalogLog,staffLog]=await Promise.all([
   this.request('/rest/v1/pos_audit_log',{query:{select:'id,entity_type,entity_name,action,actor_name,changed_at,old_values,new_values',order:'changed_at.desc,id.desc',limit:'250'}}),
   this.request('/rest/v1/pos_employee_audit',{query:{select:'id,actor_name,target_name,action,occurred_at',order:'occurred_at.desc,id.desc',limit:'250'}})
  ]);
  this.audit=[...catalogLog,...staffLog.map(x=>({id:'staff-'+x.id,entity_type:'employee',entity_name:x.target_name,action:x.action,actor_name:x.actor_name,changed_at:x.occurred_at,old_values:null,new_values:null}))].sort((a,b)=>new Date(b.changed_at)-new Date(a.changed_at)).slice(0,350);
 },
 async loadAll(){
  if(!this.authenticated)throw new Error('נדרשת התחברות');
  const [customerRows,productRows,transactionRows,settingsRows,linked]=await Promise.all([
   this.rows('customers','id,name,name_key,active,is_test_created'),
   this.rows('products','id,name,name_key,category,product_type,price,active,price_history,is_test_created'),
   this.rows('transactions',this._transactionSelect,'created_at.asc'),
   this.request('/rest/v1/pos_settings',{query:{select:'archive_imported',id:'eq.1'}}),
   this.request('/rest/v1/rpc/pos_employee_link_v0938',{method:'POST',body:{}})
  ]);
  this.applyCustomers(customerRows);this.applyProducts(productRows);
  this._transactionRows=transactionRows;this.applyTransactions(transactionRows);
  this.isImported=settingsRows?.[0]?.archive_imported===true;
  this.linkedCustomerId=linked;
  await this.loadAudit();
  this._lastFullSync=Date.now();this.active=true;
  return {customers:this.customers,products:this.products,archive:this.archive,priceHistory:this.priceHistory,audit:this.audit};
 },
 async syncChanged(changes){
  const tables=new Set(changes.map(x=>x.table));
  const sections=new Set();
  const promises=[];
  if(tables.has('customers')){sections.add('customers');promises.push(this.rows('customers','id,name,name_key,active,is_test_created').then(rows=>this.applyCustomers(rows)));}
  if(tables.has('products')){sections.add('products');promises.push(this.rows('products','id,name,name_key,category,product_type,price,active,price_history,is_test_created').then(rows=>this.applyProducts(rows)));}
  if(tables.has('pos_settings')){sections.add('settings');promises.push(this.request('/rest/v1/pos_settings',{query:{select:'archive_imported',id:'eq.1'}}).then(rows=>{this.isImported=rows?.[0]?.archive_imported===true;}));}
  if(tables.has('pos_audit_log')){sections.add('audit');promises.push(this.loadAudit());}
  const transactionChanges=changes.filter(x=>x.table==='transactions'||x.table==='transaction_items');
  if(transactionChanges.length){
   sections.add('archive');
   promises.push((async()=>{
    const ids=new Set();let full=false;
    for(const change of transactionChanges){
     const record=change.record||{},older=change.old_record||{};
     let id=change.table==='transactions'?(record.id||older.id):(record.transaction_id||older.transaction_id);
     if(!id&&change.table==='transaction_items'){
      const itemId=record.id||older.id;
      if(itemId)id=this._transactionRows.find(t=>(t.transaction_items||[]).some(x=>x.id===itemId))?.id;
      if(!id&&itemId&&change.type!=='DELETE'){
       const found=await this.request('/rest/v1/transaction_items',{query:{select:'transaction_id',id:'eq.'+itemId,limit:'1'}});
       id=found?.[0]?.transaction_id;
      }
     }
     if(!id){full=true;break;}
     ids.add(id);
    }
    if(full||ids.size>150)this._transactionRows=await this.rows('transactions',this._transactionSelect,'created_at.asc');
    else for(const batchStart of Array.from({length:Math.ceil(ids.size/60)},(_,i)=>i*60)){
     const batch=[...ids].slice(batchStart,batchStart+60);
     const fetched=await this.request('/rest/v1/transactions',{query:{select:this._transactionSelect,id:'in.('+batch.join(',')+')'}});
     const hit=new Set(batch);
     this._transactionRows=this._transactionRows.filter(t=>!hit.has(t.id)).concat(fetched);
    }
    this._transactionRows.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
    this.applyTransactions(this._transactionRows);
   })());
  }
  await Promise.all(promises);
  return [...sections];
 },
 async saveCustomer(row){
   const existing=this.customers.some(c=>c.id===row.id);
   if(!existing){
    if(this.testMode)return this.request('/rest/v1/rpc/pos_create_catalog_v099',{
     method:'POST',body:{p_entity:'customer',p_name:row.name,p_category:null,
      p_product_type:null,p_price:null,p_is_test:true,
      p_maintenance_token:this.maintenanceToken(),p_device_id:localStorage.getItem('manara_device_id')||''}
    });
    return this.request('/rest/v1/rpc/pos_create_catalog_v098',{
     method:'POST',body:{p_entity:'customer',p_name:row.name,p_is_test:false}
    });
   }
   return this.request('/rest/v1/customers',{
     method:'PATCH',query:{id:`eq.${row.id}`},
     body:{name:row.name,active:row.active!==false},headers:{Prefer:'return=minimal'}
   });
 },
 async saveProduct(row,historyRecord=null){
   const existing=this.products.some(p=>p.id===row.id);
   if(!existing){
    if(this.testMode)return this.request('/rest/v1/rpc/pos_create_catalog_v099',{
     method:'POST',body:{p_entity:'product',p_name:row.name,
      p_category:row.category,p_product_type:row.type,p_price:row.price,p_is_test:true,
      p_maintenance_token:this.maintenanceToken(),p_device_id:localStorage.getItem('manara_device_id')||''}
    });
    return this.request('/rest/v1/rpc/pos_create_catalog_v098',{
     method:'POST',body:{p_entity:'product',p_name:row.name,
      p_category:row.category,p_product_type:row.type,p_price:row.price,p_is_test:false}
    });
   }
   const history=historyRecord?[...(Array.isArray(row.priceHistoryRows)?row.priceHistoryRows:this.priceHistory.filter(h=>h.productName===row.name)),historyRecord]:null;
   const payload={name:row.name,category:row.category,product_type:row.type,price:row.price,
      active:row.active!==false,...(history?{price_history:history}:{})};
   return this.request('/rest/v1/products',{method:'PATCH',query:{id:`eq.${row.id}`},
     body:payload,headers:{Prefer:'return=minimal'}});
 },
 async bulkDeleteCatalog(entity,ids,execute=false){
   if(!this.active||this.employee?.is_owner!==true)throw new Error('נדרש אימות בעלים לניהול מערכת');
   return this.request('/rest/v1/rpc/pos_bulk_delete_catalog_v0911',{
    method:'POST',body:{p_entity:entity,p_ids:ids,p_execute:execute===true}
   });
 },
 async deleteCatalog(entity,id,execute=false){
    if(!this.active||this.employee?.is_owner!==true)
      throw new Error('מחיקה לצמיתות זמינה רק לאחר אימות הבעלים בניהול מערכת');
    return this.request('/rest/v1/rpc/pos_delete_catalog_v098',{
     method:'POST',body:{p_entity:entity,p_entity_id:id,p_execute:execute===true}
    });
 },
 async submit({operationId,customerId,kind,items,deviceId}){
    const body={p_operation_id:operationId,p_customer_id:customerId,p_kind:kind,
     p_items:items.map(i=>({product_id:i.productId,quantity:i.qty,unit_price:i.unitPrice})),
     p_device_id:deviceId,p_is_test:this.testMode===true};
    if(this.testMode){
     body.p_maintenance_token=this.maintenanceToken();
     return this.request('/rest/v1/rpc/submit_pos_transaction_v095',{method:'POST',body});
    }
    return this.request('/rest/v1/rpc/submit_pos_transaction_v094',{method:'POST',body});
 },
 async submitEmployeeCharge({operationId,kind,items,deviceId,personName}){
    const body={p_operation_id:operationId,p_kind:kind,
     p_items:items.map(i=>({product_id:i.productId,quantity:i.qty,unit_price:i.unitPrice})),
     p_device_id:deviceId,p_person_name:personName,p_is_test:this.testMode===true};
    if(this.testMode){
     body.p_maintenance_token=this.maintenanceToken();
     return this.request('/rest/v1/rpc/submit_pos_employee_charge_v094',{method:'POST',body});
    }
    return this.request('/rest/v1/rpc/submit_pos_employee_charge_v0939',{method:'POST',body});
 },
 async employeeChargeReport(employeeId=null){
  return this.request('/rest/v1/rpc/pos_employee_charge_report_v0938',{method:'POST',body:{p_employee_id:employeeId}});
 },
 async importLocal(snapshot){
    if(this.employee?.is_owner!==true)throw new Error('ייבוא ארכיון הפאב מותר רק לבעל החשבון');
    return this.request('/rest/v1/rpc/import_local_pos_snapshot_v094',{method:'POST',body:{p_snapshot:snapshot}});
 },
 async remoteCount(){
    const data=await this.request('/rest/v1/pos_settings',{query:{select:'archive_imported',id:'eq.1'}});
    this.isImported=data?.[0]?.archive_imported===true;
    return {hasData:this.isImported,archiveImported:this.isImported};
 },
 async start(){
  this.stop();await this.loadAll();this.watchRealtime();
  this.setNetworkStatus('checking');
  void this.checkConnection(true);
  this.networkPoll=setInterval(()=>{if(this.active&&!document.hidden)void this.checkConnection(true);},30000);
  this._offline=()=>{this.setNetworkStatus('offline');};
  window.addEventListener('offline',this._offline);
  // Reconcile occasionally to recover missed websocket events; never pull full archive every 12 seconds.
  this.poll=setInterval(()=>{
   if(!navigator.onLine||!this.active||document.hidden)return;
   const elapsed=Date.now()-this._lastFullSync;
   const interval=this._realtimeConnected?15*60*1000:2*60*1000;
   if(elapsed>=interval)this.refreshQuietly();
  },30000);
  this._online=()=>{this.setNetworkStatus('checking');void this.checkConnection(true);this.watchRealtime();this.refreshQuietly();};
  window.addEventListener('online',this._online);
  this._visible=()=>{if(document.hidden||!this.active)return;void this.checkConnection(true);if(navigator.onLine&&Date.now()-this._lastFullSync>2*60*1000)this.refreshQuietly();};
  document.addEventListener('visibilitychange',this._visible);
 },
 async refreshQuietly(changes=null){
  if(!this.active||!this.authenticated)return;
  if(Array.isArray(changes))this._pendingChanges.push(...changes);
  else this._retrySync=true;
  if(this.loading)return;
  this.loading=true;
  try{
   while(this._retrySync||this._pendingChanges.length){
    const full=this._retrySync;
    const batch=this._pendingChanges.splice(0);
    this._retrySync=false;
    let sections;
    if(full){
     await this.authorize();
     await this.loadAll();
     sections=['all'];
    }else{
     sections=await this.syncChanged(batch);
    }
    if(this.onChange)await this.onChange(sections);
    this.setStatus('מסונכרן עם כל הקופות','success');
    if(this.networkStatus!=='offline')this.setNetworkStatus(this._realtimeConnected?'online':'degraded');
   }
  }catch(error){
   // A full reconciliation is safer than dropping an event when a network request fails.
   this._retrySync=true;
   this.setStatus('הסנכרון ינסה שוב: '+error.message,'error');
  }finally{this.loading=false;}
 },
 watchRealtime(){
  if(!navigator.onLine||!this.session?.access_token||this.socket&&this.socket.readyState<2)return;
  const url=`${POS_CLOUD_URL.replace('https','wss')}/realtime/v1/websocket?apikey=${encodeURIComponent(POS_PUBLISHABLE_KEY)}&vsn=1.0.0`;
  try{
   const ws=new WebSocket(url);this.socket=ws;this._realtimeConnected=false;let joined=false;
   ws.onopen=()=>{
    const ref=String(++this.seq);
    ws.send(JSON.stringify({topic:'realtime:manara-pos',event:'phx_join',
     payload:{config:{broadcast:{self:false},presence:{key:''},postgres_changes:['customers','products','transactions','transaction_items','pos_audit_log','pos_settings'].map(table=>({event:'*',schema:'public',table}))},access_token:this.session.access_token},ref,join_ref:ref}));
   };
   ws.onmessage=e=>{
    let msg;try{msg=JSON.parse(e.data);}catch{return;}
    if(msg.event==='phx_reply'&&msg.topic==='realtime:manara-pos'){
     joined=msg.payload?.status==='ok';this._realtimeConnected=joined;
     if(this.networkStatus!=='offline'&&this.networkStatus!=='checking')this.setNetworkStatus(joined?'online':'degraded');
     if(!joined)this.setStatus('Realtime לא התחבר — בדיקת גיבוי מחזורית פעילה','');
    }
    if(msg.event==='postgres_changes'&&joined){
     const data=msg.payload?.data||{},change={table:data.table,type:data.type,record:data.record,old_record:data.old_record};
     if(!['customers','products','transactions','transaction_items','pos_audit_log','pos_settings'].includes(change.table)){
      this._retrySync=true;return;
     }
     this._pendingChanges.push(change);
     clearTimeout(this._debounce);
     this._debounce=setTimeout(()=>{
      const updates=this._pendingChanges.splice(0);
      this.refreshQuietly(updates);
     },450);
    }
   };
   ws.onclose=()=>{
    if(this.socket===ws)this.socket=null;
    this._realtimeConnected=false;
    if(this.networkStatus==='online')this.setNetworkStatus('degraded');
    this.setStatus('Realtime מנותק — בדיקת גיבוי מחזורית פעילה','');
    clearTimeout(this.reconnect);
    if(this.active)this.reconnect=setTimeout(()=>this.watchRealtime(),6000);
   };
   ws.onerror=()=>{try{ws.close();}catch{}};
   clearInterval(this.heartbeat);
   this.heartbeat=setInterval(()=>{
    if(ws.readyState===1){const ref=String(++this.seq);ws.send(JSON.stringify({topic:'phoenix',event:'heartbeat',payload:{},ref}));}
   },25000);
  }catch{this._realtimeConnected=false;this.setStatus('בדיקת גיבוי מחזורית פעילה','');}
 },

 stop(){this._networkGeneration++;if(this.networkPoll){clearInterval(this.networkPoll);this.networkPoll=null;}if(this._offline)window.removeEventListener('offline',this._offline);if(this.poll){clearInterval(this.poll);this.poll=null;}clearInterval(this.heartbeat);clearTimeout(this.reconnect);clearTimeout(this._debounce);if(this.socket){const s=this.socket;this.socket=null;try{s.onclose=null;s.close();}catch{}}if(this._online)window.removeEventListener('online',this._online);if(this._visible)document.removeEventListener('visibilitychange',this._visible);this._pendingChanges=[];this._retrySync=false;this._realtimeConnected=false;this._networkProbe=null;this._networkCheckedAt=0;this.setNetworkStatus('checking');}
};