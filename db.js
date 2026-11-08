'use strict';
// This IndexedDB name is intentionally NOT shared with the earlier V3 experiment.
const DB_NAME='manara-pos-web-independent-v01';
const DB_VERSION=1;
const STORE_NAMES=['customers','products','archive','priceHistory','settings'];
let database;
function requestPromise(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function openDatabase(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>{
  const db=req.result;
  const customers=db.createObjectStore('customers',{keyPath:'id'});customers.createIndex('normalized','normalized',{unique:true});
  const products=db.createObjectStore('products',{keyPath:'id'});products.createIndex('normalized','normalized',{unique:true});
  const archive=db.createObjectStore('archive',{keyPath:'id'});archive.createIndex('date','dateIso');archive.createIndex('customer','customer');archive.createIndex('operation','operationId');
  db.createObjectStore('priceHistory',{keyPath:'id'});
  db.createObjectStore('settings',{keyPath:'key'});
};req.onsuccess=()=>{database=req.result;database.onversionchange=()=>database.close();resolve(database);};req.onerror=()=>reject(req.error);});}
function allRows(store){return requestPromise(database.transaction(store,'readonly').objectStore(store).getAll());}
function putRow(store,row){return requestPromise(database.transaction(store,'readwrite').objectStore(store).put(row));}
function removeRow(store,id){return requestPromise(database.transaction(store,'readwrite').objectStore(store).delete(id));}
function bulkTransaction(stores,callback){return new Promise((resolve,reject)=>{const tx=database.transaction(stores,'readwrite');let result;try{result=callback(Object.fromEntries(stores.map(s=>[s,tx.objectStore(s)])));}catch(e){tx.abort();reject(e);return;}tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error||new Error('הפעולה בוטלה'));tx.onerror=()=>reject(tx.error||new Error('שגיאת שמירה'));});}
async function dbSnapshot(){const out={format:'manara-web-backup-v1',app:'PUB Manara POS Web',version:'0.1',exportedAt:new Date().toISOString(),stores:{}};for(const s of STORE_NAMES)out.stores[s]=await allRows(s);return out;}
function validateBackup(data){if(!data||data.format!=='manara-web-backup-v1'||!data.stores)throw new Error('זה אינו גיבוי Web בפורמט הנתמך');for(const s of STORE_NAMES){if(!Array.isArray(data.stores[s]))throw new Error('גיבוי חסר נתונים: '+s);}return true;}
async function dbReplaceFromBackup(data){validateBackup(data);await bulkTransaction(STORE_NAMES,stores=>{for(const name of STORE_NAMES){stores[name].clear();for(const row of data.stores[name])stores[name].put(row);}});}
function saveSaleAtomic(rows){return bulkTransaction(['archive'],stores=>{for(const row of rows)stores.archive.add(row);});}
