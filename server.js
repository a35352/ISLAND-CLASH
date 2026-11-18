'use strict';
// Island Clash v31: SOLO MATCHES + ONLINE ADMIN ONLY.
// Only announcements and global redeem codes are synced. No multiplayer arena.
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({server, path:'/ws'});
const DATA_PATH = process.env.ADMIN_DATA_FILE || path.join(__dirname, 'admin-data.json');
let data = {notices:[],codes:{}};
try {
  const saved = JSON.parse(fs.readFileSync(DATA_PATH,'utf8'));
  if (saved && Array.isArray(saved.notices) && saved.codes && typeof saved.codes==='object') data=saved;
} catch {}
function save(){ try {fs.writeFileSync(DATA_PATH,JSON.stringify(data,null,2))}catch(e){console.error('Save failed:',e.message)} }
function send(ws,obj){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj))}
function publish(obj){for(const ws of wss.clients)send(ws,obj)}
function matchesSecret(candidate){
  const correct = String(process.env.OWNER_SETUP_SECRET || '');
  if(correct.length<16 || typeof candidate!=='string')return false;
  const a=crypto.createHash('sha256').update(candidate).digest();
  const b=crypto.createHash('sha256').update(correct).digest();
  return crypto.timingSafeEqual(a,b);
}
function publicNotices(){return data.notices.slice(0,15)}
function safelyParse(raw){try{return JSON.parse(raw.toString())}catch{return null}}
const attempts = new WeakMap();
wss.on('connection',ws=>{
  ws.owner=false;
  attempts.set(ws,{count:0,started:Date.now()});
  send(ws,{type:'hello',notices:publicNotices(),status:'Solo mode • online admin connected'});
  ws.on('message',raw=>{
    if(raw.length>4096)return;
    const m=safelyParse(raw);if(!m||typeof m!=='object')return;
    if(m.type==='owner_login'){
      const lim=attempts.get(ws);if(Date.now()-lim.started>60000){lim.started=Date.now();lim.count=0}
      lim.count++;if(lim.count>5)return send(ws,{type:'error',message:'Too many attempts. Try again later.'});
      ws.owner=matchesSecret(m.secret);
      return send(ws,{type:'owner_status',owner:ws.owner,message:ws.owner?'Server admin unlocked.':'Incorrect admin secret or missing OWNER_SETUP_SECRET in Render.'});
    }
    if(m.type==='post_notice'){
      if(!ws.owner)return send(ws,{type:'error',message:'Admin login required.'});
      const message=String(m.message||'').trim().slice(0,400);
      if(message.length<3)return send(ws,{type:'error',message:'Announcement is too short.'});
      const notice={id:crypto.randomUUID(),text:message,at:Date.now(),by:'BRITBOX'};
      data.notices.unshift(notice);data.notices=data.notices.slice(0,30);save();publish({type:'new_notice',notice});
      return;
    }
    if(m.type==='create_code'){
      if(!ws.owner)return send(ws,{type:'error',message:'Admin login required.'});
      const code=String(m.code||'').trim().toUpperCase();
      const kind=m.kind==='tokens'?'tokens':'gold';
      const amount=Number(m.amount),uses=Number(m.uses),hours=Number(m.hours);
      if(!/^[A-Z0-9_-]{4,24}$/.test(code)||!Number.isInteger(amount)||amount<1||amount>1000000||!Number.isInteger(uses)||uses<1||uses>10000||!Number.isFinite(hours)||hours<.25||hours>8760)
        return send(ws,{type:'error',message:'Invalid code, amount, uses, or expiry.'});
      if(data.codes[code])return send(ws,{type:'error',message:'Code already exists.'});
      data.codes[code]={kind,amount,uses,expires:Date.now()+hours*3600000,usedBy:[]};save();
      return send(ws,{type:'created',message:'Created shared code '+code});
    }
    if(m.type==='revoke_code'){
      if(!ws.owner)return send(ws,{type:'error',message:'Admin login required.'});
      const code=String(m.code||'').trim().toUpperCase();
      delete data.codes[code];save();return send(ws,{type:'created',message:'Revoked '+code});
    }
    if(m.type==='redeem'){
      const code=String(m.code||'').trim().toUpperCase();
      const playerId=String(m.playerId||'');
      if(!/^[a-f0-9-]{36}$/.test(playerId))return send(ws,{type:'error',message:'Invalid player ID.'});
      const reward=data.codes[code];
      if(!reward||reward.expires<Date.now()||reward.usedBy.length>=reward.uses||reward.usedBy.includes(playerId))return send(ws,{type:'error',message:'Code invalid, expired, full, or already redeemed.'});
      reward.usedBy.push(playerId);save();return send(ws,{type:'reward',code,kind:reward.kind,amount:reward.amount});
    }
  });
  ws.on('error',()=>{});
});
app.get('/health',(_req,res)=>res.json({ok:true,mode:'solo-with-online-admin',connections:wss.clients.size}));
server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('Island Clash v31 solo with online admin started'));
