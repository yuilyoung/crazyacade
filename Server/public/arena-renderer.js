import { createLayout } from './map-catalog.js';
import { drawAvatar, drawOrb, drawPickup } from './visuals.js';
import { createMotionTimeline } from './motion-timeline.js';
import { drawArenaEffects } from './arena-effects.js';
/** Canvas view owns drawing only; state and display transform are injected. */
export function createArenaRenderer({ canvas, display, imageFactory = () => new Image(), visibilitySource = globalThis.document }) {
const ctx=canvas.getContext('2d');
const timeline=createMotionTimeline();
const reset=()=>timeline.reset();
visibilitySource?.addEventListener('visibilitychange',reset);
function dispose(){visibilitySource?.removeEventListener('visibilitychange',reset);}
let motionFrame;
let state=null, playerId=null, selection={}, highContrast=false, experience={reducedMotion:false};
const tileImages={};
for(const map of ['garden','lagoon','candy']) for(const type of ['wall','crate']) {const image=imageFactory();image.src=`/assets/tiles/${map}-${type}.svg`;tileImages[`${map}-${type}`]=image;}
const colors = {
  garden: { floor: '#d9edc4', alternate: '#d1e7b9', wall: '#6eaaa0', wallTop: '#9acabc', box: '#e4b077', boxTop: '#f4d09c' },
  lagoon: { floor: '#ceeaf2', alternate: '#c0e2ec', wall: '#6298b5', wallTop: '#8fc3d6', box: '#d5b689', boxTop: '#f2d5a7' },
  harbor: { floor:'#cbe7ef',alternate:'#b6d9e4',wall:'#476f8b',wallTop:'#7d9fb0',box:'#b79064',boxTop:'#e2bb87' },
  festival: { floor:'#f7dfbf',alternate:'#f4d2a4',wall:'#b278a3',wallTop:'#e6b5cf',box:'#df9a69',boxTop:'#ffd89a' },
  candy: { floor: '#f1d5e4', alternate: '#edc9db', wall: '#a38aba', wallTop: '#c3afd9', box: '#e3a7b7', boxTop: '#ffd1dc' }
};
const tile = 60;
let markerScale = 1, markerFont = 10, markerRadius = 8, compactMarkers = false;
function measureMarkers() {
  const width = canvas.getBoundingClientRect().width;
  if (!width) return;
  markerScale = width / 780; markerFont = Math.max(10, Math.ceil(10 / markerScale));
  markerRadius = Math.max(8, Math.ceil(7 / markerScale)); compactMarkers = width < 480;
  canvas.dataset.essentialMarkerCssPx = (markerFont * markerScale).toFixed(2);
  canvas.dataset.teamMarkerCssPx = (markerRadius * 2 * markerScale).toFixed(2);
}

function roundRect(x, y, w, h, radius, fill, stroke) { ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = highContrast ? 4 : 2; ctx.stroke(); } }
function circle(x, y, r, fill, stroke) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = highContrast ? 4 : 2; ctx.stroke(); } }
function point(x, y) { return { x: x * tile + tile / 2, y: (10 - y) * tile + tile / 2 }; }
function drawTeamMarker(blue, me) {
  // Keep essential labels readable in CSS pixels as the arena scales down.
  const x = compactMarkers ? 10 : 20, y = compactMarkers ? 20 : 17, radius = markerRadius;
  ctx.save(); ctx.beginPath();
  if (blue) ctx.arc(x, y, radius, 0, Math.PI * 2);
  else { const extent = radius * 1.15; ctx.moveTo(x, y - extent); ctx.lineTo(x + extent, y); ctx.lineTo(x, y + extent); ctx.lineTo(x - extent, y); ctx.closePath(); }
  ctx.fillStyle = me ? '#fff1a3' : blue ? '#124e77' : '#82244c'; ctx.fill();
  ctx.strokeStyle = me ? '#182c3a' : '#fff'; ctx.lineWidth = Math.max(2, 1 / markerScale); ctx.stroke();
  ctx.font = `bold ${markerFont}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = me ? '#182c3a' : '#fff';
  ctx.fillText(me ? '나' : blue ? 'B' : 'P', x, y + .5 / markerScale); ctx.restore();
}
function drawStar(x, y, radius = 20) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? radius * .45 : radius;
    const px = x + Math.cos(angle) * r, py = y + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath(); ctx.fillStyle = '#ffe482'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#875b13'; ctx.stroke();
}
function drawRelayBases(relay) {
  if (!relay) return;
  for (const [team, base] of Object.entries(relay.bases)) {
    const q = point(base.x, base.y), blue = team === 'blue';
    roundRect(q.x - 27, q.y - 26, 54, 52, 11, blue ? '#d5edff' : '#ffe1ed', blue ? '#175883' : '#8d2e54');
    ctx.fillStyle = blue ? '#175883' : '#8d2e54'; ctx.font = `bold ${markerFont}px system-ui`; ctx.textAlign = 'center';
    ctx.fillText(`${blue ? 'B' : 'P'}`, q.x, q.y + 18);
    ctx.font = 'bold 23px system-ui'; ctx.fillText('⌂', q.x, q.y - 9);
  }
}
function drawPassGuide(guide, markersOnly = false) {
  if (!guide) return;
  const ink=highContrast?'#132c3b':guide.outcome==='enemy'?'#963355':guide.outcome==='ally'?'#1c6654':'#75602c';
  ctx.save(); ctx.strokeStyle=ink;ctx.lineWidth=Math.max(3,1.5/markerScale);
  if (!markersOnly) {
    const from=point(guide.from.x,guide.from.y),last=guide.target || guide.cells.at(-1) || guide.from,to=point(last.x,last.y);
    ctx.globalAlpha=.55;ctx.setLineDash([9,7]);ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);ctx.stroke();
  } else {
    ctx.setLineDash([]);
    if (guide.target) {
      const target=point(guide.target.x,guide.target.y);roundRect(target.x-27,target.y-27,54,54,8,null,ink);
      const symbol=guide.outcome==='enemy'?'!':'✓',radius=Math.max(11,markerFont*.6),x=target.x+20,y=target.y-23;
      circle(x,y,radius,'#fff',ink);ctx.font=`bold ${markerFont}px system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=ink;ctx.fillText(symbol,x,y);
    } else if (guide.obstacle) {
      const target=point(guide.obstacle.x,guide.obstacle.y);circle(target.x,target.y,Math.max(11,markerFont*.6),'#fff',ink);
      ctx.font=`bold ${markerFont}px system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=ink;ctx.fillText('×',target.x,target.y);
    }
  }
  ctx.restore();
}
function drawPlayer(pose, time, index) {
  const p=pose.player;
  const q = point(pose.x, pose.y), me = p.id === playerId, blue = p.team ? p.team === 'blue' : index === 0;
  if (!p.alive) {
    if(!experience.reducedMotion && pose.death!==null && pose.alpha>0){ctx.save();ctx.translate(q.x,q.y);ctx.globalAlpha=pose.alpha;drawAvatar(ctx,p,{time,reducedMotion:experience.reducedMotion,highContrast,pose});ctx.restore();}
    return;
  }
  ctx.save(); ctx.translate(q.x, q.y);
  ctx.fillStyle = '#25444325'; ctx.beginPath(); ctx.ellipse(0, 20, 22, 7, 0, 0, Math.PI * 2); ctx.fill();
  if (me && p.facing && (p.darts > 0 || state?.relay?.carrierId === p.id)) {
    const angle = { right: 0, up: -Math.PI / 2, left: Math.PI, down: Math.PI / 2 }[p.facing] ?? 0;
    ctx.save(); ctx.rotate(angle); ctx.fillStyle = '#f9c454'; ctx.beginPath(); ctx.moveTo(29, -5); ctx.lineTo(38, 0); ctx.lineTo(29, 5); ctx.fill(); ctx.restore();
  }
  if (me) { circle(0, 3, 26, null, highContrast ? '#101a24' : '#ffe581'); ctx.fillStyle = highContrast ? '#101a24' : '#ffe581'; ctx.beginPath(); ctx.moveTo(-6, -37); ctx.lineTo(6, -37); ctx.lineTo(0, -29); ctx.fill(); }
  drawAvatar(ctx, p, { time, reducedMotion: experience.reducedMotion, highContrast, pose });
  if (state?.relay?.carrierId === p.id) {
    drawStar(22, -25, 11); roundRect(-18, -48, 36, 14, 4, '#fff4bf', '#875b13');
    ctx.font = 'bold 10px system-ui'; ctx.fillStyle = '#704600'; ctx.textAlign = 'center'; ctx.fillText('별 운반', 0, -37);
  }
  if (p.bubbleTicks > 0) {
    circle(0, 0, 27 + (experience.reducedMotion ? 0 : Math.sin(time / 100) * 2), '#b6eaff88', '#075681');
  }
  drawTeamMarker(blue, me);
  if (p.bubbleTicks > 0) {
    const ally = !me && p.team && p.team === state?.players.find(player => player.id === playerId)?.team;
    const label = `${ally ? '+' : ''}${Math.ceil(p.bubbleTicks / 10)}`;
    ctx.font = `bold ${markerFont}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const width = ctx.measureText(label).width + 8, height = markerFont * 1.2;
    roundRect(-width / 2, -23 - height / 2, width, height, 4, ally ? '#fff2b6' : '#fff', ally ? '#643b00' : '#075681');
    ctx.fillStyle = ally ? '#643b00' : '#123c55'; ctx.fillText(label, 0, -23);
    ctx.textBaseline = 'alphabetic';
  }
  if (!compactMarkers) {
    if (highContrast) roundRect(-36, 28, 72, 15, 3, '#fff');
    ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = highContrast ? '#102b3c' : '#264d54'; ctx.fillText(me ? `${p.name} · 나` : p.name, 0, 38, 68);
  }
  ctx.restore();
}
function draw(time, view) {
  state = view.snapshot; playerId = view.playerId;
  selection = view.selection; highContrast = view.settings.highContrast;
  experience = { reducedMotion: view.reducedMotion || view.settings.effects !== 'full' };
  const level=view.settings.effects==='minimal'?'minimal':experience.reducedMotion?'calm':'full';
  motionFrame=timeline.update(state,{now:time,connection:view.connection ?? 'connected',reducedMotion:Boolean(view.reducedMotion),effects:view.settings.effects || 'full',hidden:Boolean(visibilitySource?.hidden)});
  display.renderTransform(ctx); measureMarkers();
  canvas.dataset.passGuide=view.passGuide?.status || ''; canvas.dataset.passTarget=view.passGuide?.target ? `${view.passGuide.target.x},${view.passGuide.target.y}` : ''; canvas.dataset.passObstacle=view.passGuide?.obstacle?.kind || '';
  const mapId = state?.mapId || selection.mapId, theme = highContrast ? { floor: '#fff', alternate: '#e3ecf2', wall: '#152c3b', wallTop: '#304c60', box: '#6b4300', boxTop: '#f2c46c' } : colors[mapId] || colors.garden;
  const relay = state?.relay || (!state && ['relay', 'harmony'].includes(selection.ruleSet) ? { star: { x: 6, y: 5 }, bases: { blue: { x: 1, y: 5 }, pink: { x: 11, y: 5 } } } : null);
  const layout = createLayout(mapId, selection.mode);
  const solid = new Set(state?.solid || layout.solid);
  ctx.clearRect(0, 0, 780, 660);
  for (let x = 0; x < 13; x++) for (let y = 0; y < 11; y++) {
    const q = point(x, y); ctx.fillStyle = (x + y) % 2 ? theme.floor : theme.alternate; ctx.fillRect(q.x - 30, q.y - 30, 60, 60);
    if (solid.has(`${x},${y}`)) {
      const texture = tileImages[`${mapId}-wall`];
      if (!highContrast && texture?.complete && texture.naturalWidth) ctx.drawImage(texture, q.x - 30, q.y - 30, 60, 60);
      else { roundRect(q.x - 28, q.y - 25, 56, 53, 8, theme.wall); roundRect(q.x - 28, q.y - 30, 56, 47, 8, theme.wallTop); roundRect(q.x - 21, q.y - 24, 42, 5, 3, '#ffffff30'); }
    }
  }
  const previewCrates = [...layout.soft].filter(cell => { if (!relay) return true; const [x,y]=cell.split(',').map(Number); return [[6,5],[1,5],[11,5]].every(([bx,by])=>Math.abs(x-bx)+Math.abs(y-by)>1); });
  for (const cell of state?.soft || previewCrates) {
    const [x, y] = cell.split(',').map(Number), q = point(x, y);
    const texture = tileImages[`${mapId}-crate`];
    if (!highContrast && texture?.complete && texture.naturalWidth) { ctx.drawImage(texture, q.x - 30, q.y - 30, 60, 60); continue; }
    roundRect(q.x - 23, q.y - 19, 46, 44, 7, theme.box); roundRect(q.x - 23, q.y - 25, 46, 38, 7, theme.boxTop, highContrast ? theme.box : undefined);
    ctx.strokeStyle = theme.box; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(q.x - 14, q.y - 16); ctx.lineTo(q.x + 14, q.y + 5); ctx.moveTo(q.x + 14, q.y - 16); ctx.lineTo(q.x - 14, q.y + 5); ctx.stroke();
  }
  drawRelayBases(relay);
  if (state?.training?.target && state.training.status === 'active') {
    const target = point(state.training.target.x, state.training.target.y);
    ctx.save(); ctx.setLineDash([7, 4]); roundRect(target.x - 27, target.y - 27, 54, 54, 7, '#fff59d55', '#554000'); ctx.setLineDash([]);
    roundRect(target.x - 23, target.y - 25, 46, 17, 3, '#fff8ca', '#554000'); ctx.fillStyle = '#3c2b00'; ctx.font = `bold ${markerFont}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(view.training?.targetLabel || '목표', target.x, target.y - 12); ctx.restore();
  }
  drawPassGuide(view.passGuide);
  for (const item of state?.items || []) { const q = point(item.x, item.y); ctx.save(); ctx.translate(q.x,q.y); drawPickup(ctx,item,{style:view.settings.itemStyle,highContrast,time,reducedMotion:experience.reducedMotion}); ctx.restore(); }
  for (const orb of state?.orbs || []) { const q = point(orb.x,orb.y); ctx.save(); ctx.translate(q.x,q.y); drawOrb(ctx,orb,{time,reducedMotion:experience.reducedMotion,highContrast,ageMs:motionFrame.orbs.get(`${orb.x},${orb.y}`)?.ageMs}); ctx.restore(); }
  for (const gate of state?.mapFeatures?.gates || []) for (const cell of gate.cells) {
    const [x,y] = cell.split(',').map(Number), q=point(x,y);
    if (gate.closing || gate.pending) { roundRect(q.x-27,q.y-27,54,54,5,'#fff0aabb','#795000'); ctx.fillStyle='#513c00'; ctx.font='bold 22px system-ui'; ctx.textAlign='center'; ctx.fillText('!',q.x,q.y+8); }
    else if (!gate.closed) { ctx.strokeStyle='#267894'; ctx.lineWidth=3; ctx.strokeRect(q.x-25,q.y-25,50,50); }
  }
  for (const pass of relay?.passEffects || []) {
    const from=point(pass.x,pass.y),to=point(pass.x+pass.dx*pass.length,pass.y+pass.dy*pass.length);
    ctx.save(); ctx.strokeStyle=pass.interception?'#9f2655':'#947100';ctx.lineWidth=6;ctx.setLineDash([10,7]);ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);ctx.stroke();drawStar(to.x,to.y,12);ctx.restore();
  }
  for (const wave of state?.waves || []) {
    const q = point(wave.x, wave.y); roundRect(q.x - 29, q.y - 27, 58, 54, 13, highContrast ? '#8eddf8' : '#87eaffbb', highContrast ? '#00436b' : undefined);
    if (highContrast) { ctx.save(); ctx.clip(); ctx.strokeStyle = '#00436b'; ctx.lineWidth = 3; for (let offset = -60; offset <= 60; offset += 12) { ctx.beginPath(); ctx.moveTo(q.x + offset, q.y - 30); ctx.lineTo(q.x + offset + 60, q.y + 30); ctx.stroke(); } ctx.restore(); }
    if(level==='full') {
      const age=motionFrame.waves.get(`${wave.x},${wave.y}`)?.ageMs || 0,flow=Math.sin(age/90+wave.x*.7+wave.y)*3;
      ctx.save();ctx.beginPath();ctx.roundRect(q.x-29,q.y-27,58,54,13);ctx.clip();
      circle(q.x-8+flow,q.y-7,11,'#efffffaa');circle(q.x+13-flow,q.y+8,7,'#e1ffffbb');
      ctx.strokeStyle=highContrast?'#00436b':'#f4ffff';ctx.lineWidth=2;
      for(let i=0;i<3;i++){const y=q.y-16+i*16;ctx.beginPath();ctx.moveTo(q.x-25,y+flow);ctx.quadraticCurveTo(q.x,y-6+flow,q.x+25,y+flow);ctx.stroke();}
      ctx.restore();
    } else if(level==='calm'&&!highContrast) {circle(q.x-8,q.y-7,13,'#efffffaa');circle(q.x+13,q.y+8,8,'#e1ffffbb');}
  }
  for (const dart of state?.dartEffects || []) {
    const from = point(dart.x, dart.y), to = point(dart.x + dart.dx * dart.length, dart.y + dart.dy * dart.length);
    ctx.save(); ctx.globalAlpha = Math.min(1, (dart.ttl || 1) / 3); ctx.strokeStyle = '#fff2a8'; ctx.lineWidth = 5; ctx.setLineDash([8, 5]);
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.translate(to.x, to.y); ctx.rotate(Math.atan2(-dart.dy, dart.dx)); ctx.fillStyle = '#e9ae4e'; ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-6, -6); ctx.lineTo(-6, 6); ctx.fill(); ctx.restore();
  }
  if (relay?.star) {
    const q = point(relay.star.x, relay.star.y);
    circle(q.x, q.y, 25, '#ffffffa8'); drawStar(q.x, q.y - 3);
    ctx.fillStyle = '#704600'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('별', q.x, q.y + 24);
  }
  drawArenaEffects(ctx,motionFrame.effects,{point,highContrast,level,markerFont,playerPoint:id=>{
    const pose=motionFrame.players.get(id);
    return pose ? {...point(pose.x,pose.y),alive:pose.player.alive} : null;
  }});
  [...motionFrame.players.values()].forEach((pose,i)=>drawPlayer(pose,time,i));
  drawPassGuide(view.passGuide,true);
  return motionFrame;
}
return { draw, reset, dispose };
}
