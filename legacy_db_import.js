'use strict';
/* PUB Manara read-only SQLite inspection and explicitly confirmed cloud import.
   No data is uploaded until server preview; no mutation until owner clicks Import. */
const LegacyDbImport=(()=>{
 const $=id=>document.getElementById(id);
 let prepared=null,serverPreview=null,working=false;
 const sqljs='https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.min.js';
 const wasm='https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.wasm';
 const str=x=>String(x??'').trim();
 const credit=x=>/^C-?\d+$/i.test(str(x));
 const norm=x=>str(x).toLocaleLowerCase('he-IL');
 const money=n=>Number(n).toLocaleString('he-IL',{minimumFractionDigits:2,maximumFractionDigits:2})+' ₪';
 function message(value,error=false){$('sqliteImportMessage').textContent=value;$('sqliteImportMessage').classList.toggle('error',error);}
 async function loadSql(){
  if(typeof initSqlJs!=='function'){
   await new Promise((resolve,reject)=>{
    const t=document.createElement('script');t.src=sqljs;t.crossOrigin='anonymous';
    t.onload=resolve;t.onerror=()=>reject(new Error('ספריית SQLite לא נטענה. נדרש חיבור לאינטרנט.'));
    document.head.appendChild(t);
   });
  }
  return initSqlJs({locateFile:()=>wasm});
 }
 function query(db,sql){const res=db.exec(sql);if(!res.length)return[];return res[0].values.map(row=>Object.fromEntries(res[0].columns.map((key,i)=>[key,row[i]])));}
 async function parse(file){
  if(!/\.db$/i.test(file.name)||file.size>30*1024*1024)throw new Error('יש לבחור קובץ DB עד 30MB');
  const buffer=await file.arrayBuffer();
  if(new TextDecoder('ascii').decode(buffer.slice(0,15))!=='SQLite format 3')throw new Error('הקובץ אינו SQLite תקין');
  const SQL=await loadSql();let db;
  try{
   db=new SQL.Database(new Uint8Array(buffer));
   const integrity=query(db,'PRAGMA integrity_check');
   if(integrity[0]?.integrity_check!=='ok')throw new Error('בדיקת תקינות הקובץ נכשלה');
   const required=['customers','products','archive','product_price_history'];
   const found=new Set(query(db,"select name from sqlite_master where type='table'").map(x=>x.name));
   for(const tab of required)if(!found.has(tab))throw new Error('חסרה טבלה '+tab);
   const rawCustomers=query(db,'select id,name,customer_no from customers order by id');
   const rawProducts=query(db,'select id,name,price,category,product_type,active from products order by id');
   const rawArchive=query(db,'select id,customer_name,customer_no,sale_date_iso,sale_time,drink,qty,price from archive order by id');
   const rawHistory=query(db,'select id,product_name,old_price,new_price,changed_at,note from product_price_history order by id');
   const creditNames=new Set(rawCustomers.filter(c=>credit(c.customer_no)).map(c=>norm(c.name)));
   let ambiguous=0,byNumber=0,ambiguousSum=0,creditSum=0;
   const archive=[];
   for(const r of rawArchive){
    if(credit(r.customer_no)){byNumber++;creditSum+=Number(r.price);continue;}
    if(creditNames.has(norm(r.customer_name))){ambiguous++;ambiguousSum+=Number(r.price);continue;}
    const iso=str(r.sale_date_iso);
    const date=/^\d{4}-\d{2}-\d{2}$/.test(iso)?iso:str(r.sale_date_iso);
    archive.push({sourceId:r.id,customer:str(r.customer_name),number:str(r.customer_no),dateIso:date,time:str(r.sale_time),drink:str(r.drink),qty:Number(r.qty),price:Number(r.price)});
   }
   const customers=rawCustomers.filter(c=>!credit(c.customer_no)&&!creditNames.has(norm(c.name))).map(c=>({name:str(c.name),number:str(c.customer_no)}));
   const seen=new Set(customers.map(c=>norm(c.name)+'|'+c.number));
   let added=0;
   for(const row of archive){
    const key=norm(row.customer)+'|'+row.number;
    if(!seen.has(key)){seen.add(key);customers.push({name:row.customer,number:row.number});added++;}
   }
   const products=rawProducts.map(x=>({name:str(x.name),price:Number(x.price),category:str(x.category)||str(x.name),type:str(x.product_type)||str(x.name),active:Number(x.active)!==0}));
   const history=rawHistory.map(x=>({productName:str(x.product_name),oldPrice:x.old_price===null?null:Number(x.old_price),newPrice:Number(x.new_price),changedAt:str(x.changed_at),note:str(x.note)}));
   const missingProducts=[...new Set(archive.filter(a=>!products.some(p=>norm(p.name)===norm(a.drink))).map(a=>a.drink))];
   const sum=archive.reduce((a,x)=>a+x.price,0);
   const payload={format:'pub-manara-sqlite-v0943',customers,products,archive,history};
   return {payload,details:{originalCustomers:rawCustomers.length,originalArchive:rawArchive.length,
    originalProducts:rawProducts.length,originalHistory:rawHistory.length,
    creditCustomers:rawCustomers.filter(c=>credit(c.customer_no)).length,
    creditRows:byNumber,creditSum,ambiguousRows:ambiguous,ambiguousSum,syntheticCustomers:added,
    totalRows:archive.length,totalSum:sum,missingProducts}};
  }finally{db?.close();}
 }
 function reset(){prepared=null;serverPreview=null;$('sqliteImportExecute').disabled=true;$('sqliteImportPreview').disabled=true;$('sqliteImportFile').value='';$('sqliteImportDetails').replaceChildren();message('בחר קובץ DB לבדיקת הנתונים.');}
 async function select(){
  const file=$('sqliteImportFile').files[0];if(!file)return;
  prepared=null;serverPreview=null;$('sqliteImportExecute').disabled=true;$('sqliteImportPreview').disabled=true;
  message('בודק את מבנה SQLite ומסנן חשבונות כרדיט…');
  try{
   const data=await parse(file);prepared=data;
   const d=data.details,host=$('sqliteImportDetails');host.replaceChildren();
   const items=[
    ['לקוחות שאינם כרדיט',data.payload.customers.length+' (כולל '+d.syntheticCustomers+' שחסרו בטבלת הלקוחות)'],
    ['לקוחות כרדיט שהוחרגו',d.creditCustomers],
    ['שורות חיוב וזיכוי לייבוא',d.totalRows],
    ['סך חיובים וזיכויים',money(d.totalSum)],
    ['תנועות כרדיט שהוחרגו',d.creditRows],
    ['שורות עם שם של לקוח כרדיט אך מספר רגיל/חסר — הוחרגו ליתר ביטחון',d.ambiguousRows+' ('+money(d.ambiguousSum)+')'],
    ['מוצרים',d.originalProducts],['היסטוריית מחירים',d.originalHistory],
    ['שמות משקאות היסטוריים שלא קיימים בקטלוג',d.missingProducts.join(' · ')||'אין']
   ];
   for(const [label,value] of items){const p=document.createElement('p');p.textContent=label+': '+value;host.append(p);}
   $('sqliteImportPreview').disabled=false;
   message('הבדיקה המקומית הושלמה. ניתן לבדוק התאמה לנתוני הענן ללא ייבוא.');
  }catch(err){message('הבדיקה נכשלה: '+err.message,true);}
 }
 async function preview(){
  if(working||!prepared)return;working=true;$('sqliteImportPreview').disabled=true;
  try{
   if(!RemotePos.active||!RemotePos.authenticated||RemotePos.employee?.is_owner!==true)throw new Error('נדרשת כניסה של בעל החשבון');
   if(RemotePos.isImported)throw new Error('הארכיון המקורי כבר יובא; הפעולה חסומה');
   message('בודק כפילויות ומוצרים מול Supabase, ללא כתיבה…');
   const result=await RemotePos.request('/rest/v1/rpc/pos_legacy_db_import_v0943',{method:'POST',
    body:{p_payload:prepared.payload,p_execute:false,p_preview_token:null}});
   if(Number(result.archive_rows)!==prepared.details.totalRows||Math.abs(Number(result.archive_sum)-prepared.details.totalSum)>.01)
    throw new Error('אי התאמה בין הספירה המקומית לבין שרת הענן');
   serverPreview=result;
   const host=$('sqliteImportDetails');
   for(const line of [
    'בדיקת ענן: '+result.new_customers+' לקוחות חדשים, '+result.existing_customers+' לקוחות בשם זהה',
    'מוצרים: '+result.new_products+' חדשים, '+result.existing_products+' קיימים; '+result.price_conflicts+' הפרשי מחיר',
    'היסטוריה: '+result.price_history+' רשומות. מוצרים היסטוריים חסרים: '+result.historic_products_missing+' שורות',
    'המחיר הפעיל של מוצר קיים יישמר ללא שינוי; היסטוריית המקור תתווסף.',
    'לא בוצע ייבוא. הפעולה תתבצע רק אחרי גיבוי ואישור נפרד.'
   ]){const p=document.createElement('p');p.textContent=line;host.append(p);}
   $('sqliteImportExecute').disabled=false;message('תצוגה מקדימה מהשרת מוכנה. לא נשמרה אף רשומה.');
  }catch(err){serverPreview=null;$('sqliteImportExecute').disabled=true;message(err.message,true);}
  finally{working=false;$('sqliteImportPreview').disabled=false;}
 }
 function download(name,data){const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),120000);}
 async function backupCloud(){
  const tables=['customers','products','transactions','transaction_items','pos_settings'];
  const snapshot={createdAt:new Date().toISOString(),kind:'before-manara-sqlite-import',tables:{}};
  for(const table of tables){snapshot.tables[table]=await RemotePos.rows(table,'*');}
  download('Manara_Cloud_BACKUP_Before_SQLite_'+new Date().toISOString().slice(0,10)+'.json',snapshot);
 }
 async function execute(){
  if(working||!prepared||!serverPreview)return;
  if(!confirm('האם לבצע כעת ייבוא חד־פעמי של '+serverPreview.archive_rows+' שורות בסך '+money(serverPreview.archive_sum)+'? לקוחות כרדיט ותנועותיהם לא ייכללו.'))return;
  if(!confirm('זהו אישור שני: הנתונים יישמרו בענן ולא ניתן להפעיל את הייבוא פעם נוספת. להמשיך?'))return;
  working=true;$('sqliteImportExecute').disabled=true;
  try{
   message('מוריד גיבוי מלא של נתוני הענן לפני כתיבה…');
   await backupCloud();
   if(!confirm('קובץ הגיבוי הופק. ודא שהורדת אותו למכשיר. לבצע כעת את הייבוא?')){message('הייבוא בוטל. לא שונו נתונים.');return;}
   message('מבצע ייבוא מאושר…');
   const result=await RemotePos.request('/rest/v1/rpc/pos_legacy_db_import_v0943',{method:'POST',
    body:{p_payload:prepared.payload,p_execute:true,p_preview_token:serverPreview.preview_token}});
   if(!result.executed||result.archive_rows!==serverPreview.archive_rows||
    Math.abs(Number(result.archive_sum)-Number(serverPreview.archive_sum))>.01)
    throw new Error('שרת הענן החזיר תוצאה לא צפויה — בדוק את הדוחות לפני פעולה נוספת');
   message('הייבוא הושלם ואומת: '+result.archive_rows+' שורות, '+money(result.archive_sum)+'.');
   prepared=null;serverPreview=null;await RemotePos.loadAll();await refresh();renderPermissions();
   $('sqliteImportFile').value='';$('sqliteImportExecute').disabled=true;
  }catch(err){message('הייבוא לא אושר כהושלם: '+err.message+' — בדוק את הארכיון לפני ניסיון נוסף.',true);}
  finally{working=false;}
 }
 function init(){
  $('sqliteImportFile').addEventListener('change',select);
  $('sqliteImportPreview').addEventListener('click',preview);
  $('sqliteImportExecute').addEventListener('click',execute);
  $('sqliteImportReset').addEventListener('click',reset);
 }
 return {init};
})();
