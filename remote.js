'use strict';
/* PUB Manara POS V0.9 — direct Supabase Auth / PostgREST / Realtime client.
   The only key in this public bundle is a PUBLISHABLE key; RLS enforces access.
   Server is authoritative: no payment is considered saved until RPC confirms. */
const POS_CLOUD_URL='https://vvrilytybmrutxzeknab.supabase.co';
const POS_PUBLISHABLE_KEY='sb_publishable_igJ3C6h4Mm7qkkBMcj2Qjw_aSZW5z4d';
const POS_SESSION_KEY='manara-pos-web-supabase-session-v1';
const POS_TEST_KEY='manara-pos-web-owner-test-toggle-v1';
const POS_STAFF_ENDPOINT=POS_CLOUD_URL+'/functions/v1/pos-staff-auth';
const RemotePos={
 active:false,session:null,employee:null,linkedCustomerId:null,testMode:false,isImported:false,users:[],products:[],customers:[],archive:[],priceHistory:[],audit:[],poll:null,socket:null,reconnect:null,loading:false,onChange:null,statusCallback:null,seq:0,authenticated:false,staffAdminUnlocked:false,
 setStatus(message,kind=''){if(typeof this.statusCallback==='function')this.statusCallback(message,kind);},
 apiHeaders(jwt=this.session?.access_token){return {apikey:POS_PUBLISHABLE_KEY,Authorization:'Bearer '+(jwt||POS_PUBLISHABLE_KEY),'Content-Type':'application/json'};},
 async request(path,{method='GET',body,query,headers={}}={}){
   this.assertShift();
   if(this.session&&this.session.expires_at-Date.now()<75000)await this.refreshSession();
   const url=new URL(path,POS_CLOUD_URL);
   if(query)for(const [key,value] of Object.entries(query))url.searchParams.set(key,value);
   let response;
   try{response=await fetch(url.toString(),{method,headers:{...this.apiHeaders(),...headers},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});}catch{throw new Error('אין חיבור לשרת. לא נשמרה עסקה.');}
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
 async listLoginEmployees(){
   const data=await this.staffAction("list_login_users",{},false);
   if(!Array.isArray(data?.employees))throw new Error("לא התקבלה רשימת עובדים תקינה");
   return data.employees.filter(name=>typeof name==="string"&&name.length>=2);
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
 async restoreSession(){
   try{this.session=JSON.parse(localStorage.getItem(POS_SESSION_KEY)||'null');}catch{this.session=null;}
   if(!this.session)return false;
   try{
    this.assertShift();
    if(this.session.expires_at-Date.now()<75000)await this.refreshSession();
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
   if(entry.is_owner!==true)localStorage.removeItem(POS_TEST_KEY);
   this.testMode=entry.is_owner===true&&localStorage.getItem(POS_TEST_KEY)==='on';
   return entry;
 },
 async signOut(){
   if(this.session?.pos_valid_until>Date.now()){
     try{await this.staffAction('logout');}catch{}
   }
   this.stop();this.session=null;this.employee=null;this.authenticated=false;
   this.active=false;this.testMode=false;this.staffAdminUnlocked=false;
   localStorage.removeItem(POS_SESSION_KEY);localStorage.removeItem(POS_TEST_KEY);
 },
 setTestMode(enabled){
   if(this.employee?.is_owner!==true)throw new Error('רק בעל החשבון רשאי להפעיל ניסיון');
   this.testMode=enabled===true;
   localStorage.setItem(POS_TEST_KEY,this.testMode?'on':'off');
 },
 async rows(table,select='*',order=''){
   const all=[];
   for(let from=0;from<50000;from+=1000){const data=await this.request(`/rest/v1/${table}`,{query:{select,...(order?{order}:{})},headers:{Range:`${from}-${from+999}`}});if(!Array.isArray(data))throw new Error('שגיאה בקריאת נתונים מהשרת');all.push(...data);if(data.length<1000)return all;}
   throw new Error('הארכיון גדול מדי לטעינה מלאה. נדרשת חלוקה נוספת לעמודים.');
 },
 async loadAll(){
    if(!this.authenticated)throw new Error('נדרשת התחברות');
    const [customerRows,productRows,transactionRows,settingsRows]=await Promise.all([
      this.rows('customers','id,name,name_key,active,is_test_created'),
      this.rows('products','id,name,name_key,category,product_type,price,active,price_history,is_test_created'),
      this.rows('transactions','id,client_operation_id,customer_name,operator_name,operator_id,employee_charge,employee_charge_user_id,kind,created_at,is_test,transaction_items!transaction_items_transaction_id_fkey(id,product_name,quantity,line_total,is_test,test_code,archived_deleted_at)','created_at.asc'),
      this.request('/rest/v1/pos_settings',{query:{select:'archive_imported',id:'eq.1'}})
    ]);
    this.customers=customerRows.map(c=>({id:c.id,name:c.name,normalized:c.name_key,active:c.active,isTestCreated:c.is_test_created===true}));
    this.products=productRows.map(p=>({id:p.id,name:p.name,normalized:p.name_key,category:p.category,type:p.product_type,price:Number(p.price),active:p.active,isTestCreated:p.is_test_created===true}));
    this.priceHistory=productRows.flatMap(p=>Array.isArray(p.price_history)?p.price_history:[]);
    this.archive=transactionRows.flatMap(tx=>{
      const d=new Date(tx.created_at);
      const formatted=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
      const part=k=>formatted.find(p=>p.type===k)?.value||'';
      const dateIso=`${part('year')}-${part('month')}-${part('day')}`;
      const time=d.toLocaleTimeString('en-GB',{timeZone:'Asia/Jerusalem',hour12:false});
      return(tx.transaction_items||[]).filter(item=>!item.archived_deleted_at).map(item=>({
        id:item.id,operationId:tx.client_operation_id,customer:tx.customer_name,operatorName:tx.operator_name||'',operatorId:tx.operator_id,employeeCharge:tx.employee_charge===true,employeeChargeUserId:tx.employee_charge_user_id,
        customerKey:String(tx.customer_name||'').toLocaleLowerCase('he-IL').trim(),
        dateIso,time,drink:item.product_name,qty:item.quantity,price:Number(item.line_total),
        kind:tx.kind,legacyNumber:'',createdAt:tx.created_at,isTest:tx.is_test===true||item.is_test===true,testCode:item.test_code||''
      }));
    });
    this.isImported=settingsRows?.[0]?.archive_imported===true;
    this.linkedCustomerId=await this.request('/rest/v1/rpc/pos_employee_link_v0938',{method:'POST',body:{}});
    if(this.employee?.is_owner===true){
      const [catalogLog,staffLog]=await Promise.all([
       this.request('/rest/v1/pos_audit_log',{query:{
        select:'id,entity_type,entity_name,action,actor_name,changed_at,old_values,new_values',
        order:'changed_at.desc,id.desc',limit:'250'
       }}),
       this.request('/rest/v1/pos_employee_audit',{query:{
        select:'id,actor_name,target_name,action,occurred_at',order:'occurred_at.desc,id.desc',limit:'250'
       }})
      ]);
      this.audit=[...catalogLog,...staffLog.map(x=>({
       id:'staff-'+x.id,entity_type:'employee',entity_name:x.target_name,
       action:x.action,actor_name:x.actor_name,changed_at:x.occurred_at,
       old_values:null,new_values:null
      }))].sort((a,b)=>new Date(b.changed_at)-new Date(a.changed_at)).slice(0,350);
    }else this.audit=[];
    this.active=true;
    return {customers:this.customers,products:this.products,archive:this.archive,priceHistory:this.priceHistory,audit:this.audit};
 },
 async saveCustomer(row){
   const existing=this.customers.some(c=>c.id===row.id);
   if(!existing)return this.request('/rest/v1/rpc/pos_create_catalog_v098',{
     method:'POST',body:{p_entity:'customer',p_name:row.name,p_is_test:this.testMode===true}
   });
   return this.request('/rest/v1/customers',{
     method:'PATCH',query:{id:`eq.${row.id}`},
     body:{name:row.name,active:row.active!==false},headers:{Prefer:'return=minimal'}
   });
 },
 async saveProduct(row,historyRecord=null){
   const existing=this.products.some(p=>p.id===row.id);
   if(!existing)return this.request('/rest/v1/rpc/pos_create_catalog_v098',{
     method:'POST',body:{p_entity:'product',p_name:row.name,
      p_category:row.category,p_product_type:row.type,p_price:row.price,p_is_test:this.testMode===true}
   });
   const history=historyRecord?[...this.priceHistory.filter(h=>h.productName===row.name),historyRecord]:null;
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
    return this.request('/rest/v1/rpc/submit_pos_transaction_v094',{
     method:'POST',body:{p_operation_id:operationId,p_customer_id:customerId,p_kind:kind,
      p_items:items.map(i=>({product_id:i.productId,quantity:i.qty,unit_price:i.unitPrice})),
      p_device_id:deviceId,p_is_test:this.testMode}
    });
 },
 async submitEmployeeCharge({operationId,kind,items,deviceId}){
  return this.request('/rest/v1/rpc/submit_pos_employee_charge_v0938',{method:'POST',body:{
    p_operation_id:operationId,p_kind:kind,
    p_items:items.map(i=>({product_id:i.productId,quantity:i.qty,unit_price:i.unitPrice})),
    p_device_id:deviceId,p_is_test:this.testMode===true}});
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
 async start(){await this.loadAll();this.stop();this.watchRealtime();this.poll=setInterval(()=>{if(navigator.onLine&&this.active)this.refreshQuietly();},12000);window.addEventListener('online',this._online=()=>{this.refreshQuietly();this.watchRealtime();});},
 async refreshQuietly(){if(this.loading||!this.active)return;this.loading=true;try{await this.authorize();await this.loadAll();if(this.onChange)await this.onChange();this.setStatus('מסונכרן עם כל הקופות','success');}catch(e){this.setStatus('לא ניתן לסנכרן: '+e.message,'error');}finally{this.loading=false;}},
 watchRealtime(){
   if(!navigator.onLine||!this.session?.access_token||this.socket&&this.socket.readyState<2)return;
   const url=`${POS_CLOUD_URL.replace('https','wss')}/realtime/v1/websocket?apikey=${encodeURIComponent(POS_PUBLISHABLE_KEY)}&vsn=1.0.0`;
   try{const ws=new WebSocket(url);this.socket=ws;let joined=false;
     ws.onopen=()=>{const ref=String(++this.seq);ws.send(JSON.stringify({topic:'realtime:manara-pos',event:'phx_join',payload:{config:{broadcast:{self:false},presence:{key:''},postgres_changes:['customers','products','transactions','transaction_items','pos_audit_log','pos_settings'].map(table=>({event:'*',schema:'public',table}))},access_token:this.session.access_token},ref,join_ref:ref}));};
     ws.onmessage=e=>{let msg;try{msg=JSON.parse(e.data);}catch{return;}if(msg.event==='phx_reply'&&msg.payload?.status==='ok')joined=true;if(msg.event==='postgres_changes'&&joined){clearTimeout(this._debounce);this._debounce=setTimeout(()=>this.refreshQuietly(),300);}};
     ws.onclose=()=>{this.socket=null;this.setStatus('Realtime מנותק — סנכרון מחזורי פעיל','');clearTimeout(this.reconnect);if(this.active)this.reconnect=setTimeout(()=>this.watchRealtime(),6000);};
     ws.onerror=()=>{try{ws.close();}catch{}};
     clearInterval(this.heartbeat);this.heartbeat=setInterval(()=>{if(ws.readyState===1){const ref=String(++this.seq);ws.send(JSON.stringify({topic:'phoenix',event:'heartbeat',payload:{},ref}));}},25000);
   }catch{this.setStatus('סנכרון מחזורי פעיל','');}
 },
 stop(){if(this.poll){clearInterval(this.poll);this.poll=null;}clearInterval(this.heartbeat);clearTimeout(this.reconnect);clearTimeout(this._debounce);if(this.socket){const s=this.socket;this.socket=null;try{s.onclose=null;s.close();}catch{}}if(this._online)window.removeEventListener('online',this._online);}
};