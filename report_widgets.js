'use strict';
/* V2.0.9 — Presentation-only report pickers. The existing select/date values
   remain the sole input to the established reporting and QR permissions. */
const ReportPickers=(()=>{
 const $=id=>document.getElementById(id);
 const clientIds=new Set(['reportCustomer','qrReportCustomer']);
 const ids=['reportCustomer','qrReportCustomer','fromDate','toDate','qrFromDate','qrToDate'];
 let current=null,year=0,month=0,restoreFocus=null;
 const d2=x=>String(x).padStart(2,'0');
 const iso=(y,m,d)=>y+'-'+d2(m+1)+'-'+d2(d);
 const today=()=>{const d=new Date();return iso(d.getFullYear(),d.getMonth(),d.getDate());};
 const display=val=>/^\d{4}-\d{2}-\d{2}$/.test(val)?val.slice(8,10)+'/'+val.slice(5,7)+'/'+val.slice(0,4):'בחר תאריך';
 function sync(){
  for(const id of ids){
   const field=$(id);
   if(!field)continue;
   const btn=document.querySelector('[data-report-picker="'+id+'"]');
   if(!btn)continue;
   if(clientIds.has(id)){
    const selected=[...field.options].find(opt=>opt.value===field.value);
    btn.firstChild.textContent=(selected?.textContent||(id==='reportCustomer'?'כל הלקוחות':'בחר לקוח'))+' ';
   }else{
    const label=document.querySelector('[data-date-label="'+id+'"]');
    if(label)label.textContent=display(field.value);
   }
   btn.disabled=field.disabled;
  }
 }
 function close(){
  $('reportPickerModal').classList.add('hidden');
  current=null;
  const target=restoreFocus;restoreFocus=null;
  if(target&&target.isConnected)target.focus();
 }
 function setValue(val){
  if(!current)return;
  const field=$(current);
  if(!field||field.disabled)return;
  field.value=val;
  field.dispatchEvent(new Event('change',{bubbles:true}));
  sync();
  close();
 }
 function open(id){
  const field=$(id);
  if(!field||field.disabled||!ids.includes(id))return;
  current=id;
  restoreFocus=document.querySelector('[data-report-picker="'+id+'"]');
  const customer=clientIds.has(id);
  $('reportCustomerPickerView').classList.toggle('hidden',!customer);
  $('reportCalendarPickerView').classList.toggle('hidden',customer);
  $('reportPickerTitle').textContent=customer?'בחירת לקוח':(id==='fromDate'||id==='qrFromDate'?'מתאריך':'עד תאריך');
  $('reportPickerModal').classList.remove('hidden');
  if(customer){
   $('reportPickerSearch').value='';
   customers();$('reportPickerSearch').focus();
  }else{
   const val=/^\d{4}-\d{2}-\d{2}$/.test(field.value)?field.value:today();
   year=Number(val.slice(0,4));month=Number(val.slice(5,7))-1;
   calendar();$('reportCalendarPrev').focus();
  }
 }
 function customers(){
  if(!current||!clientIds.has(current))return;
  const field=$(current),query=$('reportPickerSearch').value.normalize('NFKC').trim().toLocaleLowerCase('he-IL');
  const host=$('reportPickerCustomers');host.replaceChildren();
  const matches=[...field.options].filter(o=>o.value!==''?o.textContent.toLocaleLowerCase('he-IL').includes(query):!query);
  $('reportPickerCount').textContent=matches.length+' אפשרויות';
  for(const option of matches){
   const b=document.createElement('button');
   b.type='button';b.className='report-picker-customer';
   b.setAttribute('role','option');
   b.setAttribute('aria-selected',String(field.value===option.value));
   b.textContent=option.textContent;
   b.addEventListener('click',()=>setValue(option.value));host.append(b);
  }
  if(!matches.length){
   const empty=document.createElement('p');
   empty.className='report-picker-empty';empty.textContent='לא נמצאו לקוחות';host.append(empty);
  }
 }
 function calendar(){
  $('reportCalendarMonth').textContent=new Intl.DateTimeFormat('he-IL',{month:'long',year:'numeric'}).format(new Date(year,month,1,12));
  const host=$('reportCalendarDays');host.replaceChildren();
  const offset=new Date(year,month,1,12).getDay();
  const n=new Date(year,month+1,0,12).getDate();
  const chosen=current?$(current).value:'';
  const now=today();
  for(let i=0;i<offset;i++){
   const blank=document.createElement('span');blank.className='report-calendar-blank';host.append(blank);
  }
  for(let d=1;d<=n;d++){
   const val=iso(year,month,d);
   const b=document.createElement('button');b.type='button';
   b.className='report-calendar-day';
   b.textContent=d;
   b.setAttribute('aria-label',d+' '+$('reportCalendarMonth').textContent);
   b.setAttribute('aria-pressed',String(val===chosen));
   if(val===now)b.classList.add('today');
   b.addEventListener('click',()=>setValue(val));host.append(b);
  }
 }
 function changeMonth(delta){
  const d=new Date(year,month+delta,1,12);year=d.getFullYear();month=d.getMonth();calendar();
 }
 function init(){
  for(const id of ids){
   const field=$(id);
   if(!field)throw new Error('Report picker target missing: '+id);
   const btn=document.querySelector('[data-report-picker="'+id+'"]');
   if(!btn)throw new Error('Report picker button missing: '+id);
   btn.addEventListener('click',()=>open(id));
   field.addEventListener('change',sync);
   if(clientIds.has(id)){
    new MutationObserver(sync).observe(field,{childList:true,subtree:true});
   }
  }
  $('reportPickerSearch').addEventListener('input',customers);
  $('reportPickerClose').addEventListener('click',close);
  $('reportPickerBackdrop').addEventListener('click',close);
  $('reportCalendarPrev').addEventListener('click',()=>changeMonth(-1));
  $('reportCalendarNext').addEventListener('click',()=>changeMonth(1));
  $('reportCalendarToday').addEventListener('click',()=>setValue(today()));
  $('reportCalendarClear').addEventListener('click',()=>setValue(''));
  $('reportPickerModal').addEventListener('keydown',event=>{
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
   if(event.key==='Tab'){
    const visible=[...$('reportPickerModal').querySelectorAll('button:not([disabled]),input:not([disabled])')].filter(e=>e.offsetParent!==null);
    if(!visible.length)return;
    const first=visible[0],last=visible[visible.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
   }
  });
  sync();
 }
 return {init,sync,open,close};
})();