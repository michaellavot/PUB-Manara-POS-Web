'use strict';
const APP_VERSION='1.0.14';
const DEFAULT_PRODUCTS=[
 ['בירה 15',15],['בירה 10',10],['בירה 20',20],['בריזר',20],
 ['וודקה (ערבוב)',25],['ויסקי (ערבוב)',25],['ערק (ערבוב)',25],["ג'ין (ערבוב)",25],['טקילה (ערבוב)',25],
 ['וודקה (צ\'ייסר)',10],['ויסקי (צ\'ייסר)',10],['ערק (צ\'ייסר)',10],["ג'ין (צ\'ייסר)",10],['טקילה (צ\'ייסר)',10],
 ['וודקה (מנה)',25],['ויסקי (מנה)',25],['ערק (מנה)',25],["ג'ין (מנה)",25],['טקילה (מנה)',25],['גינס',1]
];
const state={pendingOperation:null,customers:[],products:[],archive:[],priceHistory:[],showInactiveProducts:false,showInactiveCustomers:false,selectedCustomer:null,employeeCharge:false,employeeChargePerson:'',category:null,cart:[],selectedRow:-1,cartHistory:[],busy:false,installPrompt:null,currentReport:{headers:[],rows:[],title:'דוח תנועות'},pendingImport:null,catalogDialog:null,catalogSearch:'',catalogSelections:new Set(),availableEmployees:[],permissionEmployee:null,switchingEmployee:false};
const el=id=>document.getElementById(id);
const norm=s=>String(s||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase('he-IL');
// Match each query word to the beginning of any word in the customer's full name, in any order.
const customerNameMatches=(name,query)=>{
 const terms=norm(query).split(' ').filter(Boolean);
 if(!terms.length)return true;
 const words=norm(name).split(' ').filter(Boolean);
 return terms.every(term=>words.some(word=>word.startsWith(term)));
};
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uuid=()=>crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2);
const nowIso=()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};
const nowDisplay=()=>{const d=new Date();return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;};
const clockTime=()=>new Date().toLocaleTimeString('he-IL',{hour12:false});
const currency=v=>`${Number(v||0).toLocaleString('he-IL',{minimumFractionDigits:0,maximumFractionDigits:2})} ₪`;
const amount=v=>{let n=Number(String(v??'').replace('₪','').replaceAll(',','').replace(/\s/g,''));if(!Number.isFinite(n))throw new Error('סכום לא תקין');return Math.round(n*100)/100;};
const productLabel=(c,t)=>norm(c)===norm(t)?c:(/^\d+$/.test(String(t).trim())?`${c} ${t}`:`${c} (${t})`);
const creditNo=no=>/^C[\s-]*\d+$/i.test(String(no||'').trim());
const isoFromLegacy=d=>{const s=String(d||'').trim();if(/^\d{4}-\d{2}-\d{2}$/.test(s)){const [y,m,day]=s.split('-').map(Number);const z=new Date(y,m-1,day);return z.getFullYear()===y&&z.getMonth()===m-1&&z.getDate()===day?s:'';}const a=s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);if(!a)return '';const day=+a[1],m=+a[2],y=+a[3];const z=new Date(y,m-1,day);return z.getFullYear()===y&&z.getMonth()===m-1&&z.getDate()===day?`${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`:'';};
const legacyDate=iso=>iso?iso.slice(8,10)+'/'+iso.slice(5,7)+'/'+iso.slice(0,4):'';
function status(msg,kind=''){const n=el('status');n.textContent=msg;n.className='status '+kind;}
function toastCustomer(){const n=el('customerInput');n.classList.add('warning');setTimeout(()=>n.classList.remove('warning'),700);}
function pulseTotal(){const n=el('totalBlock');n.classList.remove('flash');void n.offsetWidth;n.classList.add('flash');setTimeout(()=>n.classList.remove('flash'),600);}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);}
async function loadAll(){[state.customers,state.products,state.archive,state.priceHistory]=RemotePos.active?Object.values(await RemotePos.loadAll()).slice(0,4):await Promise.all(['customers','products','archive','priceHistory'].map(allRows));state.customers.sort((a,b)=>a.name.localeCompare(b.name,'he'));state.products.sort((a,b)=>a.category.localeCompare(b.category,'he')||a.type.localeCompare(b.type,'he'));state.archive.sort((a,b)=>a.dateIso.localeCompare(b.dateIso)||a.time.localeCompare(b.time)||a.id.localeCompare(b.id));}
async function seedFirstTime(){const settings=await allRows('settings');if(settings.some(s=>s.key==='seeded'))return;const count=(await allRows('products')).length;if(!count){await bulkTransaction(['products','settings'],stores=>{for(const [name,price] of DEFAULT_PRODUCTS){const match=name.match(/^(.*) \((.+)\)$/),beer=name.match(/^(בירה) (\d+)$/),category=match?match[1]:(beer?beer[1]:name),type=match?match[2]:(beer?beer[2]:name);stores.products.add({id:uuid(),name,normalized:norm(name),category,type,price,active:true});}stores.settings.put({key:'seeded',value:true});});}else await putRow('settings',{key:'seeded',value:true});}
async function refresh({fromRemote=false,sections=null}={}){
 // Realtime already fetched the relevant rows. Never reload them again in the UI.
 if(fromRemote&&RemotePos.active){
  const changed=new Set(sections||['all']);
  const all=changed.has('all');
  if(all||changed.has('customers'))state.customers=RemotePos.customers.slice().sort((a,b)=>a.name.localeCompare(b.name,'he'));
  if(all||changed.has('products')){
   state.products=RemotePos.products.slice().sort((a,b)=>a.category.localeCompare(b.category,'he')||a.type.localeCompare(b.type,'he'));
   state.priceHistory=RemotePos.priceHistory.slice();
  }
  if(all||changed.has('archive'))state.archive=RemotePos.archive.slice().sort((a,b)=>a.dateIso.localeCompare(b.dateIso)||a.time.localeCompare(b.time)||a.id.localeCompare(b.id));
  if(all||changed.has('customers')){
   if(state.selectedCustomer)state.selectedCustomer=state.customers.find(c=>c.id===state.selectedCustomer.id&&c.active)||null;
   renderCustomer();renderBill();fillReportCustomers();
  }
  if(all||changed.has('products')){renderProducts();renderManage();}
  else if(changed.has('customers'))renderManage();
  if(all||changed.has('audit'))renderAudit();
  if(all||changed.has('archive'))renderReport();
  return;
 }
 await loadAll();
 if(state.selectedCustomer)state.selectedCustomer=state.customers.find(c=>c.id===state.selectedCustomer.id&&c.active)||null;
 renderCustomer();renderProducts();renderBill();renderManage();renderAudit();fillReportCustomers();renderReport();
}
function linkedEmployeeCustomer(){return state.customers.find(c=>c.id===RemotePos.linkedCustomerId&&c.active)||null;}
function renderCustomer(){
 const linked=state.employeeCharge?linkedEmployeeCustomer():null;
 el('customerSelectedText').textContent=state.employeeCharge?(linked?'חשבון עובד: '+linked.name+' · '+state.employeeChargePerson:'לא הוגדר חשבון עובד'):state.selectedCustomer?state.selectedCustomer.name:'לקוח';
 el('customerInput').disabled=state.employeeCharge;
 const desktopSearch=el('desktopCustomerSearch');
 if(desktopSearch){
  desktopSearch.disabled=state.employeeCharge;
  desktopSearch.value=state.employeeCharge?
   (linked?'חשבון עובד: '+linked.name+' · '+state.employeeChargePerson:'לא הוגדר חשבון עובד'):
   (state.selectedCustomer?.name||'');
  if(state.employeeCharge)closeDesktopCustomerOptions(false);
 }
 el('customerInput').classList.toggle('customer-selected',Boolean(state.selectedCustomer)||Boolean(linked));
 el('employeeChargeToggle').classList.toggle('active',state.employeeCharge);
 el('employeeChargeToggle').textContent=state.employeeCharge?'עבור '+state.employeeChargePerson+' ✎':'חיוב על עובד';
}
function openEmployeeChargeName(){
 if(state.busy||state.pendingOperation){status('יש לסיים את החיוב הקודם לפני מעבר מצב','error');return;}
 if(!RemotePos.active||!linkedEmployeeCustomer()){status('נדרש לקשר לעובד חשבון לקוח פעיל בניהול עובדים','error');return;}
 el('employeeChargePersonInput').value=state.employeeChargePerson||'';
 el('employeeChargeNameModal').classList.remove('hidden');
 el('employeeChargePersonInput').focus();
}
function closeEmployeeChargeName(){el('employeeChargeNameModal').classList.add('hidden');}
function confirmEmployeeChargeName(event){
 event.preventDefault();
 const name=el('employeeChargePersonInput').value.normalize('NFKC').trim().replace(/\\s+/g,' ');
 if(!name||name.length>100){el('employeeChargeNameError').textContent='יש להזין שם באורך עד 100 תווים';return;}
 if(!state.employeeCharge&&state.cart.length&&!confirm('מעבר לחיוב עובד ינקה את הפריטים שנבחרו. להמשיך?'))return;
 if(!state.employeeCharge){state.cart=[];state.cartHistory=[];state.selectedRow=-1;}
 state.selectedCustomer=null;state.employeeCharge=true;state.employeeChargePerson=name;
 state.pendingOperation=null;
 el('employeeChargeNameError').textContent='';closeEmployeeChargeName();closeCustomerDialog(false);renderBill();
 status('חיוב עובד עבור '+name+' פעיל','success');
}
function resetEmployeeCharge(){state.employeeCharge=false;state.employeeChargePerson='';renderCustomer();}

function desktopCustomerMode(){
 const mode=document.body.dataset.layoutMode;
 return (mode==='desktop'&&window.innerWidth>700)||(mode==='auto'&&window.innerWidth>=1101);
}
function desktopCustomerMatches(){
 const query=norm(el('desktopCustomerSearch').value);
 return state.customers.filter(c=>c.active&&customerNameMatches(c.name,query));
}
function closeDesktopCustomerOptions(restoreSelected=true){
 const options=el('desktopCustomerOptions'),input=el('desktopCustomerSearch');
 if(!options||!input)return;
 options.classList.add('hidden');
 input.setAttribute('aria-expanded','false');
 input.removeAttribute('aria-activedescendant');
 if(restoreSelected)input.value=state.selectedCustomer?.name||'';
}
function renderDesktopCustomerOptions(){
 if(!desktopCustomerMode()||state.employeeCharge){closeDesktopCustomerOptions(false);return;}
 const input=el('desktopCustomerSearch'),options=el('desktopCustomerOptions');
 const matches=desktopCustomerMatches();
 options.replaceChildren();
 for(const c of matches){
  const item=document.createElement('button');
  item.type='button';item.className='desktop-customer-option';
  item.setAttribute('role','option');item.setAttribute('aria-selected',String(state.selectedCustomer?.id===c.id));
  item.textContent=c.name;
  item.addEventListener('click',()=>selectCustomer(c));
  options.append(item);
 }
 if(!matches.length){
  const empty=document.createElement('div');empty.className='desktop-customer-empty';
  empty.textContent='לא נמצאו לקוחות מתאימים';options.append(empty);
 }
 options.classList.remove('hidden');input.setAttribute('aria-expanded','true');
}
function desktopCustomerKeydown(event){
 const input=el('desktopCustomerSearch'),options=el('desktopCustomerOptions');
 if(event.key==='Escape'){
  if(!options.classList.contains('hidden')){event.preventDefault();closeDesktopCustomerOptions();}
  return;
 }
 if(event.key==='ArrowDown'||event.key==='ArrowUp'){
  event.preventDefault();
  if(options.classList.contains('hidden'))renderDesktopCustomerOptions();
  const items=[...options.querySelectorAll('button.desktop-customer-option')];
  if(!items.length)return;
  const current=items.findIndex(item=>item===document.activeElement);
  const next=current<0?(event.key==='ArrowDown'?0:items.length-1):(current+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
  items[next].focus();
 }else if(event.key==='Enter'){
  event.preventDefault();
  const first=options.querySelector('button.desktop-customer-option')||(!options.classList.contains('hidden')?null:null);
  if(first)first.click();
  else if(options.classList.contains('hidden'))renderDesktopCustomerOptions();
 }else if(event.key==='Tab')closeDesktopCustomerOptions();
}
function openCustomerDialog(){el('customerDropdown').classList.remove('hidden');el('customerInput').setAttribute('aria-expanded','true');el('customerSearch').value='';renderCustomerResults();el('customerSearch').focus();}
function closeCustomerDialog(restoreFocus=true){el('customerDropdown').classList.add('hidden');el('customerInput').setAttribute('aria-expanded','false');if(restoreFocus)el('customerInput').focus();}
function toggleCustomerDropdown(){if(el('customerDropdown').classList.contains('hidden'))openCustomerDialog();else closeCustomerDialog();}
function renderCustomerResults(){const search=norm(el('customerSearch').value);const results=state.customers.filter(c=>c.active&&customerNameMatches(c.name,search));const host=el('customerResults');host.replaceChildren();el('customerResultCount').textContent=results.length+' לקוחות';for(const c of results){const b=document.createElement('button');b.type='button';b.className='customer-result';b.setAttribute('aria-pressed',String(state.selectedCustomer?.id===c.id));b.innerHTML='<span></span><span aria-hidden="true">‹</span>';b.firstChild.textContent=c.name;b.onclick=()=>selectCustomer(c);host.append(b);}if(!results.length){const empty=document.createElement('div');empty.className='customer-results-empty';empty.textContent='לא נמצאו לקוחות מתאימים';host.append(empty);}}
function selectCustomer(match){resetEmployeeCharge();state.selectedCustomer=match;renderCustomer();renderBill();closeDesktopCustomerOptions();if(!el('customerDropdown').classList.contains('hidden'))closeCustomerDialog();status('');}


async function addCustomer(name,select=true){assertManage('create_customers');name=String(name||'').trim().replace(/\s+/g,' ');if(!name)throw new Error('יש להזין שם לקוח');const key=norm(name),old=state.customers.find(c=>c.normalized===key);if(old){if(old.active)throw new Error('לקוח בשם זה כבר קיים');if(!confirm(`הלקוח ${old.name} אינו פעיל. להפעיל אותו מחדש?`))return;if(RemotePos.active)await RemotePos.saveCustomer({...old,active:true,name,normalized:key});else await putRow('customers',{...old,active:true,name,normalized:key});}else{const row={id:uuid(),name,normalized:key,active:true};if(RemotePos.active)await RemotePos.saveCustomer(row);else await putRow('customers',row);}await refresh();if(select){state.selectedCustomer=state.customers.find(c=>c.normalized===key);renderCustomer();renderBill();}status('הלקוח נשמר','success');}
function activeProducts(){return state.products.filter(p=>p.active);}
function renderProducts(){const cats=[...new Set(activeProducts().map(p=>p.category))];if(!cats.includes(state.category))state.category=cats[0]||null;const host=el('categories');host.replaceChildren();for(const c of cats){const b=document.createElement('button');b.className='button'+(state.category===c?' active':'');b.type='button';b.textContent=c;b.onclick=()=>{state.category=c;renderProducts();};host.append(b);}const products=activeProducts().filter(p=>p.category===state.category);const box=el('products');box.replaceChildren();for(const p of products){const b=document.createElement('button');b.type='button';b.className='button';const name=document.createElement('span'),price=document.createElement('span');name.textContent=p.type;price.className='product-price';price.textContent=currency(p.price);b.append(name,price);b.onclick=()=>addProductToCart(p);box.append(b);}if(!products.length)box.textContent='אין משקאות להצגה';el('productCounter').textContent=products.length+' פריטים';}
function addProductToCart(p){if(!state.employeeCharge&&!state.selectedCustomer){toastCustomer();status('צריך לבחור לקוח לפני הוספת משקה','error');return;}const qty=1;let index=state.cart.findIndex(r=>r.productId===p.id&&r.unitPrice===p.price);if(index>=0){const row=state.cart[index];if(row.qty+qty>999){status('לא ניתן לחרוג מכמות 999 למשקה','error');return;}row.qty+=qty;row.price=Math.round(row.unitPrice*row.qty*100)/100;}else{state.cart.push({id:uuid(),productId:p.id,drink:p.name,qty,unitPrice:p.price,price:Math.round(p.price*qty*100)/100});index=state.cart.length-1;}state.cartHistory.push({id:state.cart[index].id,qty});state.selectedRow=index;renderBill();pulseTotal();status('נוסף: '+p.name,'success');}
function renderBill(){const body=el('billBody');body.replaceChildren();if(!state.cart.length){const tr=document.createElement('tr');tr.innerHTML='<td colspan="3" class="empty">אין פריטים בחיוב</td>';body.append(tr);}else state.cart.forEach((r,i)=>{const tr=document.createElement('tr');tr.className=state.selectedRow===i?'selected':'';for(const val of [r.drink,String(r.qty),currency(r.price)]){const td=document.createElement('td');td.textContent=val;tr.append(td);}tr.onclick=()=>{state.selectedRow=i;renderBill();};body.append(tr);});el('total').textContent=currency(state.cart.reduce((s,r)=>s+r.price,0));el('billTag').textContent=state.cart.length?`${state.cart.length} שורות`:'מוכן';renderCustomer();}
function clearBill(){if(!state.cart.length&&!state.selectedCustomer&&!state.employeeCharge)return;if(state.cart.length&&!confirm('לנקות את החיוב הנוכחי?'))return;state.cart=[];state.cartHistory=[];state.selectedRow=-1;state.selectedCustomer=null;resetEmployeeCharge();renderBill();status('החיוב נוקה');}
function removeSelected(){if(!state.cart.length)return;const index=state.selectedRow>=0?state.selectedRow:state.cart.length-1;const removed=state.cart.splice(index,1)[0];state.cartHistory=state.cartHistory.filter(a=>a.id!==removed.id);state.selectedRow=Math.min(index,state.cart.length-1);renderBill();status('השורה הוסרה');}
function undoLast(){if(!state.cart.length)return;const last=state.cartHistory.pop();if(last){const index=state.cart.findIndex(r=>r.id===last.id);if(index>=0){const row=state.cart[index];row.qty-=last.qty;if(row.qty<=0)state.cart.splice(index,1);else row.price=Math.round(row.qty*row.unitPrice*100)/100;}}else state.cart.pop();state.selectedRow=state.cart.length-1;renderBill();status('הפעולה האחרונה בוטלה');}
async function completeSale(refund=false){if(state.busy)return;if(!RemotePos.active||!RemotePos.authenticated){showCloudLogin('יש להתחבר לפני חיוב או זיכוי');return;}const onEmployee=state.employeeCharge,personName=state.employeeChargePerson,customer=onEmployee?linkedEmployeeCustomer():state.selectedCustomer;if(!customer){toastCustomer();status('יש לבחור לקוח לפני חיוב','error');return;}if(onEmployee&&!personName.trim()){status('חסר שם אדם לחיוב עובד','error');return;}if(!state.cart.length){status('לא נבחרו משקאות','error');return;}if(RemotePos.active&&!RemotePos.testMode&&!RemotePos.isImported){const message='לא ניתן לשמור חיוב או זיכוי במצב עבודה: ארכיון הפאב המקורי טרם יובא למערכת. לא נשמרה עסקה. ניתן להשתמש בכפתור ניסיון בחשבון הבעלים לצורך בדיקות.';status(message,'error');alert(message);return;}if(refund&&!confirm(`לשמור זיכוי עסקה ללקוח ${customer.name} בסך ${currency(state.cart.reduce((s,r)=>s+r.price,0))}?`))return;state.busy=true;el('chargeBtn').disabled=true;el('refundBtn').disabled=true;try{const d=new Date(),op=uuid(),time=d.toTimeString().slice(0,8),dateIso=nowIso(),sign=refund?-1:1;const rows=state.cart.map(c=>({id:uuid(),operationId:op,customer:customer.name,customerKey:norm(customer.name),dateIso,time,drink:c.drink,qty:c.qty,price:Math.round(c.price*sign*100)/100,legacyNumber:'',kind:refund?'refund':'sale'}));if(RemotePos.active){
  const fingerprint=JSON.stringify({customer:customer.id,onEmployee,personName,refund,isTest:RemotePos.testMode===true,items:state.cart.map(x=>[x.productId,x.qty,x.unitPrice])});
  if(!state.pendingOperation||state.pendingOperation.fingerprint!==fingerprint){state.pendingOperation={fingerprint,op:uuid()};}
  if(onEmployee)await RemotePos.submitEmployeeCharge({operationId:state.pendingOperation.op,kind:refund?'refund':'sale',items:state.cart,deviceId:getDeviceId(),personName});
  else await RemotePos.submit({operationId:state.pendingOperation.op,customerId:customer.id,kind:refund?'refund':'sale',items:state.cart,deviceId:getDeviceId()});
  state.pendingOperation=null;
}else await saveSaleAtomic(rows);const total=rows.reduce((s,r)=>s+r.price,0),name=customer.name;state.cart=[];state.cartHistory=[];state.selectedRow=-1;state.selectedCustomer=null;resetEmployeeCharge();await refresh();if(refund){status(`${RemotePos.active&&RemotePos.testMode?'[ניסיון D] ':''}זיכוי נשמר עבור ${name}: ${currency(total)}`,'success');el('billTag').textContent='זיכוי נשמר';}else{status(onEmployee?'חיוב עבור '+personName+' נשמר בחשבון '+name:'',onEmployee?'success':'');const button=el('chargeBtn');button.classList.remove('charge-success');void button.offsetWidth;button.classList.add('charge-success');}}catch(e){const message='שמירת העסקה נכשלה: '+e.message+' — לא הוצג אישור שהעסקה נשמרה. בדוק את הארכיון לפני ניסיון חוזר.';status(message,'error');alert(message);}finally{setTimeout(()=>{state.busy=false;el('chargeBtn').disabled=false;el('refundBtn').disabled=false;},1050);}}
async function productSubmit(event){event.preventDefault();assertManage('create_products');const f=new FormData(event.target),category=String(f.get('category')||'').trim(),type=String(f.get('type')||'').trim(),price=amount(f.get('price'));if(!category||!type||price<0)throw new Error('יש למלא קטגוריה, משקה ומחיר תקין');const name=productLabel(category,type),existing=state.products.find(p=>p.normalized===norm(name));if(existing){if(existing.active)throw new Error('משקה בשם זה כבר קיים');if(!confirm('המשקה לא פעיל. להפעיל אותו מחדש?'))return;if(RemotePos.active)await RemotePos.saveProduct({...existing,active:true,category,type,price},{id:uuid(),productName:name,newPrice:price,changedAt:new Date().toISOString(),note:'הפעלה מחדש'});else await putRow('products',{...existing,active:true,category,type,price});}else{const row={id:uuid(),category,type,name,normalized:norm(name),price,active:true};if(RemotePos.active)await RemotePos.saveProduct(row,{id:uuid(),productName:name,newPrice:price,changedAt:new Date().toISOString(),note:'הוספת משקה'});else await putRow('products',row);}if(!RemotePos.active)await putRow('priceHistory',{id:uuid(),productName:name,newPrice:price,changedAt:new Date().toISOString(),note:existing?'הפעלה מחדש':'הוספת משקה'});event.target.reset();await refresh();status('מוצר נשמר','success');}
function catalogVisibleRows(){
 const entity=state.catalogDialog;
 if(!entity)return [];
 const rows=entity==='product'?state.products:state.customers;
 const inactive=entity==='product'?state.showInactiveProducts:state.showInactiveCustomers;
 const search=norm(state.catalogSearch);
 return rows.filter(r=>(inactive?!r.active:r.active)&&(!search||norm(r.name).includes(search)));
}
function renderCatalogSelection(){
 const rows=catalogVisibleRows(),ids=new Set(rows.map(r=>r.id));
 const selected=rows.filter(r=>state.catalogSelections.has(r.id)).length;
 const all=el('catalogSelectAll');
 all.checked=rows.length>0&&selected===rows.length;
 all.indeterminate=selected>0&&selected<rows.length;
 el('catalogSelectionCount').textContent=`${state.catalogSelections.size} נבחרו · ${rows.length} מוצגים`;
 el('catalogBulkDelete').classList.toggle('hidden',!(RemotePos.active&&RemotePos.employee?.is_owner===true));
 el('catalogBulkDelete').disabled=state.catalogSelections.size===0;
}
const POS_STAFF_PERMISSIONS=['create_products','change_prices','toggle_products','create_customers','toggle_customers','full_reports','manage_system'];
function canViewFullReports(){return RemotePos.active&&RemotePos.authenticated===true&&(RemotePos.employee?.owner_terminal===true||RemotePos.employee?.is_owner===true||RemotePos.employee?.permissions?.full_reports===true);}
function assertFullReportAccess(){if(!canViewFullReports())throw new Error('ייצוא ודוחות מלאים מחייבים הרשאה מתאימה');}
function canManage(permission){return RemotePos.active&&RemotePos.authenticated===true&&(RemotePos.employee?.is_owner===true||RemotePos.employee?.permissions?.[permission]===true);}
function assertManage(permission){if(!canManage(permission))throw new Error('אין לעובד הרשאה לפעולה זו');}
function renderManage(){
 const productsHost=el('manageProducts'),customersHost=el('manageCustomers');
 productsHost.replaceChildren();customersHost.replaceChildren();
 const products=state.catalogDialog==='product'?catalogVisibleRows():[];
 const customers=state.catalogDialog==='customer'?catalogVisibleRows():[];
 const owner=RemotePos.active&&RemotePos.employee?.is_owner===true;
 for(const p of products){
  const tr=document.createElement('tr');
  tr.innerHTML=`<td><input class="catalog-select-row" type="checkbox" data-catalog-id="${escapeHtml(p.id)}" aria-label="בחר ${escapeHtml(p.name)}" ${state.catalogSelections.has(p.id)?'checked':''} ${owner?'':'disabled'}></td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(currency(p.price))}</td><td>${p.active?'פעיל':'לא פעיל'}</td><td>${canManage('change_prices')?`<button class="tiny-btn" data-product="${escapeHtml(p.id)}" data-action="edit">ערוך מחיר</button>`:''}${canManage('toggle_products')?`<button class="tiny-btn ${p.active?'danger':''}" data-product="${escapeHtml(p.id)}" data-action="toggle">${p.active?'השבת':'הפעל'}</button>`:''}${owner?`<button class="tiny-btn danger" data-product="${escapeHtml(p.id)}" data-action="delete">מחק לצמיתות</button>`:''}</td>`;
  productsHost.append(tr);
 }
 for(const c of customers){
  const tr=document.createElement('tr');
  tr.innerHTML=`<td><input class="catalog-select-row" type="checkbox" data-catalog-id="${escapeHtml(c.id)}" aria-label="בחר ${escapeHtml(c.name)}" ${state.catalogSelections.has(c.id)?'checked':''} ${owner?'':'disabled'}></td><td>${escapeHtml(c.name)}</td><td>${c.active?'פעיל':'לא פעיל'}</td><td>${owner?`<button class="tiny-btn" data-customer="${escapeHtml(c.id)}" data-action="rename">שנה שם</button>`:''}${canManage('toggle_customers')?`<button class="tiny-btn ${c.active?'danger':''}" data-customer="${escapeHtml(c.id)}" data-action="toggle">${c.active?'השבת':'הפעל'}</button>`:''}${owner?`<button class="tiny-btn danger" data-customer="${escapeHtml(c.id)}" data-action="delete">מחק לצמיתות</button>`:''}</td>`;
  customersHost.append(tr);
 }
 for(const [id,on] of [['showInactiveProductsBtn',state.showInactiveProducts],['showInactiveCustomersBtn',state.showInactiveCustomers]]){
  el(id).textContent=on?'הצג פעילים':'הצג לא פעילים';
  el(id).setAttribute('aria-pressed',String(on));
 }
 renderCatalogSelection();
}
function openCatalogManager(entity){
 if(!['product','customer'].includes(entity))return;
 const permissions=entity==='product'?['create_products','change_prices','toggle_products']:['create_customers','toggle_customers'];
 if(!permissions.some(canManage)&&RemotePos.employee?.is_owner!==true)return;
 state.catalogDialog=entity;state.catalogSearch='';state.catalogSelections.clear();
 el('catalogManagerTitle').textContent=entity==='product'?'ניהול מוצרים':'ניהול לקוחות';
 el('catalogSearch').value='';
 el('catalogManagerMessage').textContent='';
 el('productManagerContent').classList.toggle('hidden',entity!=='product');
 el('customerManagerContent').classList.toggle('hidden',entity!=='customer');
 el('manageCatalogModal').classList.remove('hidden');
 renderManage();
 el('catalogSearch').focus();
}
function closeCatalogManager(){
 el('manageCatalogModal').classList.add('hidden');
 state.catalogDialog=null;state.catalogSearch='';state.catalogSelections.clear();
}
async function deleteSelectedCatalog(){
 if(!RemotePos.active||RemotePos.employee?.is_owner!==true)throw new Error('מחיקה מרובה זמינה רק בניהול מערכת לאחר אימות בעלים');
 if(state.busy||state.cart.length||state.pendingOperation)throw new Error('יש לסיים או לנקות את החיוב לפני מחיקה');
 const ids=[...state.catalogSelections];
 if(!ids.length)return;
 const entity=state.catalogDialog;
 if(!entity)throw new Error('לא נבחר חלון ניהול');
 const button=el('catalogBulkDelete');
 button.disabled=true;
 try{
  const preview=await RemotePos.bulkDeleteCatalog(entity,ids,false);
  const eligible=Number(preview.eligible||0),blocked=Number(preview.blocked||0);
  const lines=(preview.items||[]).filter(x=>x.allowed).reduce((n,x)=>n+Number(x.test_lines||0),0);
  if(!eligible){alert(`לא ניתן למחוק אף אחת מ-${ids.length} הרשומות שנבחרו. ניתן להשבית רשומות עם היסטוריית אמת או נתונים ישנים עם עסקאות D.`);return;}
  const names=(preview.items||[]).filter(x=>!x.allowed).map(x=>x.name).slice(0,8).join(', ');
  const message=`נבחרו ${ids.length} רשומות.\nניתן למחוק לצמיתות: ${eligible}.\nחסומות למחיקה: ${blocked}${names?' ('+names+')':''}.\nשורות ניסיון D שיוסרו: ${lines}.\n\nרשומות חסומות יישארו ללא שינוי, ועסקאות אמת לא יימחקו. להמשיך?`;
  if(!confirm(message))return;
  const typed=prompt(`אישור סופי למחיקה מרובה של ${eligible} רשומות.\nיש להקליד: מחק`);
  if(typed!=='מחק'){if(typed!==null)alert('המחיקה בוטלה');return;}
  const done=await RemotePos.bulkDeleteCatalog(entity,ids,true);
  const removed=(done.items||[]).filter(x=>x.allowed).map(x=>x.id);
  if(state.selectedCustomer&&removed.includes(state.selectedCustomer.id))state.selectedCustomer=null;
  state.catalogSelections.clear();
  await refresh();
  el('catalogManagerMessage').textContent=`נמחקו ${done.deleted} רשומות, ${done.blocked} נחסמו ושמרו על ההיסטוריה. הוסרו ${done.removed_test_lines} שורות D. הפעולות נרשמו ביומן.`;
  status(`מחיקה מרובה: ${done.deleted} רשומות נמחקו`,'success');
 }finally{button.disabled=false;renderCatalogSelection();}
}
function renderAudit(){
 const panel=el('auditPanel'),tbody=el('auditRows');
 const manager=RemotePos.active&&RemotePos.employee?.is_owner===true;
 panel.classList.toggle('hidden',!manager);
 tbody.replaceChildren();
 if(!manager)return;
 const actions={created:'נוסף',activated:'הופעל',deactivated:'הושבת',renamed:'שינוי שם',repriced:'שינוי מחיר',edited:'עודכן',deleted:'נמחק לצמיתות',
  disabled:'עובד הושבת',enabled:'עובד הופעל',pin_reset:'איפוס קוד עובד',owner_pin_bootstrap:'הוגדרה כניסת בעלים',owner_pin_reset:'שוחזר קוד בעלים'};
 const logs=Array.isArray(RemotePos.audit)?RemotePos.audit:[];
 for(const entry of logs){
   const old=entry.old_values||{},newer=entry.new_values||{};
   let details='';
   if(entry.action==='repriced')details=`${currency(old.price)} ← ${currency(newer.price)}`;
   else if(entry.action==='renamed')details=`${old.name||''} ← ${newer.name||''}`;
   else if(entry.action==='created')details=entry.entity_type==='product'?`מחיר ${currency(newer.price)}`:'לקוח חדש';
   else if(entry.action==='activated')details='הוחזר לרשימות הפעילות';
   else if(entry.action==='deactivated')details='הוסר ממסכי המכירה';
   else if(entry.action==='deleted')details=`נמחקו ${Number(newer.removed_test_lines||0)} שורות D · ${Number(newer.affected_test_transactions||0)} עסקאות ניסיון קשורות`;
   else if(entry.entity_type==='employee')details='פעולת ניהול עובדים';
   else details='פרטי הפריט עודכנו';
   const tr=document.createElement('tr');
   const values=[new Date(entry.changed_at).toLocaleString('he-IL'),entry.actor_name||'מערכת',entry.entity_name||'',
      actions[entry.action]||entry.action,details];
   for(const value of values){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}
   tbody.append(tr);
 }
 if(!logs.length){const tr=document.createElement('tr');tr.innerHTML='<td colspan="5" class="empty">טרם נרשמו שינויים</td>';tbody.append(tr);}
}
async function deleteCatalogRecord(entity,record){
 if(!RemotePos.active||RemotePos.employee?.is_owner!==true)
  throw new Error('מחיקה לצמיתות דורשת כניסה לניהול מערכת עם מייל וסיסמת בעלים');
 if(state.busy||state.cart.length||state.pendingOperation)
  throw new Error('יש לסיים או לנקות את החיוב הפתוח לפני מחיקה');
 const preview=await RemotePos.deleteCatalog(entity,record.id,false);
 const realCount=Number(preview.real_references||0);
 const trialCount=Number(preview.test_transactions||0);
 const lineCount=Number(preview.test_lines||0);
 if(preview.allowed!==true){
   const reason=realCount>0?
      `ל-${record.name} יש ${realCount} הפניות בעסקאות אמת. לא ניתן למחוק לצמיתות — אפשר להשבית.`:
      `הפריט ${record.name} לא נוצר במצב ניסיון וכבר משתתף ב-${trialCount} עסקאות D. ניתן להשביתו בלבד.`;
   alert(reason);return;
 }
 const kind=entity==='product'?'המשקה':'הלקוח';
 const first=`מחיקה לצמיתות של ${kind} "${record.name}"?\n\nהמחיקה תסיר ${lineCount} שורות D הקשורות אליו מתוך ${trialCount} עסקאות ניסיון.\nהמחיקה אינה ניתנת לביטול. עסקאות אמת לא יימחקו.\n\nלהמשיך?`;
 if(!confirm(first))return;
 const typed=prompt(`אישור סופי למחיקה לצמיתות של "${record.name}".\nלהשלמת המחיקה הקלד: מחק`);
 if(typed!=='מחק'){if(typed!==null)alert('המחיקה בוטלה: יש להקליד בדיוק "מחק".');return;}
 const done=await RemotePos.deleteCatalog(entity,record.id,true);
 if(done.deleted!==true)throw new Error('השרת לא אישר את המחיקה');
 if(state.selectedCustomer?.id===record.id)state.selectedCustomer=null;
 await refresh();
 status(`נמחק לצמיתות: ${record.name}. נמחקו ${lineCount} שורות ניסיון. הפעולה נרשמה ביומן.`,'success');
}
async function manageProductClick(e){const b=e.target.closest('button[data-product]');if(!b)return;if(b.dataset.action==='edit')assertManage('change_prices');if(b.dataset.action==='toggle')assertManage('toggle_products');const p=state.products.find(p=>p.id===b.dataset.product);if(!p)return;if(b.dataset.action==='delete'){await deleteCatalogRecord('product',p);return;}if(b.dataset.action==='toggle'){if(!confirm(`${p.active?'להסתיר את המשקה':'להחזיר את המשקה'} ${p.name}?`))return;if(RemotePos.active)await RemotePos.saveProduct({...p,active:!p.active});else await putRow('products',{...p,active:!p.active});}else{const val=prompt('מחיר חדש עבור '+p.name,String(p.price));if(val===null)return;const price=amount(val);if(price<0)throw new Error('מחיר לא יכול להיות שלילי');if(RemotePos.active)await RemotePos.saveProduct({...p,price},{id:uuid(),productName:p.name,oldPrice:p.price,newPrice:price,changedAt:new Date().toISOString(),note:'שינוי מחיר'});else{await putRow('products',{...p,price});await putRow('priceHistory',{id:uuid(),productName:p.name,oldPrice:p.price,newPrice:price,changedAt:new Date().toISOString(),note:'שינוי מחיר'});}}await refresh();}
async function manageCustomerClick(e){const b=e.target.closest('button[data-customer]');if(!b)return;if(b.dataset.action==='rename'&&RemotePos.employee?.is_owner!==true)throw new Error('שינוי שם לקוח שמור לבעלים');if(b.dataset.action==='toggle')assertManage('toggle_customers');const c=state.customers.find(c=>c.id===b.dataset.customer);if(!c)return;if(b.dataset.action==='delete'){await deleteCatalogRecord('customer',c);return;}if(b.dataset.action==='toggle'){if(!confirm(`${c.active?'למחוק את הלקוח מהרשימה הפעילה':'לשחזר את הלקוח'} ${c.name}?\nהיסטוריית המכירות תישמר.`))return;if(RemotePos.active)await RemotePos.saveCustomer({...c,active:!c.active});else await putRow('customers',{...c,active:!c.active});}else{const next=prompt('שם לקוח חדש',c.name);if(next===null)return;const newName=next.trim();if(!newName)throw new Error('שם לקוח לא יכול להיות ריק');if(state.customers.some(x=>x.id!==c.id&&x.normalized===norm(newName)))throw new Error('שם לקוח כבר קיים');if(RemotePos.active)await RemotePos.saveCustomer({...c,name:newName,normalized:norm(newName)});else await putRow('customers',{...c,name:newName,normalized:norm(newName)}); /* historical transaction name remains unchanged for audit */}await refresh();}
function fillReportCustomers(){const field=el('reportCustomer'),prior=field.value;field.replaceChildren();const all=new Set([...state.customers.map(c=>c.name),...state.archive.filter(r=>Boolean(r.isTest)===(RemotePos.active&&RemotePos.testMode===true)).map(r=>r.customer)]);const blank=document.createElement('option');blank.value='';blank.textContent='כל הלקוחות';field.append(blank);for(const name of [...all].sort((a,b)=>a.localeCompare(b,'he'))){const opt=document.createElement('option');opt.value=name;opt.textContent=name;field.append(opt);}if([...field.options].some(x=>x.value===prior))field.value=prior;}
function reportRowsRaw(){
 const full=canViewFullReports();
 if(!RemotePos.active||!RemotePos.authenticated)return [];
 const from=full?el('fromDate').value:'',to=full?el('toDate').value:'',customer=full?el('reportCustomer').value:'';
 if(from&&to&&from>to)throw new Error('תאריך התחלה גדול מתאריך סיום');
 const cutoff=Date.now()-24*60*60*1000;
 return state.archive.filter(r=>Boolean(r.isTest)===(RemotePos.active&&RemotePos.testMode===true)&&
  (full||(r.createdAt&&Date.parse(r.createdAt)>=cutoff&&Date.parse(r.createdAt)<=Date.now()))&&
  (!from||r.dateIso>=from)&&(!to||r.dateIso<=to)&&(!customer||r.customer===customer))
  .sort((a,b)=>(b.dateIso||'').localeCompare(a.dateIso||'')||(b.time||'').localeCompare(a.time||'')||String(b.id||'').localeCompare(String(a.id||'')));
}
function prepareReport(){const raw=reportRowsRaw(),kind=canViewFullReports()?el('reportType').value:'movements';let headers=[],rows=[],title='';if(kind==='byCustomer'){title='סיכום לפי לקוח';headers=['לקוח','מספר תנועות','סה״כ ₪'];const sums=new Map();for(const r of raw){const s=sums.get(r.customer)||{n:0,total:0};s.n++;s.total+=Number(r.price);sums.set(r.customer,s);}rows=[...sums.entries()].map(([k,s])=>[k,s.n,Math.round(s.total*100)/100]);}else if(kind==='byProduct'){title='סיכום לפי משקה';headers=['משקה','כמות נטו','סה״כ ₪'];const sums=new Map();for(const r of raw){const s=sums.get(r.drink)||{q:0,total:0};s.q+=Number(r.qty)*(r.price<0?-1:1);s.total+=Number(r.price);sums.set(r.drink,s);}rows=[...sums.entries()].map(([k,s])=>[k,s.q,Math.round(s.total*100)/100]);}else{title=kind==='endDay'?'דוח סגירת יום':'דוח תנועות';if(kind==='movements'){headers=['תאריך','שעה','עובד','לקוח','משקה','סוג','כמות','מחיר','מזהה'];rows=raw.map(r=>[legacyDate(r.dateIso),r.time,r.operatorName||'—',r.customer,r.drink,r.kind==='refund'||r.price<0?'זיכוי':'חיוב',Number(r.qty),Number(r.price),r.employeeCharge?'חיוב עובד — '+(r.employeeChargePerson||'ללא שם (ישן)'):'']);}else{headers=['תאריך','שעה','לקוח','משקה','כמות','מחיר ₪','סוג','מזהה'];rows=raw.map(r=>[legacyDate(r.dateIso),r.time,r.customer,r.drink,Number(r.qty),Number(r.price),r.kind==='refund'||r.price<0?'זיכוי':'חיוב',r.employeeCharge?'חיוב עובד':'']);}if(RemotePos.active&&RemotePos.testMode){headers.push('מזהה ניסיון');rows=rows.map((row,i)=>[...row,raw[i].testCode||'D']);}}return {headers,rows,title,raw};}
function renderReport(){const r=prepareReport();state.currentReport=r;el('reportTable').parentElement.classList.toggle('limited-24h-ten-rows',RemotePos.active&&RemotePos.authenticated===true&&!canViewFullReports());const head=el('reportHead'),body=el('reportBody');head.replaceChildren();body.replaceChildren();const tr=document.createElement('tr');for(const h of r.headers){const th=document.createElement('th');th.textContent=h;tr.append(th);}head.append(tr);for(const row of r.rows){const t=document.createElement('tr');for(const x of row){const c=document.createElement('td');c.textContent=typeof x==='number'?x.toLocaleString('he-IL',{maximumFractionDigits:2}):x;t.append(c);}body.append(t);}if(!r.rows.length){const t=document.createElement('tr');t.innerHTML=`<td colspan="${r.headers.length}" class="empty">אין נתונים לדוח בטווח שנבחר</td>`;body.append(t);}if(canViewFullReports()){const total=r.raw.reduce((n,x)=>n+Number(x.price||0),0),customers=new Set(r.raw.map(x=>x.customer)).size;el('reportSummary').innerHTML=`<div class="summary-card"><small>תנועות</small><strong>${r.raw.length}</strong></div><div class="summary-card"><small>לקוחות</small><strong>${customers}</strong></div><div class="summary-card"><small>${RemotePos.active&&RemotePos.testMode?'סה״כ ניסיון':'סה״כ נטו'}</small><strong>${escapeHtml(currency(total))}</strong></div>`;}else el('reportSummary').replaceChildren();return r;}
function downloadReportXlsx(){assertFullReportAccess();const r=renderReport();downloadBlob(buildExcel(r.headers,r.rows,r.title),`Manara_${el('reportType').value}_${nowIso()}.xlsx`);}
function csvEscape(v){return '"'+String(v??'').replaceAll('"','""')+'"';}
function downloadReportCsv(){assertFullReportAccess();const r=renderReport(),txt='\ufeff'+[r.headers,...r.rows].map(row=>row.map(csvEscape).join(',')).join('\r\n');downloadBlob(new Blob([txt],{type:'text/csv;charset=utf-8'}),`Manara_${el('reportType').value}_${nowIso()}.csv`);}
function parseCsv(source){const out=[];let row=[],value='',quoted=false;for(let i=0;i<source.length;i++){const c=source[i];if(quoted){if(c==='"'&&source[i+1]==='"'){value+='"';i++;}else if(c==='"')quoted=false;else value+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(value);value='';}else if(c==='\n'){row.push(value.replace(/\r$/,''));out.push(row);row=[];value='';}else value+=c;}if(value||row.length){row.push(value.replace(/\r$/,''));out.push(row);}return out;}
function parseLegacyCsv(text){const rows=parseCsv(text.replace(/^\ufeff/,''));const headers=(rows.shift()||[]).map(x=>x.trim());const find=(obj,...names)=>names.map(n=>obj[n]).find(x=>x!==undefined)??'';return {format:'legacy-csv',archive:rows.filter(r=>r.some(x=>x.trim())).map(r=>{const row=Object.fromEntries(headers.map((h,i)=>[h,r[i]||'']));return {customerName:find(row,'שם','שם לקוח','customer_name','name'),customerNo:find(row,"מס׳ לקוח","מס' לקוח",'מספר לקוח','customer_no'),saleDate:find(row,'תאריך','sale_date','date'),saleTime:find(row,'שעה','sale_time','time'),drink:find(row,'שתייה','שתיה','drink','product'),qty:find(row,'כמות','qty','quantity'),price:find(row,'מחיר','price','amount')};})};}
function normalizeLegacySource(data){let raw=data.archive||data.rows||data.movements;if(!Array.isArray(raw))throw new Error('הארכיון אינו מכיל רשומות');const originalCustomers=Array.isArray(data.customers)?data.customers:[],ignored={customers:0,movements:0},customers=new Map(),rows=[];let unknownNumber=0;const normalizedCounts=new Map();for(const customer of originalCustomers){const name=String(customer.name??customer.customerName??customer[0]??'').trim(),no=String(customer.customerNo??customer.customer_no??customer.no??customer[1]??'').trim();if(creditNo(no)){ignored.customers++;continue;}if(name){const key=norm(name);if(!customers.has(key))customers.set(key,{name,numbers:new Set()});customers.get(key).numbers.add(no);}}
 for(const entry of raw){const customer=String(entry.customerName??entry.customer_name??entry.customer??entry[0]??'').trim(),no=String(entry.customerNo??entry.customer_no??entry.no??entry[1]??'').trim(),d=String(entry.saleDate??entry.sale_date??entry.date??entry[2]??''),time=String(entry.saleTime??entry.sale_time??entry.time??entry[3]??'00:00:00'),drink=String(entry.drink??entry.product??entry[4]??'').trim(),qty=Number(entry.qty??entry[5]),price=amount(entry.price??entry[6]);if(creditNo(no)){ignored.movements++;continue;}if(!no)unknownNumber++;const dateIso=isoFromLegacy(d);if(!customer||!drink||!dateIso||!Number.isSafeInteger(qty)||qty<1)throw new Error('רשומת ארכיון ישן לא תקינה: '+JSON.stringify(entry).slice(0,140));const key=norm(customer);if(!customers.has(key))customers.set(key,{name:customer,numbers:new Set()});customers.get(key).numbers.add(no);rows.push({customer,customerKey:key,legacyNumber:no,dateIso,time,drink,qty,price,kind:price<0?'refund':'sale'});}
 const duplicateNames=[...customers.values()].filter(c=>c.numbers.size>1).map(c=>`${c.name}: ${[...c.numbers].join(', ')}`);
 const importedProducts=Array.isArray(data.products)?data.products.map(p=>{const name=String(p.name??p[0]??'').trim();const price=amount(p.price??p[1]);const category=String(p.category||name).trim();const type=String(p.type||p.productType||name).trim();if(!name||price<0)throw new Error('מוצר לא תקין בקובץ הייבוא');return {name,normalized:norm(name),price,category,type,active:p.active!==false&&p.active!==0};}):[];
 return {customers:[...customers.values()],rows,ignored,duplicateNames,unknownNumber,importedProducts};}
function rowIdentity(r){return [norm(r.customer),r.legacyNumber||'',r.dateIso,r.time,norm(r.drink),r.qty,Number(r.price).toFixed(2)].join('|');}
function previewImport(parsed){const existingByName=new Map(state.customers.map(c=>[c.normalized,c]));const currentCounts=new Map();for(const r of state.archive){const key=rowIdentity(r);currentCounts.set(key,(currentCounts.get(key)||0)+1);}const seenCounts=new Map(),toImport=[];for(const r of parsed.rows){const key=rowIdentity(r),seen=(seenCounts.get(key)||0)+1;seenCounts.set(key,seen);if(seen>(currentCounts.get(key)||0))toImport.push({...r,id:uuid(),operationId:'legacy-'+uuid()});}const newNames=parsed.customers.filter(c=>!existingByName.has(norm(c.name)));const existingDuplicates=parsed.customers.filter(c=>existingByName.has(norm(c.name))).map(c=>c.name);const productByName=new Map(state.products.map(p=>[p.normalized,p]));const productChanges=[],newProducts=[];
 for(const p of parsed.importedProducts){const existing=productByName.get(p.normalized);if(existing){if(Number(existing.price)!==Number(p.price)||existing.active!==p.active)productChanges.push({old:existing,updated:{...existing,price:p.price,active:p.active,category:p.category,type:p.type}});}else newProducts.push({...p,id:uuid()});}
 return {...parsed,toImport,newNames,existingDuplicates,productChanges,newProducts};}
function requireOwnerArchiveAccess(){if(!RemotePos.active||!RemotePos.authenticated||RemotePos.employee?.is_owner!==true||RemotePos.employee?.role!=='manager')throw new Error('גיבוי, שחזור וייבוא ארכיון דורשים כניסת בעלים מאומתת לניהול מערכת');}
async function loadLegacyFile(file){requireOwnerArchiveAccess();const text=await file.text();let data;if(file.name.toLowerCase().endsWith('.csv'))data=parseLegacyCsv(text);else{try{data=JSON.parse(text);}catch{throw new Error('קובץ JSON אינו תקין');}}requireOwnerArchiveAccess();const parsed=previewImport(normalizeLegacySource(data));state.pendingImport=parsed;const host=el('importPreview');host.classList.remove('hidden');host.innerHTML=`<p><strong>תצוגה מקדימה: ${escapeHtml(file.name)}</strong></p><p>תנועות בקובץ: ${parsed.rows.length} | תנועות חדשות: ${parsed.toImport.length} | לקוחות חדשים: ${parsed.newNames.length}</p><p>חשבונות כרדיט שדולגו: ${parsed.ignored.customers} | תנועות כרדיט שדולגו: ${parsed.ignored.movements}</p><p>לקוחות קיימים בשם זהה: ${parsed.existingDuplicates.length} | מוצרים חדשים: ${parsed.newProducts.length} | מוצרים עם מחירים/סטטוס שונים: ${parsed.productChanges.length}</p><p>${parsed.duplicateNames.length?'⚠ כפילויות מספרי חשבון בשם זהה: '+escapeHtml(parsed.duplicateNames.slice(0,7).join(' ; ')):'לא נמצאו חשבונות ישנים שונים עם שם זהה'}</p><p>${parsed.unknownNumber?'⚠ '+parsed.unknownNumber+' תנועות ללא מספר לקוח ישן — לא ניתן לזהות בהן כרדיט בוודאות.':''}</p><button type="button" class="button primary" id="confirmImportBtn">גבה וייבא רק את הרשומות החדשות</button>`;el('confirmImportBtn').onclick=()=>safeImportLegacy();el('legacyNotice').textContent='לא יתבצע ייבוא בלי אישור מפורש שלך.';}
async function safeImportLegacy(){requireOwnerArchiveAccess();if(RemotePos.active)throw new Error('ייבוא הארכיון הישן לענן יתבצע במנגנון ייעודי לאחר השלמת מעבר הנתונים המקומיים.');const p=state.pendingImport;if(!p)return;if(p.unknownNumber&&!confirm('בחלק מהרשומות אין מספר חשבון, ולכן לא ניתן לזהות בהן כרדיט. האם אתה בטוח שברצונך לייבא אותן?'))return;if((p.duplicateNames.length||p.existingDuplicates.length)&&!confirm('נמצאו שמות קיימים או כפילויות בחשבונות הישנים. לקוחות עם אותו שם יאוחדו ברשימה. היסטוריית התנועות תישמר. להמשיך?'))return;if(!confirm(`לייבא ${p.toImport.length} תנועות, ${p.newNames.length} לקוחות חדשים, ${p.newProducts.length} מוצרים חדשים ולעדכן ${p.productChanges.length} מוצרים קיימים? הגיבוי יורד לפני השינוי.`))return;const snapshot=await dbSnapshot();downloadBlob(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}),`Manara_before_legacy_import_${nowIso()}.json`);const activeKeys=new Set(state.customers.map(c=>c.normalized));await bulkTransaction(['customers','archive','products','priceHistory'],stores=>{for(const c of p.newNames){const key=norm(c.name);if(activeKeys.has(key))continue;stores.customers.add({id:uuid(),name:c.name,normalized:key,active:true});activeKeys.add(key);}for(const r of p.toImport)stores.archive.add(r);
 for(const product of p.newProducts)stores.products.add(product);
 for(const change of p.productChanges){stores.products.put(change.updated);stores.priceHistory.add({id:uuid(),productName:change.old.name,oldPrice:change.old.price,newPrice:change.updated.price,changedAt:new Date().toISOString(),note:'ייבוא מקופה ישנה'});}
 });state.pendingImport=null;el('importPreview').classList.add('hidden');el('legacyInput').value='';await refresh();el('legacyNotice').textContent=`הייבוא הושלם: ${p.toImport.length} תנועות, ${p.newNames.length} לקוחות, ${p.newProducts.length} מוצרים חדשים ו־${p.productChanges.length} עדכוני מוצרים.`;}
async function restoreBackup(file){requireOwnerArchiveAccess();if(RemotePos.active)throw new Error('שחזור ישיר בענן חסום כדי למנוע דריסה של עסקאות של עובדים אחרים. שמור את הגיבוי ופנה למנהל לשחזור מבוקר.');const data=JSON.parse(await file.text());validateBackup(data);if(!confirm('שחזור הגיבוי יחליף את כל הנתונים במכשיר זה. להמשיך?'))return;const old=await dbSnapshot();downloadBlob(new Blob([JSON.stringify(old,null,2)],{type:'application/json'}),`Manara_before_restore_${nowIso()}.json`);await dbReplaceFromBackup(data);state.selectedCustomer=null;state.cart=[];await refresh();alert('השחזור הושלם');}
async function promptInstall(){if(state.installPrompt){await state.installPrompt.prompt();state.installPrompt=null;el('installBtn').classList.add('hidden');}else alert('התקנה זמינה כאשר האפליקציה נפתחת ב־Chrome/Edge דרך HTTPS או localhost. פתח את תפריט הדפדפן ובחר התקנה.');}
function on(id,event,handler){el(id).addEventListener(event,e=>{try{Promise.resolve(handler(e)).catch(err=>{console.error(err);status(err.message,'error');alert(err.message);});}catch(err){console.error(err);status(err.message,'error');alert(err.message);}});}
const LAYOUT_STORAGE_KEY='manara-pos-display-mode';
const LAYOUT_OPTIONS=['auto','mobile','tablet','desktop'];
function getSavedLayoutMode(){
 try{const val=localStorage.getItem(LAYOUT_STORAGE_KEY);return LAYOUT_OPTIONS.includes(val)?val:'auto';}catch{return 'auto';}
}
// Move the existing controls, never clone them: handlers and employee identity stay intact.
function arrangeDesktopHeaderControls(){
 const mode=document.body.dataset.layoutMode;
 const desktop=(mode==='desktop'&&window.innerWidth>700)||(mode==='auto'&&window.innerWidth>=1101);
 const strip=el('globalControlStrip');
 const userBar=el('cloudUserBar'),gear=el('navigationGearBtn'),clock=el('clock');
 const left=el('desktopHeroGear'),right=el('desktopHeroIdentity');
 const customer=el('customerSelectWrap'),employeeCharge=el('employeeChargeToggle');
 const billControls=el('desktopBillingControls');
 if(desktop){
  if(gear.parentElement!==left)left.append(gear);
  if(userBar.parentElement!==right)right.append(userBar);
  if(clock.parentElement!==right)right.append(clock);
  // Move the original controls, preserving listeners and the current selection.
  if(customer.parentElement!==billControls)billControls.append(customer);
  if(employeeCharge.parentElement!==billControls)billControls.append(employeeCharge);
 }else{
  // Restore the original mobile/tablet control row and DOM order.
  if(customer.parentElement!==strip)strip.insertBefore(customer,strip.firstChild);
  if(employeeCharge.parentElement!==strip)customer.after(employeeCharge);
  if(clock.parentElement!==strip)strip.append(clock);
  if(userBar.parentElement!==strip)strip.append(userBar);
  if(gear.parentElement!==userBar)userBar.append(gear);
 }
 document.body.classList.toggle('desktop-hero-controls',desktop);
}
function applyLayoutMode(mode){
 if(!LAYOUT_OPTIONS.includes(mode))mode='auto';
 document.body.dataset.layoutMode=mode;
 arrangeDesktopHeaderControls();
 document.querySelectorAll('[data-layout-choice]').forEach(btn=>{
  const active=btn.dataset.layoutChoice===mode;
  btn.setAttribute('aria-pressed',String(active));
  btn.classList.toggle('selected',active);
 });
 const labels={auto:'אוטומטי — לפי רוחב המסך',mobile:'נייד — פריסה אנכית',tablet:'טאבלט — פריסה בינונית',desktop:'מחשב — פריסה רחבה'};
 el('deviceLayoutCurrent').textContent='מצב נבחר: '+labels[mode];
 if(typeof closeDesktopCustomerOptions==='function')closeDesktopCustomerOptions();
}
function saveLayoutMode(mode){
 if(!LAYOUT_OPTIONS.includes(mode))return;
 try{localStorage.setItem(LAYOUT_STORAGE_KEY,mode);}catch(e){console.warn('תצוגה לא נשמרה במכשיר',e);}
 applyLayoutMode(mode);
 closeLayoutDialog();
}
function openLayoutDialog(){
 el('deviceLayoutDialog').classList.remove('hidden');
 el('deviceLayoutBtn').setAttribute('aria-expanded','true');
 applyLayoutMode(getSavedLayoutMode());
 el('deviceLayoutClose').focus();
}
function closeLayoutDialog(){
 el('deviceLayoutDialog').classList.add('hidden');
 el('deviceLayoutBtn').setAttribute('aria-expanded','false');
}
function openNavigationMenu(){
 if(!RemotePos.authenticated||!RemotePos.active)return;
 el('navigationMenu').classList.remove('hidden');
 el('navigationGearBtn').setAttribute('aria-expanded','true');
 el('navigationMenuClose').focus();
}
function closeNavigationMenu(restoreFocus=true){
 el('navigationMenu').classList.add('hidden');
 el('navigationGearBtn').setAttribute('aria-expanded','false');
 if(restoreFocus&&!el('cloudUserBar').classList.contains('hidden'))el('navigationGearBtn').focus();
}
function navigateFromMenu(page){
 const allowed=['posPage','managePage','reportsPage','systemPage'];
 if(!allowed.includes(page))return;
 const tab=document.querySelector('.tab[data-page="'+page+'"]');
 if(!tab)return;
 tab.click();
 closeNavigationMenu(false);
}
function events(){
 // Defense in depth: do not let keyboard or synthetic UI events operate an
 // unlocked-looking page while the mandatory version check is unresolved.
 const isUpdateControl=target=>target instanceof Element&&Boolean(target.closest('#updateDialog')||target.closest('#startupScreen'));
 for(const eventName of ['click','submit']){
  document.addEventListener(eventName,event=>{
   if(softwareUpdate.verified||softwareUpdate.pendingForCart||isUpdateControl(event.target))return;
   event.preventDefault();event.stopImmediatePropagation();
  },true);
 }
 document.addEventListener('keydown',event=>{
  if(softwareUpdate.verified||softwareUpdate.pendingForCart||isUpdateControl(event.target))return;
  if(['Enter',' ','Escape','Tab'].includes(event.key)){
   event.preventDefault();event.stopImmediatePropagation();
   if(event.key==='Tab'&&!el('updateDialog').classList.contains('hidden')){
    (el('updateRetryBtn').classList.contains('hidden')?el('applyUpdateBtn'):el('updateRetryBtn')).focus();
   }
  }
 },true);
 window.addEventListener('resize',arrangeDesktopHeaderControls);
 on('deviceLayoutBtn','click',openLayoutDialog);on('deviceLayoutClose','click',closeLayoutDialog);on('deviceLayoutBackdrop','click',closeLayoutDialog);for(const btn of document.querySelectorAll('[data-layout-choice]'))btn.addEventListener('click',()=>saveLayoutMode(btn.dataset.layoutChoice));for(const b of document.querySelectorAll('.tab'))b.onclick=()=>{document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t===b));document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===b.dataset.page));if(b.dataset.page==='reportsPage'&&RemotePos.active){renderReport();renderEmployeeChargeReport();}if(b.dataset.page==='systemPage'&&RemotePos.active&&RemotePos.employee?.owner_terminal===true)BackupManager.refresh();el('globalControlStrip').classList.toggle('not-pos-page',b.dataset.page!=='posPage');};on('navigationGearBtn','click',openNavigationMenu);on('navigationMenuClose','click',()=>closeNavigationMenu());on('navigationMenuBackdrop','click',()=>closeNavigationMenu());for(const b of document.querySelectorAll('[data-nav-page]'))b.addEventListener('click',()=>navigateFromMenu(b.dataset.navPage));on('customerInput','click',toggleCustomerDropdown);
 on('desktopCustomerSearch','focus',renderDesktopCustomerOptions);
 on('desktopCustomerSearch','click',renderDesktopCustomerOptions);
 on('desktopCustomerSearch','input',renderDesktopCustomerOptions);
 on('desktopCustomerSearch','keydown',desktopCustomerKeydown);
 on('desktopCustomerOptions','keydown',event=>{
  const options=[...el('desktopCustomerOptions').querySelectorAll('button.desktop-customer-option')];
  const i=options.indexOf(document.activeElement);
  if(event.key==='Escape'){event.preventDefault();closeDesktopCustomerOptions();el('desktopCustomerSearch').focus();}
  else if(event.key==='ArrowDown'||event.key==='ArrowUp'){
   event.preventDefault();if(!options.length)return;
   options[(i+(event.key==='ArrowDown'?1:-1)+options.length)%options.length].focus();
  }else if(event.key==='Tab')closeDesktopCustomerOptions();
 });
 document.addEventListener('pointerdown',event=>{
  if(!el('desktopCustomerSelect').contains(event.target))closeDesktopCustomerOptions();
 });on('customerDialogBackdrop','click',()=>closeCustomerDialog(false));on('customerDialogClose','click',()=>closeCustomerDialog());on('customerSearch','input',renderCustomerResults);on('customerSearch','keydown',e=>{if(e.key==='Enter'){const first=el('customerResults').querySelector('.customer-result');if(first)first.click();}else if(e.key==='ArrowDown'){e.preventDefault();el('customerResults').querySelector('.customer-result')?.focus();}});on('customerResults','keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const opts=[...el('customerResults').querySelectorAll('.customer-result')],i=opts.indexOf(document.activeElement);opts[(i+(e.key==='ArrowDown'?1:-1)+opts.length)%opts.length]?.focus();}});document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!el('deviceLayoutDialog').classList.contains('hidden'))closeLayoutDialog();else if(!el('navigationMenu').classList.contains('hidden'))closeNavigationMenu();else if(!el('employeePicker').classList.contains('hidden'))closeEmployeePicker();else if(!el('customerDropdown').classList.contains('hidden'))closeCustomerDialog();}});on('quickAddCustomerBtn','click',async()=>{const name=prompt('שם לקוח חדש');if(name!==null)await addCustomer(name);});on('resetCustomerBtn','click',()=>{if(state.cart.length&&!confirm('ניקוי לקוח יבטל את החיוב הנוכחי. להמשיך?'))return;state.selectedCustomer=null;state.cart=[];state.cartHistory=[];state.selectedRow=-1;renderCustomer();renderBill();closeDesktopCustomerOptions();closeCustomerDialog();});on('removeSelectedBtn','click',removeSelected);on('undoBtn','click',undoLast);on('clearBtn','click',clearBill);on('chargeBtn','click',()=>completeSale(false));on('chargeBtn','animationend',e=>{if(e.target===el('chargeBtn'))el('chargeBtn').classList.remove('charge-success');});on('refundBtn','click',()=>completeSale(true));on('customerForm','submit',async e=>{e.preventDefault();await addCustomer(new FormData(e.target).get('name'),false);e.target.reset();});on('productForm','submit',productSubmit);on('manageProducts','click',manageProductClick);on('manageCustomers','click',manageCustomerClick);
 on('openProductManager','click',()=>openCatalogManager('product'));
 on('openCustomerManager','click',()=>openCatalogManager('customer'));
 on('closeCatalogManager','click',closeCatalogManager);
 on('catalogSearch','input',e=>{state.catalogSearch=e.target.value;state.catalogSelections.clear();renderManage();});
 on('catalogSelectAll','change',e=>{for(const r of catalogVisibleRows()){if(e.target.checked)state.catalogSelections.add(r.id);else state.catalogSelections.delete(r.id);}renderManage();});
 for(const id of ['manageProducts','manageCustomers'])on(id,'change',e=>{const box=e.target.closest('input[data-catalog-id]');if(!box)return;if(box.checked)state.catalogSelections.add(box.dataset.catalogId);else state.catalogSelections.delete(box.dataset.catalogId);renderCatalogSelection();});
 on('catalogBulkDelete','click',()=>deleteSelectedCatalog().catch(e=>{el('catalogManagerMessage').textContent='מחיקה לא בוצעה: '+e.message;status('מחיקה לא בוצעה: '+e.message,'error');}));
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!el('manageCatalogModal').classList.contains('hidden'))closeCatalogManager();});
 on('showInactiveProductsBtn','click',()=>{state.showInactiveProducts=!state.showInactiveProducts;state.catalogSelections.clear();renderManage();});
 on('showInactiveCustomersBtn','click',()=>{state.showInactiveCustomers=!state.showInactiveCustomers;state.catalogSelections.clear();renderManage();});
 on('refreshAuditBtn','click',async()=>{if(RemotePos.active)await refresh();});
for(const id of ['fromDate','toDate','reportCustomer','reportType'])on(id,'change',renderReport);on('showReportBtn','click',renderReport);on('exportExcelBtn','click',downloadReportXlsx);on('exportCsvBtn','click',downloadReportCsv);on('printBtn','click',()=>{assertFullReportAccess();renderReport();window.print();});on('downloadBackup','click',async()=>{requireOwnerArchiveAccess();return downloadBlob(new Blob([JSON.stringify(RemotePos.active?{format:'manara-web-backup-v1',app:'PUB Manara POS Web',version:'0.9-cloud',exportedAt:new Date().toISOString(),stores:{customers:state.customers,products:state.products,archive:state.archive,priceHistory:state.priceHistory,settings:[]}}:await dbSnapshot(),null,2)],{type:'application/json'}),`Manara_${RemotePos.active?'cloud_':''}backup_${nowIso()}.json`);});on('restoreFile','change',async e=>{if(e.target.files[0])await restoreBackup(e.target.files[0]);e.target.value='';});on('legacyInput','change',async e=>{if(e.target.files[0])await loadLegacyFile(e.target.files[0]);});on('installBtn','click',promptInstall);on('installBtnSystem','click',promptInstall);on('updateBadge','click',showUpdateDialog);on('laterUpdateBtn','click',hideUpdateDialog);on('updateRetryBtn','click',retryMandatoryVersionCheck);on('applyUpdateBtn','click',applySoftwareUpdate);on('checkUpdatesBtn','click',()=>checkSoftwareUpdates(true));window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.installPrompt=e;el('installBtn').classList.remove('hidden');});}

function getDeviceId(){let id=localStorage.getItem('manara_device_id');if(!id){id=uuid();localStorage.setItem('manara_device_id',id);}return id;}
function showCloudGate(message){el('cloudGate').classList.remove('hidden');el('cloudGateMessage').textContent=message;}
function selectEmployee(name){el('cloudUserName').value=name;el('employeeSelectedText').textContent=name||'עובד';el('employeePickerBtn').classList.toggle('employee-selected',Boolean(name));}
function closeEmployeePicker(){el('employeePicker').classList.add('hidden');el('employeePickerBtn').setAttribute('aria-expanded','false');el('employeePickerBtn').focus();}
function renderEmployeeChoices(){
 const filter=norm(el('employeeSearch').value),matches=state.availableEmployees.filter(name=>norm(name).includes(filter)),host=el('employeePickerResults');host.replaceChildren();el('employeePickerCount').textContent=matches.length+' עובדים פעילים';
 for(const name of matches){const b=document.createElement('button');b.type='button';b.className='button';b.textContent=name;b.onclick=()=>{selectEmployee(name);closeEmployeePicker();el('cloudPin').focus();};host.append(b);}
 if(!matches.length){const msg=document.createElement('p');msg.className='customer-results-empty';msg.textContent='לא נמצאו עובדים פעילים מתאימים';host.append(msg);}
}
async function openEmployeePicker(){
 el('employeePicker').classList.remove('hidden');el('employeePickerBtn').setAttribute('aria-expanded','true');el('employeeSearch').value='';el('employeePickerMessage').textContent='טוען עובדים פעילים…';el('employeePickerResults').replaceChildren();el('employeePickerCount').textContent='';
 try{state.availableEmployees=await RemotePos.listLoginEmployees();if(el('employeePicker').classList.contains('hidden'))return;el('employeePickerMessage').textContent='';renderEmployeeChoices();el('employeeSearch').focus();}
 catch(e){el('employeePickerMessage').textContent='לא ניתן לטעון את רשימת העובדים: '+e.message;}
}
function showCloudLogin(message=''){el('cloudLogin').classList.remove('hidden');el('loginMessage').textContent=message;el('cloudLoginTitle').textContent=state.switchingEmployee?'החלפת עובד':'כניסה לקופת מנרה';el('cancelEmployeeSwitch').classList.toggle('hidden',!state.switchingEmployee);}
function resetEmployeeSwitchForm(){
 selectEmployee('');
 el('cloudPin').value='';
 el('ownerSetupForm').classList.add('hidden');
}
function canReturnToPreviousEmployee(){
 return state.switchingEmployee&&RemotePos.active&&RemotePos.authenticated&&
  RemotePos.session?.pos_valid_until>Date.now();
}
function cancelEmployeeSwitch(){
 if(!canReturnToPreviousEmployee()){state.switchingEmployee=false;showCloudLogin('יש להתחבר לעובד כדי להשתמש בקופה');return;}
 state.switchingEmployee=false;
 resetEmployeeSwitchForm();
 leaveCloudLogin();
}
async function employeeSignOut(){
 if(!RemotePos.active||!RemotePos.authenticated){showCloudLogin('יש להתחבר לעובד כדי להשתמש בקופה');return;}
 if(state.busy||state.pendingOperation){alert('יש להמתין לסיום החיוב לפני יציאת עובד.');return;}
 if(state.cart.length&&!confirm('יש פריטים בחיוב שטרם נשמר. יציאה תבטל את החיוב הפתוח. לצאת מהקופה?'))return;
 const button=el('employeeSignOutBtn');
 button.disabled=true;
 try{
  // Close the interface immediately; server logout revokes this device's session.
  el('cloudLogin').classList.remove('hidden');
  await RemotePos.signOut();
  resetLockedWorkspace('העובד יצא מהקופה. יש להתחבר מחדש כדי להמשיך.');
 }catch(error){
  // Even on network failure, never leave the old interface unlocked.
  RemotePos.stop();RemotePos.active=false;RemotePos.authenticated=false;
  RemotePos.session=null;RemotePos.employee=null;
  localStorage.removeItem(POS_SESSION_KEY);
  resetLockedWorkspace('הקופה נעולה. יש להתחבר מחדש.');
  console.error('Employee logout failed:',error);
 }finally{button.disabled=false;}
}
function resetLockedWorkspace(message){
 RemotePos.onChange=null;
 RemotePos.statusCallback=null;
 state.switchingEmployee=false;
 state.cart=[];state.cartHistory=[];state.selectedCustomer=null;state.selectedRow=-1;
 state.employeeCharge=false;state.employeeChargePerson='';state.pendingOperation=null;
 state.customers=[];state.products=[];state.archive=[];state.priceHistory=[];state.currentReport=null;
 RemotePos.customers=[];RemotePos.products=[];RemotePos.archive=[];RemotePos.priceHistory=[];RemotePos.audit=[];
 closeEmployeeChargeReport(false);
 el('cloudGate').classList.add('hidden');
 el('cloudUserBar').classList.add('hidden');
 el('adminLogin').classList.add('hidden');
 el('adminPanel').classList.add('hidden');
 el('trialToggleBtn').classList.add('hidden');
 el('modeBanner').classList.add('hidden');
 el('ownerBackupPanel').classList.add('hidden');
 el('ownerLegacyPanel').classList.add('hidden');
 el('employeeChargeNameModal').classList.add('hidden');
 el('employeePicker').classList.add('hidden');
 el('navigationMenu').classList.add('hidden');
 el('archiveManagerModal').classList.add('hidden');
 el('employeeChargeReportModal').classList.add('hidden');
 el('manageCatalogModal').classList.add('hidden');
 state.pendingImport=null;
 el('importPreview').classList.add('hidden');
 resetEmployeeSwitchForm();
 renderCustomer();renderBill();renderReport();renderAudit();renderManage();
 showCloudLogin(message);
 el('cloudPin').focus();
}
function beginEmployeeSwitch(){
 if(state.busy||state.pendingOperation)throw new Error('יש להמתין לסיום החיוב לפני החלפת עובד');
 if(!RemotePos.active||!RemotePos.authenticated||!RemotePos.session?.pos_valid_until||RemotePos.session.pos_valid_until<=Date.now()){
   state.switchingEmployee=false;showCloudLogin('יש להתחבר מחדש לקופה');return;
 }
 state.switchingEmployee=true;
 resetEmployeeSwitchForm();
 showCloudLogin('בחר עובד אחר והזן קוד אישי. X יחזיר אותך לקופה ללא שינוי.');
}
function leaveCloudLogin(){el('cloudLogin').classList.add('hidden');}
function showCloudDataError(error){
 console.error('Cloud data could not be loaded after authentication:',error);
 leaveCloudLogin();
 el('cloudGateTitle').textContent='שגיאה בטעינת הנתונים';
 el('cloudGateCounts').textContent='';
 el('migrationPanel').classList.add('hidden');
 showCloudGate('ההתחברות הצליחה, אבל טעינת נתוני הענן נכשלה: '+(error?.message||'שגיאת שרת')+'. הנתונים לא שונו. אפשר לנסות שוב.');
 el('cloudBackToTest').classList.add('hidden');
}
function renderPermissions(){
 fillEmployeeCreateCustomers();
 fillEmployeeChargeReportOptions();
 const auth=RemotePos.employee||{};
 const owner=RemotePos.active&&auth.is_owner===true;
 const ownerTerminal=RemotePos.active&&auth.owner_terminal===true;
 const limitedAdmin=RemotePos.active&&!ownerTerminal&&auth.permissions?.manage_system===true;
 el('ownerAdminBox').classList.toggle('hidden',!ownerTerminal);
 el('staffAdminBox').classList.toggle('hidden',!limitedAdmin);
 el('staffAdminContent').classList.toggle('hidden',!(limitedAdmin&&RemotePos.staffAdminUnlocked===true));
 el('staffAdminEntryBtn').classList.toggle('hidden',limitedAdmin&&RemotePos.staffAdminUnlocked===true);
 el('staffAdminProductsBtn').classList.toggle('hidden',!['create_products','change_prices','toggle_products'].some(canManage));
 el('staffAdminCustomersBtn').classList.toggle('hidden',!['create_customers','toggle_customers'].some(canManage));
 el('staffAdminReportsBtn').classList.toggle('hidden',!canViewFullReports());
 el('archiveManageBtn').classList.toggle('hidden',!(ownerTerminal||limitedAdmin));
 el('newSystemDashboard').classList.toggle('hidden',!(ownerTerminal||limitedAdmin));
 for(const id of ['backupOwnerControls','backupAutoSection','backupHistorySection'])el(id).classList.toggle('hidden',!ownerTerminal);
 el('sqliteImportPanel').classList.toggle('hidden',!(ownerTerminal&&!RemotePos.isImported));
 const fullReports=canViewFullReports();
 el('reportControls').classList.toggle('hidden',!fullReports);
 el('employeeChargeReportOpen').classList.toggle('hidden',!RemotePos.active||!RemotePos.authenticated);
 if(!RemotePos.active||!RemotePos.authenticated)closeEmployeeChargeReport(false);
 el('reportAccessNote').textContent=fullReports?'כולל חיובים וזיכויים':'תנועות הקופה ב־24 השעות האחרונות; דוח חיובי עובד זמין בכפתור נפרד';
 el('reportSummary').classList.toggle('hidden',!fullReports);
 for(const id of ['fromDate','toDate','reportCustomer','reportType','exportExcelBtn','exportCsvBtn','printBtn'])el(id).disabled=!fullReports;
 if(!fullReports){el('reportType').value='movements';}
 renderReport();
 document.body.classList.toggle('staff-mode',!owner);
 el('productForm').classList.toggle('hidden',!canManage('create_products'));
 el('customerForm').classList.toggle('hidden',!canManage('create_customers'));
 el('quickAddCustomerBtn').classList.toggle('hidden',!canManage('create_customers'));
 el('openProductManager').classList.toggle('hidden',!['create_products','change_prices','toggle_products'].some(canManage));
 el('openCustomerManager').classList.toggle('hidden',!['create_customers','toggle_customers'].some(canManage));
 el('catalogSelectAll').disabled=!owner;
 el('catalogSelectAll').closest('label').classList.toggle('hidden',!owner);
 el('catalogSelectionCount').classList.toggle('hidden',!owner);
 el('adminEntryBtn').classList.toggle('hidden',!(RemotePos.active&&auth.owner_terminal));
 el('adminEntryBtn').textContent=owner?'ניהול מערכת פתוח · אמת מחדש':'פתח ניהול מערכת';
 el('adminPanel').classList.toggle('hidden',!owner);
 el('archiveImportPanel').classList.toggle('hidden',!owner||RemotePos.isImported);
 el('ownerBackupPanel').classList.toggle('hidden',!owner);
 el('ownerLegacyPanel').classList.toggle('hidden',!owner);
 for(const id of ['downloadBackup','restoreFile','legacyInput'])el(id).disabled=!owner;
 if(!owner){state.pendingImport=null;el('importPreview').classList.add('hidden');el('restoreFile').value='';el('legacyInput').value='';}
 if(!RemotePos.isImported&&owner)
  el('archiveImportNotice').textContent='ארכיון הפאב טרם יובא. במצב הרגיל החיובים חסומים עד לייבוא מהמחשב המקורי. אפשר לבצע ניסיונות D לאחר אימות בעלים.';
 renderModeControls();
 renderManage();
 renderAudit();
}
async function activateCloud(){
 state.employeeCharge=false;state.employeeChargePerson='';
 await RemotePos.start();
 await refresh({fromRemote:true});
 fillEmployeeChargeReportOptions();
 renderEmployeeChargeReport();
 el('cloudGate').classList.add('hidden');
 el('storageLabel').textContent=RemotePos.isImported?'ענן · עבודה':'ענן · ממתין לייבוא';
 el('cloudUser').textContent=RemotePos.employee?.display_name||'עובד';
 el('cloudUserBar').classList.remove('hidden');
 el('remoteSystemNotice').textContent='קופה אחת וארכיון משותף. עסקאות ניסיון מסוג D אינן נכללות בדוחות העבודה. נתונים מקומיים נשמרים עד ייבוא מאושר מהמחשב המקורי.';
 el('migrationPanel').classList.add('hidden');
 RemotePos.onChange=async sections=>{
  const changed=new Set(sections||['all']);
  await refresh({fromRemote:true,sections});
  if(changed.has('all')||changed.has('settings')){
   el('storageLabel').textContent=RemotePos.isImported?'ענן · עבודה':'ענן · ממתין לייבוא';
   renderPermissions();
  }
  if((changed.has('all')||changed.has('archive'))&&el('reportsPage').classList.contains('active')){
   fillEmployeeChargeReportOptions();
   await renderEmployeeChargeReport();
  }
 };
 RemotePos.statusCallback=(msg,kind)=>{el('cloudSync').textContent=msg;el('cloudSync').className='sync-msg '+(kind||'');};
 RemotePos.setStatus('מסונכרן עם כל הקופות','success');
 if(!RemotePos.isImported)status('ארכיון הפאב טרם יובא. חיובי אמת נעולים עד לייבוא.','');
 renderPermissions();
 if(RemotePos.employee?.owner_terminal===true)BackupManager.refresh();
}
function renderModeControls(){
 const owner=RemotePos.active&&RemotePos.employee?.is_owner===true;
 const trial=owner&&RemotePos.testMode===true;
 const button=el('trialToggleBtn');
 button.classList.toggle('hidden',!owner);
 button.textContent=trial?'ניסיון: פעיל':'ניסיון: כבוי';
 button.setAttribute('aria-pressed',String(trial));
 el('modeBanner').classList.toggle('hidden',!trial);
 el('modeBanner').textContent=trial?'ניסיון פעיל — כל שורת חיוב מקבלת מזהה D ואינה נכללת בדוחות העבודה':'';
 el('modeBanner').classList.toggle('development-banner',trial);
 el('modeBanner').classList.remove('live-banner');
 el('cloudBackToTest').classList.add('hidden');
}
async function toggleTrialMode(){
 if(RemotePos.employee?.is_owner!==true||!RemotePos.authenticated)throw new Error('רק בעל החשבון רשאי להשתמש בניסיון');
 if(state.busy||state.pendingOperation)throw new Error('יש לסיים או לאמת את תוצאת החיוב הקודם לפני החלפת מצב ניסיון');
 const newValue=!RemotePos.testMode;
 if(state.cart.length&&!confirm('מעבר מצב ניסיון ינקה את החיוב הפתוח. להמשיך?'))return;
 if(!newValue&&!confirm('לצאת ממצב ניסיון? החיובים הבאים יהיו אמיתיים רק לאחר ייבוא הארכיון המקורי.'))return;
 state.cart=[];state.cartHistory=[];state.selectedRow=-1;state.selectedCustomer=null;state.employeeCharge=false;state.employeeChargePerson='';state.pendingOperation=null;
 RemotePos.setTestMode(newValue);
 renderCustomer();renderBill();renderReport();renderModeControls();
 status(newValue?'ניסיון הופעל — חיובים יסומנו D':'מצב ניסיון כבוי — יופיעו רק עסקאות אמת','success');
}
async function cloudAfterAuthentication(){await activateCloud();leaveCloudLogin();}
async function loginCloud(event){
 event.preventDefault();
 if(!softwareUpdate.verified){
  const result=await checkSoftwareUpdates(true);
  if(result!=='current')return;
 }
 const btn=el('cloudLoginBtn');btn.disabled=true;
 el('cancelEmployeeSwitch').disabled=true;
 el('loginMessage').textContent='מתחבר לקופה…';
 const wasSwitch=canReturnToPreviousEmployee();
 const previous=wasSwitch?RemotePos.captureSwitchSession():null;
 let newSessionAuthenticated=false;
 try{
  if(!el('cloudUserName').value.trim())throw new Error('יש לבחור עובד מהרשימה');
  await RemotePos.loginPin(el('cloudUserName').value,el('cloudPin').value);
  newSessionAuthenticated=true;
  el('cloudPin').value='';
  // The previous employee is retained until the new employee has fully loaded.
  await activateCloud();
  state.switchingEmployee=false;
  leaveCloudLogin();
  if(previous){
   try{await RemotePos.revokePriorSession(previous);}
   catch(e){console.warn(e);status(e.message,'error');}
  }
 }catch(e){
  el('cloudPin').value='';
  if(newSessionAuthenticated&&previous){
   RemotePos.restoreSwitchSession(previous);
   try{await activateCloud();}catch(restoreError){console.error('Failed to refresh previous employee session',restoreError);}
  }
  showCloudLogin(e.message);
 }finally{btn.disabled=false;el('cancelEmployeeSwitch').disabled=false;}
}
async function setupOwner(event){
 event.preventDefault();
 const btn=el('ownerSetupSubmitBtn');btn.disabled=true;
 try{
  const username=el('ownerSetupName').value;
  const result=await RemotePos.bootstrapOwner(username,el('ownerSetupPin').value,
    el('ownerSetupEmail').value,el('ownerSetupPassword').value);
  el('ownerSetupPassword').value='';el('ownerSetupPin').value='';
  el('ownerSetupForm').classList.add('hidden');
  selectEmployee(username);
  el('loginMessage').textContent=result.message||'כניסת הבעלים הוגדרה. התחבר בשם ובקוד שהגדרת.';
 }catch(e){
  el('ownerSetupPassword').value='';el('ownerSetupPin').value='';
  el('loginMessage').textContent=e.message;
 }finally{btn.disabled=false;}
}
async function unlockStaffAdmin(event){
 event.preventDefault();
 if(RemotePos.employee?.owner_terminal===true||RemotePos.employee?.permissions?.manage_system!==true)throw new Error('אין הרשאה לניהול מוגבל');
 const btn=el('staffAdminUnlockBtn');btn.disabled=true;el('staffAdminLoginMessage').textContent='מאמת מול Supabase…';
 try{
  await RemotePos.elevateStaffAdmin(el('staffAdminLoginEmail').value,el('staffAdminLoginPassword').value);
  el('staffAdminLoginPassword').value='';
  el('staffAdminLogin').classList.add('hidden');
  renderPermissions();status('ניהול מוגבל אומת ל־30 דקות','success');
 }catch(e){el('staffAdminLoginPassword').value='';el('staffAdminLoginMessage').textContent=e.message;}
 finally{btn.disabled=false;}
}
async function lockStaffAdmin(){
 await RemotePos.lockStaffAdmin();
 renderPermissions();
 status('ניהול העובד ננעל; הכניסה לקופה נשארה פעילה','');
}
async function unlockAdmin(event){
 event.preventDefault();
 const btn=el('adminUnlockBtn');btn.disabled=true;
 el('adminMessage').textContent='מאמת את חשבון הבעלים…';
 try{
  await RemotePos.elevateOwner(el('adminEmail').value,el('adminPassword').value);
  el('adminPassword').value='';
  el('adminLogin').classList.add('hidden');
  await refresh();
  renderPermissions();
  await renderEmployeeList();
  status('ניהול מערכת נפתח ל־30 דקות. רק החשבון שלך מורשה לניסיון ולפעולות ניהול.','success');
 }catch(e){el('adminPassword').value='';el('adminMessage').textContent=e.message;}
 finally{btn.disabled=false;}
}

function fillEmployeeCreateCustomers(){
 const field=el('employeeCreateCustomer'),previous=field.value;field.replaceChildren();
 const blank=document.createElement('option');blank.value='';blank.textContent='ללא קישור';field.append(blank);
 for(const c of [...state.customers].filter(c=>c.active).sort((a,b)=>a.name.localeCompare(b.name,'he'))){
  const option=document.createElement('option');option.value=c.id;option.textContent=c.name;field.append(option);
 }
 if([...field.options].some(x=>x.value===previous))field.value=previous;
}
function openEmployeeCustomerLink(employee){
 if(RemotePos.employee?.is_owner!==true)throw new Error('קישור לקוח דורש אימות בעלים');
 el('employeeLinkTitle').textContent='חשבון לקוח: '+employee.username;
 const field=el('employeeLinkedCustomer');field.replaceChildren();
 const blank=document.createElement('option');blank.value='';blank.textContent='ללא קישור';field.append(blank);
 for(const c of [...state.customers].filter(c=>c.active||c.id===employee.linked_customer_id).sort((a,b)=>a.name.localeCompare(b.name,'he'))){
  const option=document.createElement('option');option.value=c.id;option.textContent=c.name+(c.active?'':' (לא פעיל)');option.disabled=!c.active;field.append(option);
 }
 field.value=employee.linked_customer_id||'';
 el('employeeLinkModal').dataset.employeeId=employee.user_id;
 el('employeeLinkMessage').textContent='';el('employeeLinkModal').classList.remove('hidden');
}
async function saveEmployeeCustomerLink(e){
 e.preventDefault();const button=el('employeeLinkSave');button.disabled=true;
 try{
  await RemotePos.manageStaff('set_customer_link',{user_id:el('employeeLinkModal').dataset.employeeId,customer_id:el('employeeLinkedCustomer').value||null});
  el('employeeLinkModal').classList.add('hidden');await renderEmployeeList();await refresh();
  el('employeeMessage').textContent='חשבון העובד עודכן. חיובים קודמים לא שונו.';
 }catch(err){el('employeeLinkMessage').textContent=err.message;}
 finally{button.disabled=false;}
}
function openEmployeeChargeReport(){
 if(!RemotePos.active||!RemotePos.authenticated)return;
 const modal=el('employeeChargeReportModal');
 modal.classList.remove('hidden');
 el('employeeChargeReportOpen').setAttribute('aria-expanded','true');
 document.body.classList.add('employee-charge-report-open');
 el('employeeChargeReportClose').focus();
 fillEmployeeChargeReportOptions();
 renderEmployeeChargeReport();
}
function closeEmployeeChargeReport(restoreFocus=true){
 const modal=el('employeeChargeReportModal');
 if(!modal||modal.classList.contains('hidden'))return;
 modal.classList.add('hidden');
 document.body.classList.remove('employee-charge-report-open');
 el('employeeChargeReportOpen').setAttribute('aria-expanded','false');
 if(restoreFocus&&!el('employeeChargeReportOpen').classList.contains('hidden'))el('employeeChargeReportOpen').focus();
}
async function renderEmployeeChargeReport(){
 if(!RemotePos.active||!RemotePos.authenticated)return;
 try{
  const employeeId=el('employeeChargeReportEmployee').value||null;
  const result=await RemotePos.employeeChargeReport(employeeId);
  const all=(Array.isArray(result)?result:[]).filter(x=>Boolean(x.isTest)===Boolean(RemotePos.testMode));
  const selector=el('employeeChargePersonFilter'),prior=selector.value;
  selector.replaceChildren();
  const blank=document.createElement('option');blank.value='';blank.textContent='כל האנשים';selector.append(blank);
  const persons=[...new Set(all.map(r=>r.personName||'ללא שם (חיוב ישן)'))].sort((a,b)=>a.localeCompare(b,'he'));
  for(const name of persons){const opt=document.createElement('option');opt.value=name;opt.textContent=name;selector.append(opt);}
  if(persons.includes(prior))selector.value=prior;
  const filter=selector.value;
  const rows=(filter?all.filter(r=>(r.personName||'ללא שם (חיוב ישן)')===filter):all).slice()
   .sort((a,b)=>Date.parse(b.date||0)-Date.parse(a.date||0)||String(b.transactionId||'').localeCompare(String(a.transactionId||'')));
  const body=el('employeeChargeReportBody');body.replaceChildren();
  for(const r of rows){
   const tr=document.createElement('tr');
   const vals=[new Date(r.date).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'}),r.employee||'—',r.personName||'ללא שם (חיוב ישן)',r.customer,r.drink,r.qty,currency(Number(r.amount)),r.kind==='refund'?'זיכוי עובד':'חיוב עובד'];
   for(const v of vals){const td=document.createElement('td');td.textContent=v;tr.append(td);}
   body.append(tr);
  }
  if(!rows.length){const tr=document.createElement('tr');tr.innerHTML='<td colspan="8" class="empty">אין חיובים מתאימים</td>';body.append(tr);}
  const amount=rows.reduce((sum,x)=>sum+Number(x.amount||0),0);
  el('employeeChargeReportSummary').textContent='סה״כ '+currency(amount)+' · '+new Set(rows.map(x=>x.transactionId)).size+' עסקאות';
  const sums=new Map();
  for(const r of all){const name=r.personName||'ללא שם (חיוב ישן)';sums.set(name,(sums.get(name)||0)+Number(r.amount||0));}
  const host=el('employeeChargePersonTotals');host.replaceChildren();
  for(const [name,total] of [...sums.entries()].sort((a,b)=>a[0].localeCompare(b[0],'he'))){
   const item=document.createElement('div');item.className='employee-charge-person-total';
   const label=document.createElement('span');label.textContent=name;
   const value=document.createElement('strong');value.textContent=currency(total);
   item.append(label,value);host.append(item);
  }
  el('employeeChargeReportMessage').textContent='';
 }catch(err){el('employeeChargeReportMessage').textContent='לא ניתן להציג חיובי עובד: '+err.message;}
}
function fillEmployeeChargeReportOptions(){
 const field=el('employeeChargeReportEmployee'),previous=field.value;
 field.classList.toggle('hidden',!canViewFullReports());field.replaceChildren();
 const own=document.createElement('option');own.value='';own.textContent='החיובים שלי';field.append(own);
 if(canViewFullReports()){
  const names=new Map();for(const row of state.archive){if(row.operatorId)names.set(row.operatorId,row.operatorName||'עובד');}
  for(const [id,name] of names){const opt=document.createElement('option');opt.value=id;opt.textContent=name;field.append(opt);}
 }
 if([...field.options].some(x=>x.value===previous))field.value=previous;
}

async function renderEmployeeList(){
 const host=el('employeeRows');host.replaceChildren();
 if(RemotePos.employee?.is_owner!==true)return;
 const showRemoved=el('showRemovedEmployees').checked;
 const result=await RemotePos.manageStaff('list');
 const employees=(result.employees||[]).filter(employee=>showRemoved?Boolean(employee.removed_at):!employee.removed_at);
 for(const employee of employees){
  const tr=document.createElement('tr');
  const name=document.createElement('td');name.textContent=employee.username;
  const condition=document.createElement('td');
  condition.textContent=employee.removed_at?'הוסר · כניסה חסומה':employee.active?'פעיל':'לא פעיל';
  const actions=document.createElement('td');
  if(employee.removed_at){
   const restore=document.createElement('button');restore.type='button';
   restore.className='tiny-btn';restore.textContent='שחזר עובד';
   restore.onclick=()=>changeStaffRemoval(employee,'restore_removed').catch(error=>{el('employeeMessage').textContent=error.message;});
   actions.append(restore);
  }else{
   if(employee.owner_terminal){
    actions.textContent='חשבון בעלים · איפוס דרך מסך הכניסה';
   }else{
    const toggle=document.createElement('button');toggle.type='button';toggle.className='tiny-btn';
    toggle.textContent=employee.active?'השבת':'הפעל';toggle.onclick=()=>editEmployee(employee,employee.active?'disable':'enable');
    const reset=document.createElement('button');reset.type='button';reset.className='tiny-btn';
    reset.textContent='שנה קוד';reset.onclick=()=>editEmployee(employee,'reset_pin');
    const permissions=document.createElement('button');permissions.type='button';permissions.className='tiny-btn';
    permissions.textContent='הרשאות';permissions.onclick=()=>openEmployeePermissions(employee);
    const remove=document.createElement('button');remove.type='button';remove.className='tiny-btn danger';
    remove.textContent='מחק עובד';
    remove.onclick=()=>changeStaffRemoval(employee,'soft_remove').catch(error=>{el('employeeMessage').textContent=error.message;});
    actions.append(toggle,reset,permissions,remove);
   }
   const link=document.createElement('button');link.type='button';link.className='tiny-btn';
   link.textContent='חשבון: '+(state.customers.find(c=>c.id===employee.linked_customer_id)?.name||'לא מקושר');
   link.onclick=()=>openEmployeeCustomerLink(employee);
   actions.append(link);
  }
  tr.append(name,condition,actions);host.append(tr);
 }
 if(!employees.length){
  const row=document.createElement('tr');
  row.innerHTML='<td colspan="3" class="empty">'+(showRemoved?'אין עובדים שהוסרו':'עדיין לא הוגדרו עובדים')+'</td>';
  host.append(row);
 }
}
async function changeStaffRemoval(employee,operation){
 if(RemotePos.employee?.is_owner!==true||employee.owner_terminal)throw new Error('מחיקת עובדים ושחזורם דורשים הרשאת בעלים');
 const restore=operation==='restore_removed';
 const question=restore
  ?'לשחזר את '+employee.username+' ולאפשר לו להתחבר שוב בקוד הקיים?'
  :'למחוק את '+employee.username+' מרשימת העובדים ולחסום את כניסתו?\\n\\nכל החיובים והזיכויים שביצע, כולל חיובים על חשבון עובד, יישמרו בארכיון. אפשר לשחזר את העובד בהמשך.';
 if(!confirm(question.replaceAll('\\n','\n')))return;
 const buttons=el('employeeRows').querySelectorAll('button');
 buttons.forEach(btn=>btn.disabled=true);
 try{
  const result=await RemotePos.manageStaff(operation,{user_id:employee.user_id});
  el('employeeMessage').textContent=result.message||(restore?'העובד שוחזר':'העובד הוסר');
  await renderEmployeeList();
 }finally{buttons.forEach(btn=>btn.disabled=false);}
}
function openEmployeePermissions(employee){
 if(!RemotePos.active||RemotePos.employee?.is_owner!==true||employee.owner_terminal)throw new Error('ניהול הרשאות שמור לבעלים');
 state.permissionEmployee=employee;
 const form=el('employeePermissionsForm');
 for(const key of POS_STAFF_PERMISSIONS)form.elements.namedItem(key).checked=employee.permissions?.[key]===true;
 el('staffAdminEmail').value=employee.admin_email||'';
 el('staffAdminEmailField').classList.toggle('hidden',employee.permissions?.manage_system!==true);
 el('employeePermissionsName').textContent='עובד: '+employee.username;
 el('employeePermissionsMessage').textContent='';
 el('employeePermissionsModal').classList.remove('hidden');
}
function closeEmployeePermissions(){
 el('employeePermissionsModal').classList.add('hidden');
 state.permissionEmployee=null;
}
async function saveEmployeePermissions(e){
 e.preventDefault();
 if(!state.permissionEmployee||RemotePos.employee?.is_owner!==true)throw new Error('נדרש אימות בעלים');
 const employee=state.permissionEmployee,button=el('employeePermissionsSave');
 const permissions=Object.fromEntries(POS_STAFF_PERMISSIONS.map(key=>[key,el('employeePermissionsForm').elements.namedItem(key).checked]));
 const admin_email=permissions.manage_system?el('staffAdminEmail').value.trim():'';
 button.disabled=true;
 try{
  const result=await RemotePos.manageStaff('set_permissions',{user_id:employee.user_id,permissions,admin_email});
  el('employeeMessage').textContent=result.message||'ההרשאות נשמרו';
  closeEmployeePermissions();
  await renderEmployeeList();
 }catch(err){el('employeePermissionsMessage').textContent=err.message;}
 finally{button.disabled=false;}
}
async function editEmployee(employee,operation){
 if(RemotePos.employee?.is_owner!==true)throw new Error('ניהול עובדים דורש אימות בעלים');
 const details={user_id:employee.user_id};
 if(operation==='reset_pin'){
  const pin=prompt('סיסמה חדשה בת ארבעה תווים עבור '+employee.username);
  if(pin===null)return;
  if(Array.from(pin).length!==4)throw new Error('יש להזין בדיוק ארבעה תווים');
  details.pin=pin;
 }else if(!confirm((operation==='disable'?'להשבית את ':'להפעיל את ')+employee.username+'?'))return;
 const response=await RemotePos.manageStaff(operation,details);
 el('employeeMessage').textContent=response.message||'פרטי העובד עודכנו';
 await renderEmployeeList();await refresh();
}
async function createEmployee(event){
 event.preventDefault();
 if(RemotePos.employee?.is_owner!==true)throw new Error('ניהול עובדים דורש אימות בעלים');
 const name=el('employeeCreateName').value,pin=el('employeeCreatePin').value;
 if(Array.from(pin).length!==4)throw new Error('יש להזין סיסמה בת ארבעה תווים');
 const submit=event.target.querySelector('button[type="submit"]');
 submit.disabled=true;
 try{
  const created=await RemotePos.manageStaff('create',{username:name,pin});
  const customerId=el('employeeCreateCustomer').value||null;
  el('employeeCreatePin').value='';el('employeeCreateName').value='';el('employeeCreateCustomer').value='';
  let msg='העובד נוסף ויכול להתחבר לקופה באמצעות השם והסיסמה שהוגדרו.';
  if(customerId&&created.employee?.user_id){
   try{await RemotePos.manageStaff('set_customer_link',{user_id:created.employee.user_id,customer_id:customerId});msg+=' חשבון הלקוח קושר בהצלחה.';}
   catch(error){msg+=' הקישור ללקוח לא נשמר: '+error.message+' — ניתן להגדיר אותו בעריכת העובד.';}
  }
  el('employeeMessage').textContent=msg;
  await renderEmployeeList();await refresh();
 }finally{submit.disabled=false;}
}
async function lockAdmin(){
 if(RemotePos.employee?.is_owner!==true)return;
 if(RemotePos.testMode)RemotePos.setTestMode(false);
 await RemotePos.lockAdmin();
 await refresh();renderPermissions();
 status('ניהול מערכת ננעל. כניסת העובד נותרה פעילה.','');
}
async function enforceShiftExpiry(){
 if(!RemotePos.session?.pos_valid_until||Date.now()<RemotePos.session.pos_valid_until)return;
 // The login overlay locks the UI before any asynchronous server sign-out.
 el('cloudLogin').classList.remove('hidden');
 try{await RemotePos.signOut();}
 finally{
  RemotePos.stop();RemotePos.active=false;RemotePos.authenticated=false;RemotePos.session=null;RemotePos.employee=null;
  localStorage.removeItem(POS_SESSION_KEY);
  resetLockedWorkspace('חלפו 24 שעות מתחילת המשמרת. יש להיכנס שוב בשם ובקוד.');
 }
}
async function migrateCloud(){
 const btn=el('cloudImportFromSystemBtn');btn.disabled=true;
 try{
  requireOwnerArchiveAccess();
  if(RemotePos.isImported)throw new Error('הארכיון כבר יובא; לא ניתן לייבא אותו שוב');
  if(!navigator.onLine)throw new Error('ייבוא דורש חיבור לאינטרנט');
  if(!confirm('האם זה מחשב הפאב המקורי המכיל את כל הארכיון? אין לבצע ייבוא ממחשב העבודה או מהטלפון. להמשיך?'))return;
  const snapshot=await dbSnapshot();
  if(!Array.isArray(snapshot.stores?.archive)||snapshot.stores.archive.length<1)
    throw new Error('לא נמצאו תנועות בארכיון המקומי. הייבוא נחסם כדי למנוע בחירה במחשב שאינו מחשב הפאב.');
  downloadBlob(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}),`Manara_BEFORE_CLOUD_${nowIso()}.json`);
  if(!confirm(`גיבוי מקומי הורד. לייבא ממחשב זה ${snapshot.stores.archive.length} שורות ארכיון, ${snapshot.stores.customers.length} לקוחות ו-${snapshot.stores.products.length} משקאות? לא יימחקו נתונים מהמחשב.`))return;
  requireOwnerArchiveAccess();
  const imported=await RemotePos.importLocal(snapshot);
  if(Number(imported?.archive_rows)!==snapshot.stores.archive.length)
     throw new Error('מספר שורות הארכיון אינו תואם למקור; יש לעצור ולבדוק');
  const localSum=Math.round(snapshot.stores.archive.reduce((n,row)=>n+Number(row.price||0),0)*100)/100;
  if(Math.abs(Number(imported?.archive_sum)-localSum)>0.009)
     throw new Error('סכום הארכיון בשרת אינו תואם למקור; יש לעצור ולבדוק');
  await activateCloud();
  alert('הארכיון המקורי יובא ואומת. הנתונים המקומיים לא נמחקו.');
 }catch(error){
  el('archiveImportNotice').textContent='הייבוא נעצר: '+error.message;
  status('ייבוא נעצר: '+error.message,'error');
 }finally{btn.disabled=false;}
}
function remoteEvents(){
 ArchiveAdmin.init();
 LegacyDbImport.init();
 BackupManager.init();
 on('employeeChargeToggle','click',openEmployeeChargeName);
 on('employeeChargeNameCancel','click',closeEmployeeChargeName);
 on('employeeChargeNameClose','click',closeEmployeeChargeName);
 on('employeeChargeNameBackdrop','click',closeEmployeeChargeName);
 el('employeeChargeNameForm').addEventListener('submit',confirmEmployeeChargeName);
 on('employeeChargeReportOpen','click',openEmployeeChargeReport);
 on('employeeChargeReportClose','click',()=>closeEmployeeChargeReport());
 on('employeeChargeReportBackdrop','click',()=>closeEmployeeChargeReport());
 on('employeeChargeReportModal','keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();closeEmployeeChargeReport();}
  if(event.key==='Tab'){
   const all=[...el('employeeChargeReportModal').querySelectorAll('button:not([disabled]):not(.hidden),select:not([disabled]):not(.hidden)')];
   if(!all.length)return;
   const first=all[0],last=all[all.length-1];
   if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
   else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
 });
 on('employeeChargeReportRefresh','click',()=>renderEmployeeChargeReport());
 on('employeeChargeReportEmployee','change',()=>{el('employeeChargePersonFilter').value='';renderEmployeeChargeReport();});
 on('employeeChargePersonFilter','change',()=>renderEmployeeChargeReport());
 on('employeeLinkClose','click',()=>el('employeeLinkModal').classList.add('hidden'));
 on('employeeLinkCancel','click',()=>el('employeeLinkModal').classList.add('hidden'));
 el('employeeLinkForm').addEventListener('submit',saveEmployeeCustomerLink);
 el('employeePermissionsForm').addEventListener('submit',saveEmployeePermissions);
 on('manageSystemPermission','change',e=>el('staffAdminEmailField').classList.toggle('hidden',!e.target.checked));
 el('staffAdminUnlockForm').addEventListener('submit',unlockStaffAdmin);
 on('staffAdminEntryBtn','click',()=>{
  if(RemotePos.employee?.permissions?.manage_system!==true||RemotePos.employee?.owner_terminal===true)throw new Error('אין הרשאה');
  el('staffAdminLoginMessage').textContent='';
  el('staffAdminLogin').classList.remove('hidden');
  el('staffAdminLoginEmail').focus();
 });
 on('staffAdminCancelBtn','click',()=>{el('staffAdminLoginPassword').value='';el('staffAdminLogin').classList.add('hidden');});
 on('staffAdminLockBtn','click',lockStaffAdmin);
 on('staffAdminProductsBtn','click',()=>openCatalogManager('product'));
 on('staffAdminCustomersBtn','click',()=>openCatalogManager('customer'));
 on('staffAdminReportsBtn','click',()=>document.querySelector('.tab[data-page="reportsPage"]')?.click());
 on('employeePermissionsClose','click',closeEmployeePermissions);
 on('employeePermissionsCancel','click',closeEmployeePermissions);
 on('employeePermissionsBackdrop','click',closeEmployeePermissions);
 on('employeePickerBtn','click',openEmployeePicker);
 on('employeePickerBackdrop','click',closeEmployeePicker);
 on('employeePickerClose','click',closeEmployeePicker);
 on('employeeSearch','input',renderEmployeeChoices);
 el('cloudLoginForm').addEventListener('submit',loginCloud);
 el('ownerSetupForm').addEventListener('submit',setupOwner);
 on('ownerSetupToggle','click',()=>{
  el('ownerSetupForm').classList.toggle('hidden');
  el('loginMessage').textContent='';
 });
 el('adminUnlockForm').addEventListener('submit',unlockAdmin);
 on('adminEntryBtn','click',()=>{
  if(RemotePos.employee?.owner_terminal!==true)throw new Error('ניהול מערכת שמור לחשבון הבעלים');
  el('adminMessage').textContent='';
  el('adminLogin').classList.remove('hidden');
  el('adminEmail').focus();
 });
 on('adminCancelBtn','click',()=>{el('adminPassword').value='';el('adminLogin').classList.add('hidden');});
 on('adminLockBtn','click',lockAdmin);
 el('employeeCreateForm').addEventListener('submit',e=>Promise.resolve(createEmployee(e)).catch(err=>{el('employeeMessage').textContent=err.message;}));
 on('showRemovedEmployees','change',()=>renderEmployeeList().catch(error=>{el('employeeMessage').textContent=error.message;}));
 on('trialToggleBtn','click',toggleTrialMode);
 on('cloudImportFromSystemBtn','click',migrateCloud);
 on('cloudMigrateBtn','click',migrateCloud);
 on('cloudRetryBtn','click',async()=>{try{await cloudAfterAuthentication();}catch(e){showCloudDataError(e);}});
 on('cloudSignOut','click',beginEmployeeSwitch);
 on('employeeSignOutBtn','click',employeeSignOut);
 on('cancelEmployeeSwitch','click',cancelEmployeeSwitch);
}
function setStartupMessage(message){
 const node=el('startupScreenMessage');
 if(node)node.textContent=message;
}
function finishStartup(){
 const screen=el('startupScreen');
 if(screen)screen.hidden=true;
}
function failStartup(error){
 console.error('Failed to initialize POS safely:',error);
 const screen=el('startupScreen');
 if(!screen)return;
 screen.hidden=false;
 screen.classList.add('is-error');
 setStartupMessage('פתיחת הקופה נכשלה: '+(error?.message||'שגיאה לא ידועה')+'. יש לבדוק חיבור ולנסות שוב.');
}
async function init(){
 applyLayoutMode(getSavedLayoutMode());
 el('versionLabel').textContent='V'+APP_VERSION;
 const stamp=()=>el('clock').textContent=`${nowDisplay()} · ${clockTime().slice(0,5)}`;
 stamp();setInterval(stamp,30000);
 setStartupMessage('מכין את מסכי הקופה…');
 events();
 const today=nowIso();
 el('fromDate').value=today.slice(0,8)+'01';el('toDate').value=today;
 await openDatabase();await seedFirstTime();await refresh();
 remoteEvents();
 // Verify the installed version BEFORE restoring a session or unlocking the POS.
 // Failure and pending updates leave the mandatory dialog blocking all operations.
 setStartupMessage('בודק את גרסת הקופה…');
 const versionGate=await setupSoftwareUpdater();
 if(versionGate!=='current'){
  showCloudLogin('יש לעדכן את התוכנה לפני פתיחת הקופה.');
  finishStartup();
  return;
 }
 // Keep the startup overlay visible until an authenticated session is ready
 // or the employee login screen is ready. Never expose a partially filled POS.
 showCloudLogin('יש להתחבר כדי לעבוד על הארכיון המשותף.');
 setStartupMessage('בודק התחברות וטוען נתונים…');
 if(navigator.onLine){
  const valid=await RemotePos.restoreSession();
  if(valid){
   try{await cloudAfterAuthentication();}
   catch(error){showCloudDataError(error);}
  }
 }else{
  el('loginMessage').textContent='אין אינטרנט — דרוש חיבור כדי להיכנס ולחייב בענן.';
 }
 el('installedVersion').textContent='V'+APP_VERSION;
 setInterval(()=>enforceShiftExpiry().catch(console.error),30000);
 document.addEventListener('visibilitychange',()=>{
  if(!document.hidden)enforceShiftExpiry().catch(console.error);
 });
 finishStartup();
}

init().catch(failStartup);
