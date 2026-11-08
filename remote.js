'use strict';
/* PUB Manara POS V0.9 — direct Supabase Auth / PostgREST / Realtime client.
   The only key in this public bundle is a PUBLISHABLE key; RLS enforces access.
   Server is authoritative: no payment is considered saved until RPC confirms. */
const POS_CLOUD_URL='https://vvrilytybmrutxzeknab.supabase.co';
const POS_PUBLISHABLE_KEY='sb_publishable_igJ3C6h4Mm7qkkBMcj2Qjw_aSZW5z4d';
const POS_SESSION_KEY='manara-pos-web-supabase-session-v1';
const POS_TEST_KEY='manara-pos-web-owner-test-toggle-v1';
const RemotePos={
 active:false,session:null,employee:null,testMode:false,isImported:false,users:[],products:[],customers:[],archive:[],priceHistory:[],audit:[],poll:null,socket:null,reconnect:null,loading:false,onChange:null,statusCallback:null,seq:0,authenticated:false,
 setStatus(message,kind=''){if(typeof this.statusCallback==='function')this.statusCallback(message,kind);},
 apiHeaders(jwt=this.session?.access_token){return {apikey:POS_PUBLISHABLE_KEY,Authorization:'Bearer '+(jwt||POS_PUBLISHABLE_KEY),'Content-Type':'application/json'};},
 async request(path,{method='GET',body,query,headers={}}={}){
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
 async authRequest(grant,details){
   let response;
   try{response=await fetch(`${POS_CLOUD_URL}/auth/v1/token?grant_type=${grant}`,{method:'POST',cache:'no-store',headers:{apikey:POS_PUBLISHABLE_KEY,'Content-Type':'application/json'},body:JSON.stringify(details)});}catch{throw new Error('לא ניתן להתחבר לשרת. בדוק את האינטרנט.');}
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(response.status===400?'כתובת הדוא״ל או הסיסמה אינם נכונים':data.msg||data.error_description||'ההתחברות נכשלה');
   if(!data.access_token||!data.refresh_token)throw new Error('השרת לא החזיר פרטי התחברות תקינים');
   this.session={...data,user:data.user||this.session?.user,expires_at:Date.now()+Number(data.expires_in||3600)*1000};
   localStorage.setItem(POS_SESSION_KEY,JSON.stringify(this.session));
   return this.session;
 },
 async login(email,password){await this.authRequest('password',{email,password});return this.authorize();},
 async refreshSession(){if(!this.session?.refresh_token)throw new Error('יש להתחבר מחדש');await this.authRequest('refresh_token',{refresh_token:this.session.refresh_token});},
 async restoreSession(){
   try{this.session=JSON.parse(localStorage.getItem(POS_SESSION_KEY)||'null');}catch{this.session=null;}
   if(!this.session)return false;
   try{if(this.session.expires_at-Date.now()<75000)await this.refreshSession();await this.authorize();return true;}
   catch(e){this.session=null;localStorage.removeItem(POS_SESSION_KEY);this.setStatus('נדרשת התחברות מחדש','error');return false;}
 },
 async authorize(){
   const id=this.session?.user?.id;
   if(!id)throw new Error('פרטי ההתחברות אינם תקינים');
   const rows=await this.request('/rest/v1/employees',{query:{select:'user_id,display_name,role,active,is_owner',user_id:`eq.${id}`}});
   const entry=rows?.[0];
   if(!entry?.active){this.active=false;throw new Error('החשבון אינו מורשה לעבוד בקופה. פנה למנהל.');}
   this.employee=entry;this.authenticated=true;
   this.testMode=entry.is_owner===true&&localStorage.getItem(POS_TEST_KEY)==='on';
   return entry;
 },
 signOut(){this.stop();this.session=null;this.employee=null;this.authenticated=false;this.active=false;this.testMode=false;localStorage.removeItem(POS_SESSION_KEY);},
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
      this.rows('customers','id,name,name_key,active'),
      this.rows('products','id,name,name_key,category,product_type,price,active,price_history'),
      this.rows('transactions','id,client_operation_id,customer_name,kind,created_at,is_test,transaction_items!transaction_items_transaction_id_fkey(id,product_name,quantity,line_total,is_test,test_code)','created_at.asc'),
      this.request('/rest/v1/pos_settings',{query:{select:'archive_imported',id:'eq.1'}})
    ]);
    this.customers=customerRows.map(c=>({id:c.id,name:c.name,normalized:c.name_key,active:c.active}));
    this.products=productRows.map(p=>({id:p.id,name:p.name,normalized:p.name_key,category:p.category,type:p.product_type,price:Number(p.price),active:p.active}));
    this.priceHistory=productRows.flatMap(p=>Array.isArray(p.price_history)?p.price_history:[]);
    this.archive=transactionRows.flatMap(tx=>{
      const d=new Date(tx.created_at);
      const formatted=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
      const part=k=>formatted.find(p=>p.type===k)?.value||'';
      const dateIso=`${part('year')}-${part('month')}-${part('day')}`;
      const time=d.toLocaleTimeString('en-GB',{timeZone:'Asia/Jerusalem',hour12:false});
      return(tx.transaction_items||[]).map(item=>({
        id:item.id,operationId:tx.client_operation_id,customer:tx.customer_name,
        customerKey:String(tx.customer_name||'').toLocaleLowerCase('he-IL').trim(),
        dateIso,time,drink:item.product_name,qty:item.quantity,price:Number(item.line_total),
        kind:tx.kind,legacyNumber:'',isTest:tx.is_test===true||item.is_test===true,testCode:item.test_code||''
      }));
    });
    this.isImported=settingsRows?.[0]?.archive_imported===true;
    if(this.employee?.role==='manager'){
      this.audit=await this.request('/rest/v1/pos_audit_log',{
        query:{select:'id,entity_type,entity_name,action,actor_name,changed_at,old_values,new_values',order:'changed_at.desc,id.desc',limit:'250'}
      });
    }else this.audit=[];
    this.active=true;
    return {customers:this.customers,products:this.products,archive:this.archive,priceHistory:this.priceHistory,audit:this.audit};
 },
 async saveCustomer(row){
   const existing=this.customers.some(c=>c.id===row.id);
   const payload={name:row.name,active:row.active!==false};
   return this.request('/rest/v1/customers',{
      method:existing?'PATCH':'POST',
      query:existing?{id:`eq.${row.id}`}:{},
      body:payload,headers:{Prefer:'return=minimal'}
   });
 },
 async saveProduct(row,historyRecord=null){
   const existing=this.products.some(p=>p.id===row.id);
   const history=historyRecord?[...this.priceHistory.filter(h=>h.productName===row.name),historyRecord]:null;
   const payload={name:row.name,category:row.category,product_type:row.type,price:row.price,
      active:row.active!==false,...(history?{price_history:history}:{})};
   return this.request('/rest/v1/products',{
     method:existing?'PATCH':'POST',
     query:existing?{id:`eq.${row.id}`}:{},
     body:payload,headers:{Prefer:'return=minimal'}
   });
 },
 async submit({operationId,customerId,kind,items,deviceId}){
    return this.request('/rest/v1/rpc/submit_pos_transaction_v094',{
     method:'POST',body:{p_operation_id:operationId,p_customer_id:customerId,p_kind:kind,
      p_items:items.map(i=>({product_id:i.productId,quantity:i.qty,unit_price:i.unitPrice})),
      p_device_id:deviceId,p_is_test:this.testMode}
    });
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
 async refreshQuietly(){if(this.loading||!this.active)return;this.loading=true;try{await this.loadAll();if(this.onChange)await this.onChange();this.setStatus('מסונכרן עם כל הקופות','success');}catch(e){this.setStatus('לא ניתן לסנכרן: '+e.message,'error');}finally{this.loading=false;}},
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