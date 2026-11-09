'use strict';
/* V0.9.36: manager-only, audited archive editor.
   This file never stores credentials and never writes directly to protected tables. */
const ArchiveAdmin=(()=>{
 const state={records:[],page:0,total:0,selectedKey:null,loading:false,open:false};
 const $=id=>document.getElementById(id);
 const add=(tag,text,cls)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
 const nameKey=(name,test)=>String(test?'test:':'live:')+String(name);
 const groupOf=tx=>nameKey(tx.customer_name,tx.is_test);
 function showMessage(message,kind=''){
  const label=$('archiveAdminMessage');label.textContent=message;label.className='small-note '+kind;
 }
 function readableDate(iso){try{return new Date(iso).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}catch{return iso||'';}}
 function asLocalDate(iso){
  const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));
  return parts.replace(' ','T');
 }
 function groups(){
  const m=new Map();
  for(const tx of state.records){
   const key=groupOf(tx);let row=m.get(key);
   if(!row){row={key,name:tx.customer_name,isTest:tx.is_test===true,transactions:[],count:0,total:0};m.set(key,row);}
   row.transactions.push(tx);
   for(const line of tx.transaction_items||[]){
    if(line.archived_deleted_at)continue;
    row.count++;row.total+=Number(line.line_total)||0;
   }
  }
  return [...m.values()].sort((a,b)=>a.name.localeCompare(b.name,'he')||Number(a.isTest)-Number(b.isTest));
 }
 function renderCustomers(){
  const host=$('archiveCustomerList');host.replaceChildren();
  const search=$('archiveCustomerSearch').value.trim().toLocaleLowerCase('he-IL');
  for(const item of groups().filter(g=>g.name.toLocaleLowerCase('he-IL').includes(search))){
   const line=add('div',undefined,'archive-client-row');
   const select=add('button',undefined,'button archive-client-select');
   select.type='button';select.classList.toggle('active',state.selectedKey===item.key);
   select.append(add('strong',item.name));
   select.append(add('small',item.count+' שורות פעילות · '+item.total.toLocaleString('he-IL',{maximumFractionDigits:2})+' ₪'+(item.isTest?' · ניסיון':'')));
   select.addEventListener('click',()=>{state.selectedKey=item.key;renderCustomers();renderLines();});
   const edit=add('button','✎','button secondary archive-small-btn');
   edit.type='button';edit.title='ערוך שם לקוח';edit.setAttribute('aria-label','ערוך '+item.name);
   edit.addEventListener('click',()=>renameCustomer(item));
   line.append(select,edit);host.append(line);
  }
  $('archiveCustomerCount').textContent=groups().length+' חשבונות נטענו ('+state.records.length+' עסקאות)';
 }
 function renderLines(){
  const host=$('archiveLinesList');host.replaceChildren();
  $('archiveEditForm').classList.add('hidden');
  const group=groups().find(g=>g.key===state.selectedKey);
  $('archiveSelectedCustomer').textContent=group?group.name+' — '+group.count+' שורות':'בחר לקוח להצגת פירוט החיובים';
  if(!group)return;
  const sorted=[...group.transactions].sort((a,b)=>b.created_at.localeCompare(a.created_at));
  for(const tx of sorted){
   for(const li of tx.transaction_items||[]){
    const wrap=add('div',undefined,'archive-line-row');
    if(li.archived_deleted_at)wrap.classList.add('deleted');
    const details=add('div',undefined,'archive-line-details');
    details.append(add('strong',li.product_name+' · '+li.quantity+' × '+Number(li.unit_price).toLocaleString('he-IL')+' ₪'));
    details.append(add('small',readableDate(tx.created_at)+' · '+(tx.operator_name||'—')+' · '+(tx.kind==='refund'?'זיכוי':'חיוב')+' · '+Number(li.line_total).toLocaleString('he-IL')+' ₪'));
    if(li.archived_deleted_at)details.append(add('small','שורה מבוטלת — לא נכללת בדוחות','archive-deleted-note'));
    const actions=add('div',undefined,'archive-line-actions');
    const edit=add('button','ערוך','button secondary archive-small-btn');
    edit.type='button';edit.disabled=Boolean(li.archived_deleted_at);
    edit.addEventListener('click',()=>editLine(tx,li));
    const remove=add('button',li.archived_deleted_at?'שחזר':'מחק','button archive-small-btn '+(li.archived_deleted_at?'secondary':'warning'));
    remove.type='button';remove.addEventListener('click',()=>toggleDelete(tx,li));
    actions.append(edit,remove);wrap.append(details,actions);host.append(wrap);
   }
  }
 }
 function editLine(tx,li){
  const form=$('archiveEditForm');
  form.elements.namedItem('item_id').value=li.id;
  form.elements.namedItem('created_at').value=asLocalDate(tx.created_at);
  form.elements.namedItem('operator_name').value=tx.operator_name||'';
  form.elements.namedItem('customer_name').value=tx.customer_name||'';
  form.elements.namedItem('product_name').value=li.product_name;
  form.elements.namedItem('kind').value=tx.kind;
  form.elements.namedItem('quantity').value=li.quantity;
  form.elements.namedItem('unit_price').value=li.unit_price;
  form.dataset.transactionId=tx.id;
  const count=(tx.transaction_items||[]).filter(x=>!x.archived_deleted_at).length;
  $('archiveEditNote').textContent=count>1?'שים לב: שינוי תאריך, עובד, לקוח או סוג פעולה יעדכן את כל שורות העסקה הזאת.':'עריכת שורת חיוב. השמירה תעדכן את הדוחות.';
  form.classList.remove('hidden');form.scrollIntoView({block:'nearest',behavior:'smooth'});
 }
 async function saveLine(event){
  event.preventDefault();const f=event.currentTarget;const form=new FormData(f);
  const qty=Number(form.get('quantity')),price=Number(form.get('unit_price'));
  if(!Number.isInteger(qty)||qty<1||qty>999||!Number.isFinite(price)||price<0||price>1000000)throw new Error('יש להזין כמות ומחיר תקינים');
  const tx=state.records.find(t=>t.id===f.dataset.transactionId);
  if(!tx)throw new Error('העסקה לא נמצאה. רענן את הארכיון.');
  const dateValue=String(form.get('created_at')||'');
  const iso=new Date(dateValue).toISOString();
  const payload={item_id:String(form.get('item_id')),created_at:iso,
   operator_name:String(form.get('operator_name')||'').trim(),customer_name:String(form.get('customer_name')||'').trim(),
   product_name:String(form.get('product_name')||'').trim(),kind:String(form.get('kind')),quantity:qty,unit_price:price};
  const originalLine=(tx.transaction_items||[]).find(i=>i.id===payload.item_id);
  if(!originalLine)throw new Error('השורה לא נמצאה');
  const transactionLevel=payload.created_at!==new Date(tx.created_at).toISOString()||
   payload.operator_name!==tx.operator_name||payload.customer_name!==tx.customer_name||payload.kind!==tx.kind;
  if(transactionLevel&&(tx.transaction_items||[]).length>1&&!confirm('חלק מהשינויים יחולו על כל שורות העסקה. להמשיך?'))return;
  if(!confirm('לשמור את התיקון בארכיון ולעדכן את הסכומים בדוחות?'))return;
  await mutate('edit_line',payload);
 }
 async function toggleDelete(tx,li){
  const restoring=Boolean(li.archived_deleted_at);
  const msg=restoring?'לשחזר את השורה כך שתיכלל שוב בדוחות?':'לבטל את השורה ולהסיר את סכומה מהדוחות? ניתן יהיה לשחזר אותה.';
  if(!confirm(msg))return;
  await mutate(restoring?'restore_line':'delete_line',{item_id:li.id});
 }
 async function renameCustomer(group){
  const name=prompt('שם לקוח בארכיון',group.name);
  if(name===null)return;
  const next=name.trim().replace(/\s+/g,' ');
  if(!next||next.length>120)throw new Error('יש להזין שם באורך עד 120 תווים');
  if(next===group.name)return;
  const duplicate=groups().some(g=>g.name===next&&g.isTest===group.isTest&&g.key!==group.key);
  if(!confirm(duplicate?'השם קיים כבר בארכיון. לאחד את כל החיובים תחת השם '+next+'?':'לעדכן את שם הלקוח בכל תנועות הארכיון שלו?'))return;
  await mutate('rename_customer',{old_name:group.name,new_name:next,is_test:group.isTest});
  state.selectedKey=nameKey(next,group.isTest);renderCustomers();renderLines();
 }
 async function mutate(operation,payload){
  showMessage('שומר תיקון בארכיון…');
  const result=await RemotePos.archiveManage(operation,{payload});
  showMessage('התיקון נשמר בשרת ותועד ביומן השינויים.','success');
  await loadAllPages();await refresh();
  if(result?.result?.changed===0)showMessage('לא נמצא שינוי לביצוע.');
  return result;
 }
 async function loadAllPages(){
  if(state.loading)return;state.loading=true;
  $('archiveRefreshBtn').disabled=true;
  state.records=[];state.page=0;state.total=0;
  try{
   let pages=0;
   while(true){
    const r=await RemotePos.archiveManage('list',{page:state.page});
    state.records.push(...(r.transactions||[]));state.total=Number(r.total||0);state.page++;
    renderCustomers();
    pages++;
    if(state.records.length>=state.total||!r.transactions?.length)break;
    if(pages>=8){showMessage('נטענו '+state.records.length+' מתוך '+state.total+' עסקאות. אפשר לטעון עוד.');break;}
   }
   renderLines();
   $('archiveLoadMoreBtn').classList.toggle('hidden',state.records.length>=state.total);
   if(state.records.length>=state.total)showMessage('נטענו '+state.total+' עסקאות מהארכיון.');
  }finally{state.loading=false;$('archiveRefreshBtn').disabled=false;}
 }
 async function loadMore(){
  if(state.loading||state.records.length>=state.total)return;
  state.loading=true;
  try{
   const r=await RemotePos.archiveManage('list',{page:state.page});
   state.records.push(...(r.transactions||[]));state.page++;
   renderCustomers();renderLines();
   $('archiveLoadMoreBtn').classList.toggle('hidden',state.records.length>=state.total);
  }finally{state.loading=false;}
 }
 async function showAudit(){
  const r=await RemotePos.archiveManage('audit');
  const host=$('archiveAuditList');host.replaceChildren();
  for(const a of r.audit||[]){
   const text=readableDate(a.changed_at)+' · '+a.actor_name+' · '+({edit_line:'עריכת שורה',delete_line:'מחיקת שורה',restore_line:'שחזור שורה',rename_customer:'שינוי שם לקוח'}[a.action]||a.action);
   host.append(add('div',text,'archive-audit-entry'));
  }
  host.classList.remove('hidden');
 }
 function inspectDb(file){
  const n=$('archiveDbNotice');
  if(!file)return;
  if(!/\.db$/i.test(file.name)){n.textContent='יש לבחור קובץ SQLite עם סיומת DB';return;}
  const reader=new FileReader();
  reader.onload=()=>{
   const bytes=new Uint8Array(reader.result);
   const header=Array.from(bytes.slice(0,16)).map(b=>String.fromCharCode(b)).join('');
   if(header!=='SQLite format 3\0'){n.textContent='הקובץ אינו מזוהה כארכיון SQLite. לא בוצע ייבוא.';return;}
   n.textContent='זוהה קובץ SQLite תקין ('+file.size.toLocaleString('he-IL')+' בתים). לא בוצע ייבוא. נדרש מיפוי מדויק של טבלאות pub_manara.db לפני פרסום נתונים, כדי למנוע איחוד לקוחות או שינוי חיובים בטעות.';
  };
  reader.readAsArrayBuffer(file.slice(0,32));
 }
 function close(){state.open=false;$('archiveManagerModal').classList.add('hidden');}
 async function open(){
  if(!RemotePos.active||!RemotePos.authenticated)throw new Error('יש להתחבר לפני פתיחת הארכיון');
  $('archiveManagerModal').classList.remove('hidden');state.open=true;
  try{await loadAllPages();}catch(e){showMessage('לא ניתן לפתוח ניהול ארכיון: '+e.message,'error');}
 }
 function init(){
  $('archiveManageBtn').addEventListener('click',()=>open().catch(e=>alert(e.message)));
  $('archiveAdminClose').addEventListener('click',close);
  $('archiveAdminBackdrop').addEventListener('click',close);
  $('archiveRefreshBtn').addEventListener('click',()=>loadAllPages().catch(e=>showMessage(e.message,'error')));
  $('archiveLoadMoreBtn').addEventListener('click',()=>loadMore().catch(e=>showMessage(e.message,'error')));
  $('archiveCustomerSearch').addEventListener('input',renderCustomers);
  $('archiveEditForm').addEventListener('submit',e=>saveLine(e).catch(err=>showMessage(err.message,'error')));
  $('archiveCancelEdit').addEventListener('click',()=>$('archiveEditForm').classList.add('hidden'));
  $('archiveAuditBtn').addEventListener('click',()=>showAudit().catch(e=>showMessage(e.message,'error')));
  $('archiveDbFile').addEventListener('change',e=>inspectDb(e.target.files[0]));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.open)close();});
 }
 return {init,close,open};
})();
