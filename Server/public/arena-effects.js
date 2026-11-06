// Presentation only: cell coordinates are projected here once, never inferred from distance.
const TAU = Math.PI * 2;
const labels = {place:'설치',explode:'물결',break:'파괴',pickup:'획득',hit:'피격',rescue:'구출',death:'탈락',spawn:'복귀',dart:'다트',pass:'패스'};
const playerKinds = new Set(['pickup','hit','rescue','spawn','death']);
const itemLabels = {orb:'폭탄 +',wave:'물줄기 +',dash:'속도 +',speed:'속도 +',pin:'바늘 +',dart:'다트 +'};

/** Bounded decoration behind essential overlays. Optional playerPoint(id) returns
 * current Canvas coordinates plus alive; missing players return null. Without it,
 * standalone callers retain the event's original cell projection. */
export function drawArenaEffects(ctx, effects, {point,highContrast=false,level='full',markerFont=10,playerPoint}={}) {
  if(level==='minimal') return;
  for(const effect of effects.slice(0,128)) {
    if(!labels[effect.kind]) continue;
    const {kind}=effect, p=Math.max(0,Math.min(1,effect.progress ?? 0));
    let q;
    if(playerPoint && effect.playerId!=null && playerKinds.has(kind)) {
      q=playerPoint(effect.playerId);
      if(!q || (q.alive===false && kind!=='death')) continue;
    } else q=point(effect.x,effect.y);
    const ink=highContrast?'#102b3c':kind==='break'?'#845529':kind==='hit'||kind==='death'?'#874260':kind==='pickup'?'#806000':'#126b86';
    ctx.save();ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle=ink;ctx.lineWidth=highContrast?3:2;
    const ring=(x,y,r,fill)=>{ctx.beginPath();ctx.arc(x,y,r,0,TAU);if(fill){ctx.fillStyle=fill;ctx.fill();}ctx.stroke();};
    if(level!=='full') {
      // Event progress never shifts, pulses or fades accessible static markers.
      // Leave the avatar head, self arrow, and bubble countdown clear.
      ring(q.x-34,q.y-34,7,'#fff');ctx.fillStyle=ink;ctx.font=`bold ${markerFont}px system-ui`;ctx.textAlign='center';
      ctx.fillText(kind==='pickup'?(itemLabels[effect.itemType]||'획득'):labels[kind],q.x-34,q.y-46);
      ctx.restore();continue;
    }
    ctx.globalAlpha=1-p*.75;
    if(kind==='dart'||kind==='pass') {
      const to=point(effect.x+(effect.dx||0)*(effect.length||0)*p,effect.y+(effect.dy||0)*(effect.length||0)*p);
      if(kind==='dart') {
        // The path is already visible; move one small dart along that exact segment.
        const angle=Math.atan2(-(effect.dy||0),effect.dx||0),c=Math.cos(angle),s=Math.sin(angle);
        const vertex=(x,y)=>({x:to.x+x*c-y*s,y:to.y+x*s+y*c});
        const a=vertex(8,0),b=vertex(-6,-5),d=vertex(-6,5);
        ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.lineTo(d.x,d.y);ctx.closePath();ctx.fillStyle='#f4bc55';ctx.fill();ctx.stroke();
      } else {
        ctx.strokeStyle=effect.interception?'#9f2655':ink;
        ctx.beginPath();for(let i=0;i<8;i++){const a=-Math.PI/2+i*Math.PI/4,r=i%2?4:10,x=to.x+Math.cos(a)*r,y=to.y+Math.sin(a)*r;i?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.closePath();ctx.fillStyle='#ffe482';ctx.fill();ctx.stroke();
      }
    } else if(kind==='break') {
      for(let i=0;i<6;i++) {const a=i*TAU/6+.35,r=6+p*18,x=q.x+Math.cos(a)*r,y=q.y+Math.sin(a)*r+p*p*8;ctx.fillStyle=i%2?'#ecc394':'#ae754c';ctx.beginPath();ctx.moveTo(x-3,y-3);ctx.lineTo(x+4,y-2);ctx.lineTo(x+2,y+4);ctx.closePath();ctx.fill();ctx.stroke();}
    } else if(kind==='explode') {
      ring(q.x,q.y,8+p*18);
      for(let i=0;i<6;i++){const a=i*TAU/6+.2,r=8+p*14;ring(q.x+Math.cos(a)*r,q.y+Math.sin(a)*r,2.5,'#efffff');}
    } else if(kind==='rescue'||kind==='spawn') {
      ring(q.x,q.y,18+p*11);ring(q.x,q.y,12+p*11);
      ctx.fillStyle=ink;ctx.font=`bold ${markerFont}px system-ui`;ctx.textAlign='center';ctx.fillText(labels[kind],q.x,q.y-32-p*5);
    } else if(kind==='pickup') {
      for(let i=0;i<4;i++){const a=i*TAU/4+Math.PI/4,r=16+p*10,x=q.x+Math.cos(a)*r,y=q.y+Math.sin(a)*r-p*10;ctx.beginPath();ctx.moveTo(x-3,y);ctx.lineTo(x+3,y);ctx.moveTo(x,y-3);ctx.lineTo(x,y+3);ctx.stroke();}
      ctx.fillStyle=ink;ctx.font=`bold ${markerFont}px system-ui`;ctx.textAlign='center';ctx.fillText(itemLabels[effect.itemType]||'획득',q.x,q.y-30-p*12);
    } else if(kind==='hit') {
      // Only a confirmed hit creates this local marker; no nearest-player heuristic.
      for(let i=0;i<4;i++){const a=i*TAU/4+Math.PI/4;ctx.beginPath();ctx.moveTo(q.x+Math.cos(a)*20,q.y+Math.sin(a)*20);ctx.lineTo(q.x+Math.cos(a)*27,q.y+Math.sin(a)*27);ctx.stroke();}
    } else if(kind==='death') {
      for(let i=0;i<3;i++)ring(q.x+(i-1)*11,q.y+10+p*14,3,'#d5e9ef');
    } else ring(q.x,q.y+14,20+Math.sin(p*Math.PI)*4);
    ctx.restore();
  }
}
