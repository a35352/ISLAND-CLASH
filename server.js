
'use strict';
const express=require('express'),http=require('http'),{WebSocketServer,WebSocket}=require('ws'),crypto=require('crypto');
const app=express();app.use(express.static('public'));app.get('/health',(req,res)=>res.json({ok:true,players:humans.size,bots:bots.length}));
const server=http.createServer(app),wss=new WebSocketServer({server,path:'/ws'});
const MAX=100,MAP=1850,TICK=50,humans=new Map(),bots=[];let coins=[],storm={x:0,y:0,r:1700},round=1,elapsed=0,worldTime=Date.now(),events=[];
const rand=(a,b)=>a+Math.random()*(b-a),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const names=['Coral','Captain','Dagger','Reef','Skull','Kraken','Sailor','Storm','Anchor','Pearl','Shark','Rogue','Cannon','Drift','Tide'];
function fighter(id,name,bot=false){let a=rand(0,Math.PI*2),r=rand(150,1300);return{id,name,bot,x:Math.cos(a)*r,y:Math.sin(a)*r,angle:rand(-3.14,3.14),hp:100,maxhp:100,size:19,kills:0,gold:0,alive:true,attack:0,dash:0,vx:0,vy:0,skin:'classic',pet:'none',moveX:0,moveY:0,charging:false,chargeStart:0,respawnAt:0};}
function fill(){while(humans.size+bots.length<MAX){let i=crypto.randomUUID();bots.push(fighter(i,names[Math.floor(rand(0,names.length))]+'_'+Math.floor(rand(100,999)),true));}while(humans.size+bots.length>MAX)bots.pop();}
function makeCoins(){coins=Array.from({length:350},(_,i)=>({id:i,x:rand(-MAP+60,MAP-60),y:rand(-MAP+60,MAP-60),value:Math.floor(rand(1,6))}));}
function broadcast(obj){let s=JSON.stringify(obj);for(let c of wss.clients)if(c.readyState===WebSocket.OPEN)c.send(s);}
function reset(){round++;elapsed=0;storm={x:0,y:0,r:1700};for(let p of [...humans.values(),...bots]){Object.assign(p,fighter(p.id,p.name,p.bot),{skin:p.skin,pet:p.pet});}makeCoins();broadcast({type:'round',round});}
function attack(p,charged){if(!p.alive||p.attack>0)return;p.attack=charged?0.75:0.38;let reach=charged?125:85,damage=charged?46:25;
 for(let t of [...humans.values(),...bots]){if(t.id===p.id||!t.alive)continue;let dx=t.x-p.x,dy=t.y-p.y,d=Math.hypot(dx,dy),ang=Math.atan2(dy,dx);if(d<reach+t.size&&Math.cos(ang-p.angle)>.25){t.hp-=damage;t.x=clamp(t.x+dx/(d||1)*24,-MAP,MAP);t.y=clamp(t.y+dy/(d||1)*24,-MAP,MAP);if(t.hp<=0){t.alive=false;t.respawnAt=elapsed+5;p.kills++;p.gold+=t.gold+15;p.size=Math.min(44,p.size+1.1);broadcast({type:'kill',by:p.name,victim:t.name});}}}
 if(charged)p.dash=.23;
}
function update(dt){elapsed+=dt;storm.r=Math.max(125,1700-elapsed*6.3);let all=[...humans.values(),...bots];
 for(let p of all){if(!p.alive){if(elapsed>p.respawnAt){let n=fighter(p.id,p.name,p.bot);Object.assign(p,n,{skin:p.skin,pet:p.pet});}continue;}
 p.attack=Math.max(0,p.attack-dt);p.dash=Math.max(0,p.dash-dt);
 if(p.bot){let nearest=null,dist=1e10;for(let t of all){if(t===p||!t.alive)continue;let d=Math.hypot(t.x-p.x,t.y-p.y);if(d<dist){dist=d;nearest=t;}}
 if(nearest&&dist<550){let a=Math.atan2(nearest.y-p.y,nearest.x-p.x);p.angle=a;p.moveX=Math.cos(a);p.moveY=Math.sin(a);if(dist<75&&p.attack<=0&&Math.random()<.09)attack(p,false);}
 else{if(!p.wander||Math.random()<.012)p.wander=rand(-Math.PI,Math.PI);p.angle=p.wander;p.moveX=Math.cos(p.angle)*.55;p.moveY=Math.sin(p.angle)*.55;}}
 let speed=p.dash>0?650:p.bot?170:220,mag=Math.hypot(p.moveX,p.moveY);p.x=clamp(p.x+(mag>0?p.moveX/mag:0)*speed*dt,-MAP,MAP);p.y=clamp(p.y+(mag>0?p.moveY/mag:0)*speed*dt,-MAP,MAP);
 if(Math.hypot(p.x-storm.x,p.y-storm.y)>storm.r){p.hp-=dt*9;if(p.hp<=0){p.alive=false;p.respawnAt=elapsed+5;}}
 for(let i=coins.length-1;i>=0;i--){let c=coins[i];if(Math.hypot(c.x-p.x,c.y-p.y)<p.size+12){p.gold+=c.value;p.size=Math.min(44,p.size+.07);coins.splice(i,1);}}
 }
 if(coins.length<200)for(let i=0;i<70;i++)coins.push({id:crypto.randomUUID(),x:rand(-MAP,MAP),y:rand(-MAP,MAP),value:Math.floor(rand(1,6))});
 if(elapsed>240)reset();
}
fill();makeCoins();
wss.on('connection',(ws)=>{if(humans.size>=MAX){ws.close(1013,'Match full');return;}let id=crypto.randomUUID(),p=fighter(id,'Pirate_'+id.slice(0,4));humans.set(id,p);fill();ws.send(JSON.stringify({type:'welcome',id,round}));
 ws.on('message',raw=>{if(raw.length>2048)return;let m;try{m=JSON.parse(raw)}catch{return};if(!m||typeof m!=='object')return;
 if(m.type==='join'){p.name=String(m.name||p.name).replace(/[^\w -]/g,'').slice(0,16)||p.name;p.skin=String(m.skin||'classic').slice(0,24);p.pet=String(m.pet||'none').slice(0,24);}
 if(m.type==='input'){let x=Number(m.x)||0,y=Number(m.y)||0,mag=Math.hypot(x,y);p.moveX=mag>1?x/mag:x;p.moveY=mag>1?y/mag:y;if(mag>.05)p.angle=Math.atan2(y,x);if(m.attack===true&&p.attack<=0)attack(p,false);if(m.charge===true&&!p.charging){p.charging=true;p.chargeStart=Date.now();}if(m.charge===false&&p.charging){let charged=Date.now()-p.chargeStart>=300;p.charging=false;attack(p,charged);}}
 });ws.on('close',()=>{humans.delete(id);fill()});ws.on('error',()=>{});
});
setInterval(()=>{let now=Date.now(),dt=Math.min(.1,(now-worldTime)/1000);worldTime=now;update(dt);broadcast({type:'state',round,elapsed:Math.round(elapsed),storm,humans:humans.size,bots:bots.length,players:[...humans.values(),...bots].map(p=>({id:p.id,name:p.name,bot:p.bot,x:Math.round(p.x),y:Math.round(p.y),angle:p.angle,hp:Math.round(p.hp),size:p.size,alive:p.alive,kills:p.kills,gold:p.gold,skin:p.skin,pet:p.pet,attack:p.attack,dash:p.dash})),coins});},TICK);
server.listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('Island Clash multiplayer listening on '+(process.env.PORT||3000)));
