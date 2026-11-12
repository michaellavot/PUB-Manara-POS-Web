(function(root){
'use strict';
const M=60000;
function fresh(){return {codes:[],orders:[],charges:[],background:[],bgIndex:0,mixPosition:0,current:null,paused:false,lockUntil:0,wrong:0,log:[],price:5};}
function status(c,t){return c.state==='active'&&t>= (c.enteredAt?c.enteredAt+5*M:c.issuedAt+10*M)?'expired':c.state;}
function issue(s,code,client,price,t,id){if(s.codes.some(c=>c.code===code&&t-c.issuedAt<24*60*M))throw Error('code collision');const c={id,code,client,worker:'DEV Admin',price,issuedAt:t,enteredAt:0,state:'active',search:''};s.codes.push(c);return c;}
function enter(s,code,t){if(t<s.lockUntil)return null;const c=s.codes.find(c=>c.code===code&&status(c,t)==='active');if(!c){if(++s.wrong>=5){s.lockUntil=t+M;s.wrong=0;}return null;}s.wrong=0;if(!c.enteredAt)c.enteredAt=t;return c;}
function add(s,c,song,t,id){if(!c||status(c,t)!=='active'||!c.enteredAt||song.seconds>1800||!song.seconds||s.orders.some(o=>o.codeId===c.id))return null;c.state='used';const o={...song,id,codeId:c.id,client:c.client,price:c.price,issuedAt:c.issuedAt,createdAt:t,state:'queued',failures:0,attempts:[]};s.orders.push(o);return o;}
function fail(s,o,reason,t){if(o.state!=='playing')return false;o.failures++;o.attempts.push({t,reason});o.state=o.failures>=4?'failed':'queued';o.createdAt=t;return true;}
function complete(s,o,verified,t){if(!verified||o.state!=='playing'||s.charges.some(c=>c.orderId===o.id))return false;o.state='completed';o.completedAt=t;s.charges.push({orderId:o.id,amount:o.price,date:o.issuedAt,recordedAt:t,refunded:false});return true;}
function defer(s,o,verified,t){if(!verified||o.state!=='playing'||s.charges.some(c=>c.orderId===o.id))return false;o.state='pending';o.verifiedAt=t;return true;}
function approve(s,o,t){if(o.state!=='pending'||!o.verifiedAt||s.charges.some(c=>c.orderId===o.id))return false;o.state='playing';return complete(s,o,true,t);}
function approveAll(s,t){return s.orders.filter(o=>approve(s,o,t)).length;}
function refund(s,id,t){const c=s.charges.find(c=>c.orderId===id);if(!c||c.refunded)return false;c.refunded=true;c.refundedAt=t;return true;}
function tracker(){return {last:0,wall:0,covered:0,bad:false,seen:false};}
function sample(v,pos,wall,playing,rate){if(!Number.isFinite(pos)||!Number.isFinite(wall))return;if(!v.seen){v.seen=true;v.last=pos;v.wall=wall;if(pos>2)v.bad=true;return;}const dt=(wall-v.wall)/1000,dp=pos-v.last;if(dp<-.5||dp>Math.max(0,dt)+1.5||rate!==1)v.bad=true;if(playing&&dt<=3&&dp>=0&&dp<=dt+1.5)v.covered+=Math.min(dp,dt);else if(dp>1.5)v.bad=true;v.last=pos;v.wall=wall;}
function verified(v,duration){return v.seen&&!v.bad&&duration>0&&v.last>=duration-2&&v.covered>=duration-3;}
const api={fresh,status,issue,enter,add,fail,complete,refund,defer,approve,approveAll,tracker,sample,verified};if(typeof module!=='undefined')module.exports=api;else root.Engine=api;
})(typeof globalThis!=='undefined'?globalThis:this);
