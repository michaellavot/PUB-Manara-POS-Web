'use strict';
/* V2.0.4 local, per-employee unsent order recovery. Never writes to Supabase. */
const DraftGuard={
 prefix:'manara-pos-unsent-draft-v204:',
 ready:false,blocked:false,dialog:null,
 employeeKey(){
  if(!RemotePos.authenticated||!RemotePos.employee||!RemotePos.session?.user?.id)return null;
  const employee=RemotePos.employee;
  const id=employee.id||employee.employee_id||employee.user_id||employee.display_name;
  if(!id)return null;
  return this.prefix+encodeURIComponent(String(RemotePos.session.user.id))+':'+encodeURIComponent(String(id));
 },
 read(){
  const key=this.employeeKey();if(!key)return null;
  try{const data=JSON.parse(localStorage.getItem(key)||'null');
   return data?.schema===1&&Array.isArray(data.items)?data:null;
  }catch{return null;}
 },
 erase(){const key=this.employeeKey();if(key)try{localStorage.removeItem(key);}catch(e){console.error('טיוטה לא נמחקה',e);}},
 snapshot(){
  return {schema:1,savedAt:new Date().toISOString(),
   customerId:state.selectedCustomer?.id||null,
   employeeCharge:state.employeeCharge===true,
   personName:state.employeeChargePerson||'',
   testMode:RemotePos.testMode===true,
   items:state.cart.map(x=>({id:x.id,productId:x.productId,drink:x.drink,
    qty:x.qty,unitPrice:x.unitPrice,price:x.price})),
   pending:state.pendingOperation?{fingerprint:state.pendingOperation.fingerprint,op:state.pendingOperation.op}:null};
 },
 save(){
  if(!this.ready||!RemotePos.authenticated)return;
  const key=this.employeeKey();if(!key)return;
  try{
   if(!state.cart.length&&!state.pendingOperation){localStorage.removeItem(key);return;}
   localStorage.setItem(key,JSON.stringify(this.snapshot()));
  }catch(e){console.error('לא ניתן לשמור טיוטת הזמנה במכשיר',e);
   const node=document.getElementById('status');
   if(node)node.textContent='אזהרה: שמירת טיוטה מקומית נכשלה. אל תסגור את הקופה לפני סיום ההזמנה.';
  }
 },
 // The synchronous save must happen before a financial request leaves the device.
 markPending(){this.save();},
 totals(){
  return {count:state.cart.reduce((n,x)=>n+Number(x.qty||0),0),
   amount:state.cart.reduce((n,x)=>n+Number(x.price||0),0)};
 },
 description(){
  const t=this.totals();
  const name=state.employeeCharge?'חיוב עובד: '+state.employeeChargePerson:(state.selectedCustomer?.name||'לא נבחר לקוח');
  return name+' · '+t.count+' פריטים · '+t.amount.toLocaleString('he-IL',{maximumFractionDigits:2})+' ₪';
 },
 ask(message,actionLabel='המשך ללא חיוב'){
  const modal=document.getElementById('draftWarningModal');
  if(!modal)return Promise.resolve(false);
  if(this.dialog)return Promise.resolve(false);
  document.getElementById('draftWarningDetails').textContent=this.description();
  document.getElementById('draftWarningMessage').textContent=message;
  modal.classList.remove('hidden');
  const proceed=document.getElementById('draftWarningProceed');
  const cancel=document.getElementById('draftWarningCancel');
  proceed.textContent=actionLabel;cancel.focus();
  return new Promise(resolve=>{
   const cleanup=()=>{modal.classList.add('hidden');proceed.removeEventListener('click',yes);
    cancel.removeEventListener('click',no);modal.removeEventListener('keydown',keyboard);this.dialog=null;};
   const yes=()=>{cleanup();resolve(true);};
   const no=()=>{cleanup();resolve(false);};
   const keyboard=e=>{if(e.key==='Escape'){e.preventDefault();no();}if(e.key==='Tab'){e.preventDefault();(document.activeElement===cancel?proceed:cancel).focus();}};
   this.dialog=true;
   proceed.addEventListener('click',yes);cancel.addEventListener('click',no);modal.addEventListener('keydown',keyboard);
  });
 },
 async authorizeDeparture(action){
  if(state.busy||state.pendingOperation){alert('יש עסקה שממתינה לאימות. בדוק את הארכיון לפני יציאה או החלפת עובד.');return false;}
  if(!state.cart.length)return true;
  return this.ask('ההזמנה טרם חויבה. מעבר זה עלול לבטל את הפריטים שבחרת.','המשך ללא חיוב');
 },
 restoreItems(data){
  const customer=data.employeeCharge?null:state.customers.find(x=>x.id===data.customerId&&x.active);
  if(!data.employeeCharge&&!customer)throw new Error('הלקוח בטיוטה אינו פעיל או אינו קיים');
  if(data.employeeCharge&&!linkedEmployeeCustomer())throw new Error('חשבון העובד המקושר אינו זמין');
  if(data.testMode!==(RemotePos.testMode===true))throw new Error('מצב הניסיון השתנה מאז שמירת הטיוטה');
  if(!data.items.length||data.items.length>200)throw new Error('טיוטה ריקה או לא תקינה');
  const items=data.items.map(x=>{
   const p=state.products.find(p=>p.id===x.productId&&p.active);
   if(!p||!Number.isInteger(x.qty)||x.qty<1||x.qty>999||
      !Number.isFinite(x.unitPrice)||x.unitPrice<0||
      !Number.isFinite(x.price)||x.price<0||
      Math.abs(Math.round(x.unitPrice*x.qty*100)/100-x.price)>0.01)
    throw new Error('אחד מפריטי הטיוטה אינו תקין או אינו זמין');
   return {id:String(x.id||crypto.randomUUID()),productId:p.id,drink:String(x.drink||p.name),
    qty:x.qty,unitPrice:x.unitPrice,price:x.price};
  });
  state.cart=items;state.cartHistory=[];state.selectedRow=-1;
  state.employeeCharge=data.employeeCharge===true;
  state.employeeChargePerson=state.employeeCharge?String(data.personName||''):'';
  state.selectedCustomer=customer||null;
  state.pendingOperation=data.pending?{...data.pending}:null;
  renderBill();
 },
 async restoreAfterLogin(){
  this.ready=false;this.blocked=false;
  const data=this.read();
  if(!data||!data.items.length){this.ready=true;return;}
  const pending=Boolean(data.pending?.op);
  const msg=pending?
   'העסקה נשלחה אך אישורה אינו ברור. אין לחייב מחדש לפני בדיקת הארכיון. הטיוטה תישמר במכשיר.':
   'נמצאה הזמנה שלא חויבה במכשיר זה. לשחזר אותה אחרי התחברות?';
  const modal=document.getElementById('draftRecoveryModal');
  document.getElementById('draftRecoveryDetails').textContent=
   data.items.reduce((s,x)=>s+Number(x.qty||0),0)+' פריטים · '+data.items.reduce((s,x)=>s+Number(x.price||0),0).toLocaleString('he-IL',{maximumFractionDigits:2})+' ₪';
  document.getElementById('draftRecoveryMessage').textContent=msg;
  document.getElementById('draftRecoveryRestore').textContent=pending?'בדקתי בארכיון — נסה עם אותו מזהה':'שחזר הזמנה';
  document.getElementById('draftRecoveryDiscard').textContent=pending?'העסקה נמצאה בארכיון — סגור טיוטה':'מחק טיוטה';
  modal.classList.remove('hidden');
  this.blocked=pending;
  const result=await new Promise(resolve=>{
   const yes=document.getElementById('draftRecoveryRestore'),no=document.getElementById('draftRecoveryDiscard');
   const later=document.getElementById('draftRecoveryLater');
   const done=value=>{yes.removeEventListener('click',onYes);no.removeEventListener('click',onNo);
    later.removeEventListener('click',onLater);modal.classList.add('hidden');resolve(value);};
   const onYes=()=>done('restore'),onNo=()=>done('discard'),onLater=()=>done('later');
   yes.addEventListener('click',onYes);no.addEventListener('click',onNo);later.addEventListener('click',onLater);later.focus();
  });
  if(result==='discard'){this.erase();this.blocked=false;}
  else if(result==='restore'){
   try{this.restoreItems(data);this.blocked=false;status('ההזמנה שוחזרה מהמכשיר. לא נוצר חיוב.','success');}
   catch(e){alert('לא ניתן לשחזר טיוטה: '+e.message+'. הטיוטה נשמרה לבדיקה.');this.blocked=true;}
  }else this.blocked=true;
  this.ready=!this.blocked;
 },
 beforeUnload(event){
  if(!this.ready||(!state.cart.length&&!state.pendingOperation))return;
  this.save();event.preventDefault();event.returnValue='';
 }
};
