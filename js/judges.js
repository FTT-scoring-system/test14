/* FTT Poomsae — Remote Judge QR / Phone Interface */
let judgePeer = null;
let judgeConnections = {};
let judgeRuntime = { currentSession: "", connected: 0 };
let ctxMatForHeader = Number(new URLSearchParams(location.search).get("mat")) || 1;

function judgeRandomToken(){
  if(window.crypto?.getRandomValues){const a=new Uint32Array(3);crypto.getRandomValues(a);return [...a].map(x=>x.toString(36)).join("");}
  return Math.random().toString(36).slice(2)+Date.now().toString(36);
}
function judgeNewSessionId(){return "S"+Date.now().toString(36)+judgeRandomToken().slice(0,6);}
function judgeIsPhone(){return new URLSearchParams(location.search).get("judge")==="1";}
function judgeParams(){const q=new URLSearchParams(location.search);return {peer:q.get("peer")||"",judge:Number(q.get("j")||0),token:q.get("t")||"",mat:Number(q.get("mat")||0)||1};}
function judgeBaseUrl(){return location.origin+location.pathname;}

function ensureJudgePeer(onReady){
  if(typeof Peer!=="function"){ if(onReady) onReady(null); return; }
  if(judgePeer && !judgePeer.destroyed){
    if(judgePeer.open){
      STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}};
      STATE.collectorQr=STATE.collectorQr||{peerId:"",token:"",deleted:false};
      STATE.judgeQr.peerId=judgePeer.id||STATE.judgeQr.peerId;
      STATE.collectorQr.peerId=judgePeer.id||STATE.collectorQr.peerId;
      saveState();
      if(onReady) onReady(judgePeer.id);
    } else if(onReady){
      judgePeer.once("open",id=>onReady(id));
    }
    return;
  }
  const desired="ftt-poomsae-"+judgeRandomToken()+"-"+Date.now().toString(36);
  judgePeer=new Peer(desired,{debug:0,config:{iceServers:[
    {urls:"stun:stun.l.google.com:19302"},
    {urls:"stun:stun1.l.google.com:19302"},
    {urls:"stun:global.stun.twilio.com:3478"}
  ]}});
  judgePeer.on("open",id=>{
    STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}};
    STATE.collectorQr=STATE.collectorQr||{peerId:"",token:"",deleted:false};
    STATE.judgeQr.peerId=id;
    STATE.collectorQr.peerId=id;
    saveState();
    judgeSendContext();
    if(document.getElementById("judgesQrOverlay")){ openJudgesQR(true); setTimeout(judgeRenderAllQRCodes,50); }
    if(document.getElementById("collectorQrOverlay")){ ensureCollectorQr(); renderCollectorQRCode(); }
    if(onReady) onReady(id);
  });
  judgePeer.on("connection",conn=>{
    conn.on("open",()=>{
      const data=conn.metadata||{};
      const role=String(data.role||"judge");
      if(role==="collector") {
        const token=String(data.token||"");
        if(!token || token!==String(STATE.collectorQr?.token||"")){conn.close();return;}
        if(window.collectorConnection && window.collectorConnection!==conn){try{window.collectorConnection.close()}catch(_){} }
        window.collectorConnection=conn;
        conn.on("close",()=>{if(window.collectorConnection===conn)window.collectorConnection=null;judgeUpdateQrStatuses();});
        conn.on("data",msg=>collectorReceive(msg));
        conn.send({type:"COLLECTOR_CONTEXT",...judgeContextPayload()});
        judgeUpdateQrStatuses();
        return;
      }
      const j=Number(data.judge||0), token=String(data.token||"");
      if(!j || STATE.judgeQr?.tokens?.[j]!==token){conn.close();return;}
      if(judgeConnections[j] && judgeConnections[j]!==conn){try{judgeConnections[j].close()}catch(_){} }
      judgeConnections[j]=conn;
      conn.on("data",msg=>judgeReceive(msg,j));
      conn.on("close",()=>{if(judgeConnections[j]===conn)delete judgeConnections[j];judgeUpdateQrStatuses();});
      conn.send({type:"CONTEXT",...judgeContextPayload()});
      judgeUpdateQrStatuses();
    });
    conn.on("error",()=>{});
  });
  judgePeer.on("error",e=>{
    console.warn("Judge peer",e);
    if(e?.type==="unavailable-id"){
      try{judgePeer.destroy()}catch(_){}
      judgePeer=null;
      STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}};
      STATE.judgeQr.peerId="";
      setTimeout(()=>ensureJudgePeer(onReady),250);
    }
  });
}
function collectorReceive(msg){
  if(!msg||msg.type!=="COLLECTOR_SCORES")return;
  if(STATE.state!==STATES.CALCULATING)return;
  const count=Number(STATE.judgeCount||0), incoming=msg.scores||{}, scores={};
  for(let i=1;i<=count;i++){
    const s=incoming[i];
    if(!s)return;
    const a=Number(s.accuracy), p=Number(s.presentation);
    if(!Number.isFinite(a)||a<0||a>4||!Number.isFinite(p)||p<1.5||p>6)return;
    scores[i]={accuracy:Number(a.toFixed(1)),presentation:Number(p.toFixed(1)),receivedAt:Date.now(),sessionId:STATE.judgeQr?.sessionId||"",source:"collector"};
  }
  STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}};
  STATE.judgeQr.scores=scores;saveState();
  for(let i=1;i<=count;i++){const ai=i-1;const acc=document.getElementById(`acc${ai}`),pres=document.getElementById(`pres${ai}`);if(acc)acc.value=scores[i].accuracy.toFixed(1);if(pres)pres.value=scores[i].presentation.toFixed(1);}
  updateJudgeSubmitButton?.();judgeUpdateQrStatuses();
  try{window.collectorConnection?.send({type:"COLLECTOR_CONTEXT",...judgeContextPayload({scoresReceived:true})});}catch(_){}
}
function judgeReceive(msg,j){
  if(!msg||msg.type!=="SCORE")return;
  if(String(msg.token)!==String(STATE.judgeQr?.tokens?.[j]||""))return;
  if(msg.sessionId!==STATE.judgeQr?.sessionId)return;
  const a=msg.accuracy, p=msg.presentation;
  if(!Number.isFinite(Number(a))||Number(a)<0||Number(a)>4)return;
  const parts=msg.parts||{};
  const vals=[parts.speedPower,parts.rhythmTempo,parts.expressionEnergy].map(Number);
  if(vals.some(v=>!Number.isFinite(v)||v<0.5||v>2))return;
  const presentation=Number((vals[0]+vals[1]+vals[2]).toFixed(1));
  if(Math.abs(presentation-Number(p))>0.001)return;
  STATE.judgeQr.scores[j]={accuracy:Number(a),presentation,parts:{speedPower:vals[0],rhythmTempo:vals[1],expressionEnergy:vals[2]},receivedAt:Date.now(),sessionId:msg.sessionId};
  saveState();
  if(window.collectorConnection?.open){try{window.collectorConnection.send({type:"COLLECTOR_CONTEXT",...judgeContextPayload({scoreReceived:true,judge:j})});}catch(_){} }
  const ai=j-1;
  const acc=document.getElementById(`acc${ai}`),pres=document.getElementById(`pres${ai}`);
  if(acc)acc.value=Number(a).toFixed(3);
  if(pres)pres.value=presentation.toFixed(3);
  updateJudgeSubmitButton?.();
  judgeUpdateQrStatuses();
  renderJudgeRemoteToast?.(j);
}
function judgeContextPayload(extra={}){
  const a=currentAthlete?.();
  const p=currentRoundPoomsae?.();
  return {type:"CONTEXT",sessionId:STATE.judgeQr?.sessionId||"",active:STATE.state===STATES.ROUND_RUNNING||STATE.state===STATES.CALCULATING,scoringOpen:STATE.state===STATES.ROUND_RUNNING||STATE.state===STATES.CALCULATING,round:STATE.currentRound,athlete:a?.name||"",club:a?.club||"",poomsae:WT_DATA.poomsae[p]||p||"",competition:STATE.competitionName||"FTT POOMSAE",matNumber:STATE.matNumber||1,judgeScores:STATE.judgeQr?.scores||{},judgeCount:Number(STATE.judgeCount||0),judgeNames:STATE.judgeNames||{},...extra};
}
function judgeSendContext(extra={}){
  if(!judgeConnections)return;
  const payload=judgeContextPayload(extra);
  Object.values(judgeConnections).forEach(c=>{try{if(c.open)c.send(payload)}catch(e){}});
}
function judgeGenerateTokens(){
  STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}};
  STATE.judgeQr.tokens={};STATE.judgeQr.deleted={};STATE.judgeQr.scores={};
  for(let i=1;i<=Number(STATE.judgeCount||0);i++)STATE.judgeQr.tokens[i]=judgeRandomToken();
  saveState();ensureJudgePeer();openJudgesQR(true);
}
function judgeRegenerateOne(j){
  STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}};
  STATE.judgeQr.tokens[j]=judgeRandomToken();
  STATE.judgeQr.deleted[j]=false;
  delete STATE.judgeQr.scores[j];
  try{judgeConnections[j]?.close()}catch(e){}
  delete judgeConnections[j];saveState();openJudgesQR(true);
}
function judgeDeleteOne(j){
  if(!confirmAction(`DELETE QR FOR JUDGE ${j}?`))return;
  STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}};
  delete STATE.judgeQr.tokens[j];STATE.judgeQr.deleted[j]=true;delete STATE.judgeQr.scores[j];
  try{judgeConnections[j]?.close()}catch(e){} delete judgeConnections[j];
  saveState();openJudgesQR(true);
}
function judgeUpdateQrStatuses(){
  Object.keys(STATE.judgeQr?.tokens||{}).forEach(j=>{const connected=!!judgeConnections[j]?.open, scored=!!STATE.judgeQr?.scores?.[j];const el=document.getElementById(`judgeQrStatus${j}`);if(el){el.textContent=scored?"SCORE RECEIVED":connected?"CONNECTED":"WAITING";el.classList.toggle("connected",connected||scored);}const op=document.querySelector(`.operatorJudgeStatusItem[data-judge="${j}"]`);if(op){op.classList.toggle("online",connected);op.classList.toggle("scored",scored);const st=op.querySelector("span");if(st)st.textContent=scored?"SCORE RECEIVED":connected?"CONNECTED":"WAITING";}});
  const cs=document.getElementById("collectorQrStatus");if(cs)cs.textContent=window.collectorConnection?.open?"CONNECTED":"WAITING";
}
function judgeQrUrl(j){
  const base=judgeBaseUrl();
  const peer=STATE.judgeQr?.peerId||"";
  return `${base}?judge=1&peer=${encodeURIComponent(peer)}&j=${j}&t=${encodeURIComponent(STATE.judgeQr.tokens[j]||"")}&mat=${encodeURIComponent(Number(STATE.matNumber)||1)}`;
}
function openJudgesQR(regenerate=false){
  if(location.protocol==="file:")return alert("JUDGES QR requires the project to be opened from GitHub Pages, Netlify, or a local web server (not directly as a file).");
  if(!STATE.setupComplete)return alert("Complete the Competition Setup first.");
  STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}};
  if(!judgePeer || judgePeer.destroyed || !judgePeer.open){
    ensureJudgePeer(()=>openJudgesQR(regenerate));
    return;
  }
  STATE.judgeQr.peerId=judgePeer.id||STATE.judgeQr.peerId;
  if(!Object.keys(STATE.judgeQr.tokens||{}).length || Object.keys(STATE.judgeQr.tokens||{}).length!==Number(STATE.judgeCount||0)){
    STATE.judgeQr.tokens={};STATE.judgeQr.deleted={};STATE.judgeQr.scores={};for(let i=1;i<=STATE.judgeCount;i++)STATE.judgeQr.tokens[i]=judgeRandomToken();saveState();
  }
  const old=document.getElementById("judgesQrOverlay");if(old)old.remove();
  const overlay=document.createElement("div");overlay.id="judgesQrOverlay";overlay.className="judgeQrOverlay";
  overlay.innerHTML=`<div class="judgeQrModal"><div class="judgeQrHeader"><div><div class="phaseTag">REMOTE JUDGES</div><h2>JUDGES QR</h2><p>Chaque juge scanne uniquement son QR code avec son téléphone.</p></div><button class="btn" onclick="document.getElementById('judgesQrOverlay')?.remove()">CLOSE</button></div><div class="judgeQrGrid">${Array.from({length:Number(STATE.judgeCount||0)},(_,idx)=>{const j=idx+1;const hasQr=!!STATE.judgeQr.tokens?.[j];return `<div class="judgeQrCard"><div class="judgeQrCardTop"><div><strong>JUDGE ${j}</strong><small class="judgeQrName" data-judge-name="${j}">${esc(STATE.judgeNames?.[j]||"NAME NOT SET")}</small></div><span id="judgeQrStatus${j}" class="judgeQrStatus">${hasQr?(judgeConnections[j]?.open?"CONNECTED":"WAITING"):"QR DELETED"}</span></div>${hasQr?`<div id="judgeQr${j}" class="judgeQrImage"></div><div class="judgeQrHint">SCAN WITH PHONE</div>`:`<div class="judgeQrImage judgeQrDeleted"><span>QR<br>DELETED</span></div><div class="judgeQrHint">GENERATE A NEW CODE</div>`}<label class="judgeQrNameEditor">NOM DU JUGE ${j}<input type="text" value="${esc(STATE.judgeNames?.[j]||"")}" placeholder="Nom et prénom du juge ${j}" oninput="judgeSetName(${j},this.value)"></label><div class="judgeQrActions"><button class="btn" onclick="judgeRegenerateOne(${j})">${hasQr?"CHANGE QR":"GENERATE QR"}</button><button class="btn danger" onclick="judgeDeleteOne(${j})" ${hasQr?"":"disabled"}>DELETE</button></div></div>`}).join("")}</div><div class="judgeQrFooter"><span>PEER CONNECTION: <b>${esc(STATE.judgeQr.peerId||"CONNECTING...")}</b></span><button class="btn primary" onclick="judgeGenerateTokens()">REGENERATE ALL QR</button></div></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(()=>judgeRenderAllQRCodes());
  setTimeout(()=>{ judgeRenderAllQRCodes(); judgeUpdateQrStatuses(); },250);
}

function judgeRenderAllQRCodes(){
  for(let j=1;j<=Number(STATE.judgeCount||0);j++){
    const box=document.getElementById(`judgeQr${j}`);
    if(!box || !STATE.judgeQr.tokens?.[j]) continue;
    const text=judgeQrUrl(j);
    box.innerHTML="";
    try{
      if(typeof window.QRCode === "function"){
        new QRCode(box,{text,width:190,height:190,colorDark:"#07111d",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.M});
        if(box.children.length)continue;
      }
    }catch(e){ console.warn("QRCode library failed",e); }
    // Reliable fallback: render the QR through a public QR image endpoint.
    const img=document.createElement("img");
    img.alt=`QR CODE JUGE ${j}`;
    img.width=190; img.height=190;
    img.referrerPolicy="no-referrer";
    img.src=`https://api.qrserver.com/v1/create-qr-code/?size=190x190&margin=8&data=${encodeURIComponent(text)}`;
    img.onerror=()=>{box.innerHTML='<div style="font-size:12px;text-align:center;color:#667789;padding:25px">QR IMAGE UNAVAILABLE<br><small>Check internet connection</small></div>';};
    box.appendChild(img);
  }
}

function judgePhoneSend(type,data){
  if(window._judgePhoneScoringOpen!==true){judgePhoneToast("SCORING NOT OPEN",true);return;}
  const {peer,judge,token}=judgeParams();
  if(!peer||!judge||!token){judgePhoneToast("Invalid judge link",true);return;}
  if(!window._judgePhoneConn||!window._judgePhoneConn.open){judgePhoneToast("Not connected to operator",true);return;}
  window._judgePhoneConn.send({type,...data,judge,token,sessionId:window._judgePhoneSession||""});
  if(type==="SCORE"){window._judgePhoneSent=true;judgePhoneRenderSent();}
}
function judgePhoneToast(msg,error=false){const el=document.getElementById("judgePhoneToast");if(!el)return;el.textContent=msg;el.className=`judgePhoneToast show ${error?"error":""}`;clearTimeout(window._judgeToastTimer);window._judgeToastTimer=setTimeout(()=>el.classList.remove("show"),1800);}
function judgePhoneRenderSent(){const b=document.getElementById("judgePhoneSend");if(b){b.textContent="✓ SCORE SENT";b.classList.add("sent");}}
function judgePhoneClamp(){window._judgePhoneAcc=Math.max(0,Math.min(4,Math.round((window._judgePhoneAcc+Number(window._judgePhoneDelta||0))*10)/10));window._judgePhoneDelta=0;const el=document.getElementById("judgeAccuracyValue");if(el)el.textContent=window._judgePhoneAcc.toFixed(1);}
function judgePhoneAdjust(delta){if(window._judgePhoneScoringOpen!==true)return;window._judgePhoneDelta=Number(delta)||0;judgePhoneClamp();window._judgePhoneSent=false;judgePhoneRenderReset();}
function judgePhoneSetPart(key,value){if(window._judgePhoneScoringOpen!==true)return;if(!window._judgePhoneParts)window._judgePhoneParts={speedPower:2,rhythmTempo:2,expressionEnergy:2};const next=Math.max(0.5,Math.min(2,Math.round(Number(value)*10)/10));window._judgePhoneParts[key]=next;const control=document.querySelector(`[data-part-control="${key}"]`);if(control)control.innerHTML=judgePhoneBuildValues(key);else{const el=document.querySelector(`[data-part-value="${key}"]`);if(el)el.textContent=next.toFixed(1);}const total=Object.values(window._judgePhoneParts).reduce((s,v)=>s+v,0);const t=document.getElementById("judgePresentationTotal");if(t)t.textContent=total.toFixed(1);window._judgePhoneSent=false;judgePhoneRenderReset();}
function renderJudgeRemoteToast(j){ const box=document.getElementById("judgeQrStatus"+j); if(box){box.textContent="SCORE RECEIVED";box.classList.add("connected");setTimeout(()=>judgeUpdateQrStatuses(),1300);} }
function judgePhoneRenderReset(){const b=document.getElementById("judgePhoneSend");if(b){b.textContent="SEND SCORE";b.classList.remove("sent");}}
function judgePhoneAdjustPart(key,delta){if(window._judgePhoneScoringOpen!==true)return;if(!window._judgePhoneParts)window._judgePhoneParts={speedPower:2,rhythmTempo:2,expressionEnergy:2};const current=Number(window._judgePhoneParts[key]||2);judgePhoneSetPart(key,current+Number(delta||0));}
function judgePhoneBuildValues(key,open=window._judgePhoneScoringOpen!==false){const value=Number(window._judgePhoneParts[key]||2);const locked=!open;return `<button type="button" class="partAdjust partMinus" ${value<=0.5||locked?"disabled":""} onclick="judgePhoneAdjustPart('${key}',-0.1)">−</button><div class="partValue" data-part-value="${key}">${value.toFixed(1)}</div><button type="button" class="partAdjust partPlus" ${value>=2||locked?"disabled":""} onclick="judgePhoneAdjustPart('${key}',0.1)">+</button>`;}
async function judgePhoneFullscreen(){
  try{
    if(!document.fullscreenElement){
      await document.documentElement.requestFullscreen?.();
      try{await screen.orientation?.lock?.("landscape");}catch(_){}
    }else{
      await document.exitFullscreen?.();
    }
    judgePhoneUpdateViewport();
  }catch(e){judgePhoneToast("FULL SCREEN NOT AVAILABLE",true);}
}
function judgePhoneUpdateViewport(){
  const app=document.querySelector(".judgePhoneApp");
  const portrait=window.innerHeight>window.innerWidth;
  document.body.classList.toggle("judgePortrait",portrait);
  if(app) app.classList.toggle("judgeLandscape",!portrait);
  const b=document.getElementById("judgeFsBtn");
  if(b)b.textContent=document.fullscreenElement?"↙":"⛶";
  if(b)b.title=document.fullscreenElement?"Quitter le plein écran":"Plein écran";
}
function judgePhoneOrientationPrompt(){
  const p=document.getElementById("judgeOrientationOverlay");
  if(p)p.classList.toggle("show",window.innerHeight>window.innerWidth);
}
function judgePhoneInitControls(){
  document.addEventListener("fullscreenchange",()=>{judgePhoneUpdateViewport();judgePhoneOrientationPrompt();});
  window.addEventListener("resize",()=>{judgePhoneUpdateViewport();judgePhoneOrientationPrompt();});
  judgePhoneUpdateViewport();judgePhoneOrientationPrompt();
}

function collectorRandomToken(){return judgeRandomToken();}
function collectorQrUrl(){const base=judgeBaseUrl();const peer=judgePeer?.open?judgePeer.id:(STATE.collectorQr?.peerId||STATE.judgeQr?.peerId||"");return `${base}?collector=1&peer=${encodeURIComponent(peer)}&t=${encodeURIComponent(STATE.collectorQr?.token||"")}&mat=${encodeURIComponent(Number(STATE.matNumber)||1)}`;}
function ensureCollectorQr(){STATE.collectorQr=STATE.collectorQr||{peerId:"",token:"",deleted:false};if(!STATE.collectorQr.token)STATE.collectorQr.token=collectorRandomToken();if(judgePeer?.open)STATE.collectorQr.peerId=judgePeer.id;else STATE.collectorQr.peerId=STATE.judgeQr?.peerId||STATE.collectorQr.peerId||"";saveState();}
function openCollectorQR(){
  if(location.protocol==="file:")return alert("COLLECTOR QR requires a web server.");
  if(!STATE.setupComplete)return alert("Complete the Competition Setup first.");
  if(!judgePeer || judgePeer.destroyed || !judgePeer.open){
    ensureJudgePeer(()=>openCollectorQR());
    return;
  }
  STATE.collectorQr=STATE.collectorQr||{peerId:"",token:"",deleted:false};
  STATE.collectorQr.peerId=judgePeer.id||STATE.collectorQr.peerId;
  ensureCollectorQr();
  const old=document.getElementById("collectorQrOverlay");if(old)old.remove();
  const overlay=document.createElement("div");overlay.id="collectorQrOverlay";overlay.className="judgeQrOverlay";
  overlay.innerHTML=`<div class="judgeQrModal collectorModal"><div class="judgeQrHeader"><div><div class="phaseTag">REMOTE COLLECTOR</div><h2>COLLECTOR QR</h2><p>Scannez ce QR avec le téléphone du collecteur.</p></div><button class="btn" onclick="document.getElementById('collectorQrOverlay')?.remove()">CLOSE</button></div><div class="collectorQrCenter"><div id="collectorQrImage" class="judgeQrImage"></div><div class="judgeQrHint">SCAN WITH COLLECTOR PHONE</div><span id="collectorQrStatus" class="judgeQrStatus">${window.collectorConnection?.open?"CONNECTED":"WAITING"}</span><div class="judgeQrActions"><button class="btn" onclick="regenerateCollectorQR()">CHANGE QR</button><button class="btn danger" onclick="deleteCollectorQR()">DELETE</button></div></div></div>`;
  document.body.appendChild(overlay);renderCollectorQRCode();
}
function renderCollectorQRCode(){const box=document.getElementById("collectorQrImage");if(!box)return;box.innerHTML="";try{if(typeof QRCode==="function"){new QRCode(box,{text:collectorQrUrl(),width:220,height:220,colorDark:"#07111d",colorLight:"#fff",correctLevel:QRCode.CorrectLevel.M});if(box.children.length)return;}}catch(e){}const img=document.createElement("img");img.width=220;img.height=220;img.alt="COLLECTOR QR";img.src=`https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${encodeURIComponent(collectorQrUrl())}`;box.appendChild(img);}
function regenerateCollectorQR(){ensureCollectorQr();STATE.collectorQr.token=collectorRandomToken();STATE.collectorQr.deleted=false;try{window.collectorConnection?.close()}catch(_){}window.collectorConnection=null;saveState();openCollectorQR();}
function deleteCollectorQR(){if(!confirmAction("DELETE COLLECTOR QR?"))return;STATE.collectorQr.token="";STATE.collectorQr.deleted=true;try{window.collectorConnection?.close()}catch(_){}window.collectorConnection=null;saveState();openCollectorQR();}
function collectorPhoneConnect(p){
  if(typeof Peer!=="function"){collectorPhoneToast("PeerJS unavailable",true);return;}
  if(!p.peer||!p.t){collectorPhoneToast("Invalid collector QR",true);return;}
  let attempts=0,connected=false,retryTimer=null;
  const local=new Peer({debug:0,config:{iceServers:[
    {urls:"stun:stun.l.google.com:19302"},
    {urls:"stun:stun1.l.google.com:19302"}
  ]}});
  const status=t=>{const e=document.getElementById("collectorConnection");if(e){e.textContent=t;e.classList.toggle("connected",t==="CONNECTED");}};
  const connect=()=>{
    if(connected)return;
    attempts++; status(attempts>1?`RECONNECTING ${attempts}`:"CONNECTING");
    let c; try{c=local.connect(p.peer,{reliable:true,serialization:"json",metadata:{role:"collector",token:p.t}});}catch(e){retryTimer=setTimeout(connect,1500);return;}
    window._collectorConn=c;
    c.on("open",()=>{connected=true;clearTimeout(retryTimer);status("CONNECTED");collectorPhoneToast("CONNECTED TO OPERATOR");});
    c.on("data",m=>{if(m?.type==="COLLECTOR_CONTEXT")renderCollectorPhoneContext(m);});
    c.on("close",()=>{connected=false;status("DISCONNECTED");if(attempts<20)retryTimer=setTimeout(connect,1500);});
    c.on("error",()=>{if(!connected){try{c.close()}catch(_){} if(attempts<20)retryTimer=setTimeout(connect,1500);}});
  };
  local.on("open",()=>connect());
  local.on("error",()=>{if(!connected&&attempts<20){clearTimeout(retryTimer);retryTimer=setTimeout(connect,1500)}else if(!connected)status("DISCONNECTED")});
  window._collectorPeer=local;
}
function collectorPhoneToast(msg,error=false){const e=document.getElementById("collectorToast");if(e){e.textContent=msg;e.className=`judgePhoneToast show ${error?"error":""}`;setTimeout(()=>e.classList.remove("show"),1800);}}
function collectorSendScores(){
  if(!window._collectorScoringOpen){collectorPhoneToast("WAIT FOR OPERATOR TO FINISH PERFORMANCE",true);return;}
  const count=Number(window._collectorJudgeCount||0), scores={};
  for(let i=1;i<=count;i++){
    const a=document.getElementById(`collectorAcc${i}`), p=document.getElementById(`collectorPres${i}`);
    const acc=Number(String(a?.value||"").replace(",",".")), pres=Number(String(p?.value||"").replace(",","."));
    if(!Number.isFinite(acc)||acc<0||acc>4||!Number.isFinite(pres)||pres<1.5||pres>6){
      collectorPhoneToast(`ENTER VALID SCORES FOR JUDGE ${i}`,true); a?.focus(); return;
    }
    scores[i]={accuracy:Number(acc.toFixed(1)),presentation:Number(pres.toFixed(1))};
  }
  const c=window._collectorConn;
  if(!c?.open){collectorPhoneToast("NOT CONNECTED TO OPERATOR",true);return;}
  c.send({type:"COLLECTOR_SCORES",scores});
  window._collectorSent=true;
  const b=document.getElementById("collectorSendBtn");if(b){b.disabled=true;b.textContent="SCORES SENT";b.classList.add("sent");}
  document.querySelectorAll(".collectorInput").forEach(x=>x.disabled=true);
  collectorPhoneToast("ALL SCORES SENT TO OPERATOR");
}
function renderCollectorPhoneContext(ctx){
  const mat=Number(ctx.matNumber)||Number(window._collectorMat)||1;
  const judges=Number(ctx.judgeCount||0);
  const open=!!ctx.scoringOpen;
  const athlete=ctx.athlete||"WAITING FOR NEXT POOMSAE";
  window._collectorScoringOpen=open;
  window._collectorJudgeCount=judges;
  const stateEl=document.getElementById("collectorState");if(stateEl)stateEl.textContent=open?"READY TO ENTER SCORES":"WAITING FOR OPERATOR TO FINISH PERFORMANCE";
  const matEl=document.getElementById("collectorMat");if(matEl)matEl.textContent=`TAPIS ${mat}`;
  const titleEl=document.getElementById("collectorMatTitle");if(titleEl)titleEl.textContent=`TAPIS ${mat}`;
  const athleteEl=document.getElementById("collectorAthlete");if(athleteEl)athleteEl.textContent=athlete;
  const list=document.getElementById("collectorJudgeList");if(!list)return;
  const oldValues={};
  list.querySelectorAll(".collectorJudgeBox").forEach(box=>{const i=box.dataset.judge;oldValues[i]={a:document.getElementById(`collectorAcc${i}`)?.value||"",p:document.getElementById(`collectorPres${i}`)?.value||""};});
  list.innerHTML=Array.from({length:judges},(_,i)=>{const j=i+1,v=oldValues[j]||{};return `<div class="collectorJudgeBox" data-judge="${j}"><div class="collectorJudgeTitle">JUDGE ${j}</div><div class="collectorFields"><label>ACCURACY<input class="collectorInput" id="collectorAcc${j}" type="number" min="0" max="4" step="0.1" inputmode="decimal" placeholder="3.2" value="${esc(v.a)}" ${open?"":"disabled"}></label><label>PRESENTATION<input class="collectorInput" id="collectorPres${j}" type="number" min="1.5" max="6" step="0.1" inputmode="decimal" placeholder="4.2" value="${esc(v.p)}" ${open?"":"disabled"}></label></div></div>`;}).join("")+
    `<button id="collectorSendBtn" class="judgePhoneSend collectorSendBtn" ${open?"":"disabled"} onclick="collectorSendScores()">SEND SCORES</button>`;
  if(!open){window._collectorSent=false;}
  if(open&&window._collectorSent){const b=document.getElementById("collectorSendBtn");if(b){b.disabled=true;b.textContent="SCORES SENT";b.classList.add("sent");}document.querySelectorAll(".collectorInput").forEach(x=>x.disabled=true);}
}
function renderCollector(){
  const p=new URLSearchParams(location.search);const qrMat=Number(p.get("mat"))||Number(STATE.matNumber)||1;window._collectorMat=qrMat;
  document.body.innerHTML=`<div class="judgePhoneApp collectorApp"><header class="judgePhoneHeader"><img src="federation_logo_transparent.png"><div><small>FTT POOMSAE · TAPIS <span id="collectorMat">${esc(qrMat)}</span></small><strong>COLLECTOR</strong></div><span id="collectorConnection" class="judgePhoneConnection">CONNECTING</span></header><main id="collectorMain"><section class="collectorPhoneCard"><div class="phaseTag">COLLECTOR</div><h1 id="collectorMatTitle">TAPIS ${esc(qrMat)}</h1><p id="collectorAthlete">WAITING FOR NEXT POOMSAE</p><div id="collectorState" class="collectorState">WAITING FOR OPERATOR TO FINISH PERFORMANCE</div><div id="collectorJudgeList" class="collectorJudgeList"></div></section></main><div id="collectorToast" class="judgePhoneToast"></div></div>`;
  window._collectorScoringOpen=false;window._collectorSent=false;window._collectorJudgeCount=0;
  renderCollectorPhoneContext({matNumber:qrMat,athlete:"",scoringOpen:false,judgeCount:0});
  collectorPhoneConnect({peer:p.get("peer"),t:p.get("t")});
}

function renderJudgePhone(){
  const p=judgeParams();window._judgePhoneName=String(STATE.judgeNames?.[p.judge]||"");ctxMatForHeader=p.mat||Number(STATE.matNumber)||1;
  document.body.innerHTML=`<div class="judgePhoneApp"><div class="judgePhoneGlow g1"></div><div class="judgePhoneGlow g2"></div><header class="judgePhoneHeader"><img src="federation_logo_transparent.png"><div><small>FTT POOMSAE · TAPIS ${esc(ctxMatForHeader||p.mat||STATE.matNumber||1)}</small><strong>JUDGE ${p.judge||"—"}</strong><em class="judgePhoneName" id="judgePhoneName">${esc(window._judgePhoneName||"")}</em></div><div class="judgePhoneHeaderActions"><span id="judgePhoneConnection" class="judgePhoneConnection">CONNECTING</span><button id="judgeFsBtn" class="judgePhoneFsBtn" onclick="judgePhoneFullscreen()" title="Plein écran">⛶</button></div></header><main id="judgePhoneMain"></main><div id="judgePhoneToast" class="judgePhoneToast"></div><div id="judgeOrientationOverlay" class="judgeOrientationOverlay"><div class="orientationIcon">↔</div><strong>TURN PHONE TO LANDSCAPE</strong><span>Le mode paysage est obligatoire pour noter.</span><button class="judgePhoneFsBtn large" onclick="judgePhoneFullscreen()">⛶ FULL SCREEN</button></div></div>`;
  window._judgePhoneAcc=4;window._judgePhoneParts={speedPower:2,rhythmTempo:2,expressionEnergy:2};window._judgePhoneSent=false;window._judgePhoneScoringOpen=false;
  judgePhoneInitControls();
  judgePhoneRenderMain({active:false,scoringOpen:false,athlete:"",club:"",poomsae:"",round:1,competition:"FTT POOMSAE"});
  judgePhoneConnect(p);
}
function judgePhoneConnect(p){
  if(typeof Peer!=="function"){judgePhoneToast("PeerJS unavailable",true);return;}
  if(!p.peer||!p.judge||!p.token){judgePhoneToast("Invalid judge QR",true);return;}
  let attempts=0, connected=false, retryTimer=null;
  const local=new Peer({debug:0,config:{iceServers:[
    {urls:"stun:stun.l.google.com:19302"},
    {urls:"stun:stun1.l.google.com:19302"}
  ]}});
  const setStatus=(text,on)=>{const el=document.getElementById("judgePhoneConnection");if(el){el.textContent=text;el.classList.toggle("connected",!!on);}};
  const connect=()=>{
    if(connected)return;
    attempts++; setStatus(attempts>1?`RECONNECTING ${attempts}`:"CONNECTING",false);
    let conn; try{conn=local.connect(p.peer,{reliable:true,serialization:"json",metadata:{role:"judge",judge:p.judge,token:p.token}});}catch(e){retryTimer=setTimeout(connect,1200);return;}
    window._judgePhoneConn=conn;
    const fail=()=>{if(connected)return;try{conn.close()}catch(_){} if(attempts<20)retryTimer=setTimeout(connect,1000);else setStatus("DISCONNECTED",false);};
    conn.on("open",()=>{connected=true;clearTimeout(retryTimer);setStatus("CONNECTED",true);judgePhoneToast("CONNECTED TO OPERATOR");});
    conn.on("data",msg=>{if(msg?.type==="CONTEXT"){ctxMatForHeader=Number(msg.matNumber)||1;window._judgePhoneName=String(msg.judgeNames?.[p.judge]||"");const nameEl=document.getElementById("judgePhoneName");if(nameEl)nameEl.textContent=window._judgePhoneName;const nextSession=msg.sessionId||"";if(nextSession!==window._judgePhoneSession){window._judgePhoneAcc=4;window._judgePhoneParts={speedPower:2,rhythmTempo:2,expressionEnergy:2};window._judgePhoneSent=false;window._judgePhoneScoringOpen=false;judgePhoneRenderReset();}window._judgePhoneSession=nextSession;judgePhoneRenderMain(msg);}});
    conn.on("close",()=>{connected=false;setStatus("DISCONNECTED",false);if(attempts<20)retryTimer=setTimeout(connect,1000);});
    conn.on("error",fail);
  };
  local.on("open",()=>{attempts=0;connect();});
  local.on("error",()=>{if(attempts<20){clearTimeout(retryTimer);retryTimer=setTimeout(connect,1000)}else judgePhoneToast("Cannot connect to operator",true)});
  window._judgePhonePeer=local;
}
function judgePhoneRenderMain(ctx){
  const open=!!ctx.scoringOpen;
  window._judgePhoneScoringOpen=open;
  const total=Object.values(window._judgePhoneParts||{speedPower:2,rhythmTempo:2,expressionEnergy:2}).reduce((s,v)=>s+v,0);
  const main=document.getElementById("judgePhoneMain");if(!main)return;
  const header=`<section class="judgePhoneMatch"><div class="judgePhoneEyebrow">${esc(ctx.competition||"FTT POOMSAE")}</div><h1>${esc(ctx.athlete||"WAITING FOR NEXT POOMSAE")}</h1><p>${esc(ctx.club||"")}</p><div class="judgePhoneRound">ROUND ${ctx.round||1} · ${esc(ctx.poomsae||"—")}</div></section>`;
  const scoring=`<section class="judgeScoreCard ${open?'':'judgeScoreLocked'}"><div class="judgeScoringState">${open?'SCORING OPEN':'WAITING FOR OPERATOR'}</div><div class="scoreSectionTitle"><span>ACCURACY</span><small>STARTING SCORE</small></div><div id="judgeAccuracyValue" class="judgeAccuracyValue">${Number(window._judgePhoneAcc||4).toFixed(1)}</div><div class="accuracyControls"><div class="accuracyCol"><button type="button" class="accuracyMinus big" ${open?'':'disabled'} onclick="judgePhoneAdjust(-0.3)">−0.3</button><button type="button" class="accuracyPlus small" ${open?'':'disabled'} onclick="judgePhoneAdjust(0.3)">+0.3</button></div><div class="accuracyCol"><button type="button" class="accuracyMinus big" ${open?'':'disabled'} onclick="judgePhoneAdjust(-0.1)">−0.1</button><button type="button" class="accuracyPlus small" ${open?'':'disabled'} onclick="judgePhoneAdjust(0.1)">+0.1</button></div></div><div class="scoreSectionTitle presentationTitle"><span>PRESENTATION</span><small>3 PARAMETERS</small></div><div class="presentationParts"><div class="partCard"><b>SPEED &amp; POWER</b><div class="partControl" data-part-control="speedPower">${judgePhoneBuildValues("speedPower",open)}</div></div><div class="partCard"><b>RHYTHM &amp; TEMPO</b><div class="partControl" data-part-control="rhythmTempo">${judgePhoneBuildValues("rhythmTempo",open)}</div></div><div class="partCard"><b>EXPRESSION OF ENERGY</b><div class="partControl" data-part-control="expressionEnergy">${judgePhoneBuildValues("expressionEnergy",open)}</div></div></div><div class="presentationTotal"><span>PRESENTATION</span><strong id="judgePresentationTotal">${total.toFixed(1)}</strong></div><button id="judgePhoneSend" class="judgePhoneSend" ${open?'':'disabled'} onclick="judgePhoneSend('SCORE',{accuracy:Number(window._judgePhoneAcc.toFixed(1)),presentation:Number(Object.values(window._judgePhoneParts).reduce((s,v)=>s+v,0).toFixed(1)),parts:{...window._judgePhoneParts}})">SEND SCORE</button></section>`;
  main.innerHTML=header+scoring;
}


function renderJudge(){renderJudgePhone();}
if(judgeIsPhone())renderJudge();
else if(new URLSearchParams(location.search).get("collector")==="1")renderCollector();
else if(!new URLSearchParams(location.search).get("display")) ensureJudgePeer();
function judgeSetName(j,value){
  j=Number(j)||1;
  STATE.judgeNames=STATE.judgeNames||{};
  STATE.judgeNames[j]=String(value||"").trim();
  saveState();
  const name=document.querySelector(`.judgeQrName[data-judge-name="${j}"]`);
  if(name) name.textContent=STATE.judgeNames[j]||"NAME NOT SET";
  const items=document.querySelectorAll(`.operatorJudgeStatusItem[data-judge="${j}"] .operatorJudgeIdentity strong`);
  items.forEach(el=>el.textContent=STATE.judgeNames[j]||"NAME NOT SET");
  const box=document.querySelector(`.judgeBox[data-judge="${j}"] .operatorJudgeName`);
  if(box) box.textContent=STATE.judgeNames[j]||"NAME NOT SET";
  judgeSendContext();
}

