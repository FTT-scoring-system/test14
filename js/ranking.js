// 12. Ranking Engine — manual tie resolution only
function presentationGeneral(a){
  const vals=(a.rounds||[]).map(r=>Number(r?.presentation)).filter(Number.isFinite);
  return vals.length ? vals.reduce((s,v)=>s+v,0)/vals.length : 0;
}
function noExtremesGeneral(a){return (a.rounds||[]).reduce((s,r)=>s+calculateWithoutExtremes(r).total,0)}
function pairKey(a,b){return [a.id,b.id].sort().join("::")}
function manualResolutionFor(a,b){return STATE.tieResolutions?.[pairKey(a,b)]||null}
function baseCompare(a,b){
  const finalDiff=Number(a.finalScore)-Number(b.finalScore);
  if(Math.abs(finalDiff)>0.0005)return finalDiff>0?-1:1;

  // Official tie-break: when Final Score is equal, the higher
  // Presentation Average gets the better rank.
  const presDiff=presentationGeneral(a)-presentationGeneral(b);
  if(Math.abs(presDiff)>0.0005)return presDiff>0?-1:1;

  // Only a complete tie (Final Score + Presentation Average)
  // requires an explicit operator decision. The decision is exposed in the
  // Final Result screen and blocks qualification/podium until resolved.
  const res=manualResolutionFor(a,b);
  if(res?.winnerId)return res.winnerId===a.id?-1:1;
  return 0;
}
function compareReason(a,b){
  if(Math.abs(Number(a.finalScore)-Number(b.finalScore))>0.0005)return null;
  const presDiff=presentationGeneral(a)-presentationGeneral(b);
  return Math.abs(presDiff)>0.0005 ? (presDiff>0 ? "presentation" : "presentation") : null;
}
function wonByPresentation(a,ranking){
  if(!a || !Number.isFinite(Number(a.finalScore)))return false;
  const same=(ranking||[]).filter(x=>x.id!==a.id && Math.abs(Number(x.finalScore)-Number(a.finalScore))<=0.0005);
  return same.some(x=>presentationGeneral(a)>presentationGeneral(x)+0.0005);
}
function allAthletesFinalized(){
  const active=STATE.athletes.filter(a=>!a.absent);
  return active.length>0 && active.every(a=>Number.isFinite(a.finalScore));
}
function computeRanking(){
  const arr=STATE.athletes.filter(a=>!a.absent&&Number.isFinite(a.finalScore)).slice().sort(baseCompare);
  STATE.rankings=[];
  arr.forEach((a,i)=>{
    const prev=arr[i-1];
    const position=(i>0&&prev&&baseCompare(a,prev)===0)?STATE.rankings[i-1].position:i+1;
    STATE.rankings.push({...a,position});
  });
  // Mark athletes whose better position comes from Presentation Average.
  STATE.rankings=STATE.rankings.map(x=>({...x,wonByPresentation:wonByPresentation(x,STATE.rankings)}));
  return STATE.rankings;
}
function publicRanking(){return computeRanking().filter(x=>!x.absent)}
function qualifiedCount(){return STATE.participation==="INDIVIDUAL"?8:4}
function qualifiedParticipants(){return computeRanking().filter(x=>!x.absent).slice(0,qualifiedCount())}
function medal(pos){return pos===1?"GOLD":pos===2?"SILVER":(pos===3||pos===4)?"BRONZE":""}
function medalRank(pos){return pos>=3&&pos<=4?3:pos}
function unresolvedTiePairs(){
  // Manual tie resolution is only available after EVERY active athlete has
  // completed both rounds and has a published final score. Never expose
  // tie decisions while the competition is still in progress.
  if(!allAthletesFinalized()) return [];
  const arr=STATE.athletes.filter(a=>!a.absent&&Number.isFinite(Number(a.finalScore))).slice().sort((a,b)=>Number(b.finalScore)-Number(a.finalScore));
  const out=[];
  for(let i=0;i<arr.length;i++){
    for(let j=i+1;j<arr.length;j++){
      const a=arr[i],b=arr[j];
      if(Math.abs(Number(a.finalScore)-Number(b.finalScore))>0.0005) break;
      // Presentation Average is the first automatic tie-break.
      if(Math.abs(presentationGeneral(a)-presentationGeneral(b))>0.0005) continue;
      if(!manualResolutionFor(a,b)) out.push([a,b]);
    }
  }
  return out;
}
function tiePairs(){return unresolvedTiePairs()}
function hasTie(){return unresolvedTiePairs().length>0}
function resolveManualTie(winnerId,loserId){
  if(!winnerId||!loserId||winnerId===loserId)return false;
  const a=STATE.athletes.find(x=>x.id===winnerId),b=STATE.athletes.find(x=>x.id===loserId);
  if(!a||!b||Math.abs(Number(a.finalScore)-Number(b.finalScore))>0.0005)return false;
  STATE.tieResolutions=STATE.tieResolutions||{};
  STATE.tieResolutions[pairKey(a,b)]={winnerId,loserId,reason:"operator_manual",at:new Date().toISOString()};
  logEvent("MANUAL_TIE_RESOLVED",{name:a.name,message:`${a.name} wins over ${b.name}`});
  saveState();computeRanking();broadcast();render();return true;
}
function manualTieHTML(){
  const pairs=unresolvedTiePairs();
  if(!pairs.length)return "";
  return `<div class="manualTiePanel"><div class="phaseTag">ÉGALITÉ À DÉCIDER PAR L’OPÉRATEUR</div><p class="muted">Aucune règle automatique de départage. Sélectionnez simplement le gagnant et le perdant pour chaque égalité.</p>${pairs.map(([a,b],i)=>`<div class="manualTiePair"><div class="manualTieAth"><b>${esc(a.name)}</b><small>Score ${fmt3(a.finalScore)}</small></div><span class="manualTieVs">VS</span><div class="manualTieAth"><b>${esc(b.name)}</b><small>Score ${fmt3(b.finalScore)}</small></div><div class="manualTieActions"><button class="btn success" onclick="resolveManualTie('${a.id}','${b.id}')">✓ ${esc(a.name)} GAGNANT</button><button class="btn danger" onclick="resolveManualTie('${b.id}','${a.id}')">✓ ${esc(b.name)} GAGNANT</button></div></div>`).join("")}</div>`;
}
