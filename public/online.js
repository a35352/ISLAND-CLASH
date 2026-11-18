(()=>{'use strict';
// Admin-only WebSocket: no online match, player motion, or bot state transfer.
const style=document.createElement('style');style.textContent=`
#serverStatus{position:fixed;right:10px;top:10px;z-index:23;padding:7px 10px;background:#193a32e8;color:#fff;border-radius:10px;font:bold 11px Arial}
#globalCodeGroup{display:flex;gap:6px;margin:8px 0;align-items:center}
#globalCodeGroup input{min-width:0;flex:1;padding:9px;border:2px solid #71a895;border-radius:9px}
#globalCodeGroup button,#serverAdminOpen{background:#186d54;color:white;border-radius:9px;padding:9px;font-weight:900}
#serverAdminOpen{position:fixed;right:12px;bottom:17px;z-index:22;display:none}
#serverAdminPanel{position:fixed;z-index:50;inset:0;display:none;place-items:center;background:#0b241ac9}
#serverAdminPanel article{width:min(430px,95vw);max-height:92vh;overflow:auto;background:#f1f8de;color:#183e2d;border:3px solid #398961;padding:17px;border-radius:17px;box-shadow:0 12px 38px #0009;font:14px Arial}
#serverAdminPanel input,#serverAdminPanel textarea,#serverAdminPanel select{box-sizing:border-box;width:100%;padding:9px;margin:5px 0 9px;border:1px solid #81a28f;border-radius:8px;font:inherit}
#serverAdminPanel button{padding:9px 12px;background:#206e58;color:#fff;border:0;border-radius:9px;font-weight:800;margin:4px}
#serverAdminPanel h3{margin:11px 0 4px}#serverAdminPanel small{display:block;color:#486353;line-height:1.5}
`;document.head.append(style);
const status=document.createElement('div');status.id='serverStatus';status.textContent='🌐 Admin sync connecting...';document.body.append(status);
const adminOpen=document.createElement('button');adminOpen.id='serverAdminOpen';adminOpen.textContent='🌐 SERVER ADMIN';document.body.append(adminOpen);
const panel=document.createElement('div');panel.id='serverAdminPanel';panel.innerHTML=`<article><h2>🛡 SERVER ADMIN (NO MULTIPLAYER)</h2><small>For shared announcements and redeem codes. Solo matches stay on each player's device.</small><button id="saClose">CLOSE</button><label>Owner setup secret (Render Environment)</label><input id="saSecret" type="password" autocomplete="off" placeholder="OWNER_SETUP_SECRET"><button id="saUnlock">UNLOCK SERVER ADMIN</button><p id="saMessage">Sign in once per connection to use shared admin tools.</p><section id="saTools" hidden><h3>📣 Announcement to everyone online</h3><textarea id="saNotice" maxlength="400" rows="3" placeholder="Your announcement"></textarea><button id="saPost">POST ANNOUNCEMENT</button><h3>🎟 Shared redeem code</h3><input id="saCode" maxlength="24" placeholder="CODE NAME"><select id="saKind"><option value="gold">Gold</option><option value="tokens">Basic Tokens</option></select><input id="saAmount" type="number" value="2500" min="1" max="1000000" placeholder="Amount"><input id="saUses" type="number" value="10" min="1" max="10000" placeholder="Total uses"><input id="saHours" type="number" value="24" min="0.25" max="8760" step="0.25" placeholder="Valid hours"><button id="saCreate">CREATE CODE</button><h3>Revoke code</h3><input id="saRevokeName" maxlength="24" placeholder="CODE NAME"><button id="saRevoke">REVOKE</button></section></article>`;document.body.append(panel);
const $=id=>document.getElementById(id);
const codeRow=document.createElement('div');codeRow.id='globalCodeGroup';codeRow.innerHTML='<input id="globalCode" maxlength="24" placeholder="🌐 Shared server redeem code"><button id="globalRedeem">REDEEM GLOBAL</button>';
const target=$('codeInput');target?.parentElement?.insertAdjacentElement('afterend',codeRow);
const uidKey='island-clash-v31-redeemer';let uid=localStorage.getItem(uidKey);
if(!uid){uid=crypto.randomUUID();localStorage.setItem(uidKey,uid)}
let ws=null,isOwner=false,connected=false,tries=0;
function send(obj){if(ws?.readyState===WebSocket.OPEN){ws.send(JSON.stringify(obj));return true}status.textContent='🌐 Offline — reconnecting';return false}
function connect(){if(ws&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(ws.readyState))return;const scheme=location.protocol==='https:'?'wss:':'ws:';ws=new WebSocket(scheme+'//'+location.host+'/ws');ws.onopen=()=>{connected=true;status.textContent='🌐 Admin sync online';tries=0};ws.onmessage=e=>{
  let m;try{m=JSON.parse(e.data)}catch{return}
  if(m.type==='hello'){status.textContent='🌐 Solo + admin sync';return}
  if(m.type==='owner_status'){isOwner=!!m.owner;$('saTools').hidden=!isOwner;$('saMessage').textContent=m.message;$('saSecret').value='';return}
  if(m.type==='error'||m.type==='created'){$('saMessage').textContent=m.message;return}
  if(m.type==='new_notice'){
    window.dispatchEvent(new CustomEvent('island-admin-notice',{detail:m.notice}));return
  }
  if(m.type==='reward'){
    window.dispatchEvent(new CustomEvent('island-admin-reward',{detail:m}));$('globalCode').value='';return
  }
};ws.onclose=()=>{connected=false;isOwner=false;$('saTools').hidden=true;status.textContent='🌐 Admin sync disconnected';if(++tries<8)setTimeout(connect,Math.min(15000,1500*tries))};ws.onerror=()=>{status.textContent='🌐 Admin connection error'};}
connect();
function updateButton(){adminOpen.style.display=($('nameInput')?.value.trim().toLowerCase()==='britbox')?'block':'none'}
setInterval(updateButton,1000);
adminOpen.onclick=()=>{panel.style.display='grid'};
$('saClose').onclick=()=>{panel.style.display='none'};
$('saUnlock').onclick=()=>{const secret=$('saSecret').value;if(secret.length<16){$('saMessage').textContent='Enter the 16+ character OWNER_SETUP_SECRET saved in Render.';return}send({type:'owner_login',secret});$('saSecret').value=''};
$('saPost').onclick=()=>{if(send({type:'post_notice',message:$('saNotice').value}))$('saNotice').value=''};
$('saCreate').onclick=()=>send({type:'create_code',code:$('saCode').value,kind:$('saKind').value,amount:Number($('saAmount').value),uses:Number($('saUses').value),hours:Number($('saHours').value)});
$('saRevoke').onclick=()=>send({type:'revoke_code',code:$('saRevokeName').value});
$('globalRedeem').onclick=()=>{if(!$('nameInput')?.value.trim()){alert('Log into your original Island Clash account first.');return}send({type:'redeem',code:$('globalCode').value,playerId:uid})};
})();
