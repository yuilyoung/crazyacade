// Presentation only: cell coordinates are projected here once, never inferred from distance.
const TAU = Math.PI * 2;
const labels = {place:'설치',explode:'물결',break:'파괴',pickup:'획득',hit:'피격',rescue:'구출',death:'탈락',spawn:'복귀',dart:'다트',pass:'패스'};
const playerKinds = new Set(['pickup','hit','rescue','spawn','death']);
const itemLabels = {orb:'폭탄 +',wave:'물줄기 +',dash:'속도 +',speed:'속도 +',pin:'바늘 +',dart:'다트 +'};

/** The thin front shell leaves the face, skin and team marks visible through the water. */
export function drawWaterPrison(ctx, {time, capture, still, highContrast}) {
  const entry = !still && Number.isFinite(capture) ? Math.sin(capture * Math.PI * 2) * (1 - capture) : 0;
  const breath = still ? 0 : Math.sin(time / 350);
  const rx = 28 + entry * 3.5 + breath * .65;
  const ry = 28 - entry * 3 - breath * .55;
  const edge = highContrast ? '#073247' : '#126688';
  function rim(start, end, inset, color, width) {
    ctx.beginPath();
    ctx.ellipse(0, 0, rx - inset, ry - inset, 0, start, end);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.save();
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, TAU);
  ctx.fillStyle = highContrast ? '#c3f8ff22' : '#8ae5f844';
  ctx.fill();
  ctx.strokeStyle = edge;
  ctx.lineWidth = highContrast ? 3.5 : 2.4;
  ctx.stroke();
  rim(.14, 2.50, 2.4, highContrast ? '#16758e' : '#59bcd6', 3.5);
  rim(.48, 1.48, 2.9, '#ccf8ff', 1.8);
  rim(3.41, 4.31, 3.4, '#fff', 3.1);
  rim(4.47, 4.61, 3.4, '#fff', 2);
  // Air pearls rise along the sides and dissolve at each end of the path.
  for (const sign of [-1, 1]) {
    const progress = still ? .45 : (time / 1180 + (sign + 1) * .23) % 1;
    const radius = 2.6 * Math.sin(progress * Math.PI);
    ctx.beginPath();
    ctx.arc(sign * (18 + 2 * Math.sin(progress * Math.PI)), 14 - progress * 28, radius, 0, TAU);
    ctx.fillStyle = '#f2ffff';
    ctx.fill();
  }
  ctx.restore();
}

// A water drop with an extended tail. Coordinates are in the arena's frame.
function sprayDrop(ctx, x, y, dx, dy, length, width, color) {
  const nx = -dy * width, ny = dx * width;
  ctx.beginPath();
  ctx.moveTo(x - dx * length, y - dy * length);
  ctx.quadraticCurveTo(x + nx, y + ny, x + dx * width, y + dy * width);
  ctx.quadraticCurveTo(x - nx, y - ny, x - dx * length, y - dy * length);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.stroke();
}

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
      ctx.fillText(kind==='pickup'?(effect.itemLabel||itemLabels[effect.itemType]||'획득'):labels[kind],q.x-34,q.y-46);
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
      if(kind==='rescue') {
        // Two pieces of membrane peel open, then fall as separate drops.
        ctx.strokeStyle=highContrast?'#164f5d':'#3f9d9b';
        ctx.lineWidth=4*(1-p)+1;
        const radius=27+10*p, fall=9*p*p;
        for(const sign of [-1,1]) {
          const center=sign===1?0:Math.PI, halfArc=.95*(1-p);
          ctx.beginPath();
          ctx.arc(q.x+sign*5*p,q.y+fall,radius,center-halfArc,center+halfArc);
          ctx.stroke();
          const dy=-.8,dx=sign*.6;
          sprayDrop(ctx,q.x+dx*(radius+6),q.y+dy*(radius+7)+fall,dx,dy,4,2.2,'#d4fff9');
        }
      } else {ring(q.x,q.y,18+p*11);ring(q.x,q.y,12+p*11);}
      ctx.fillStyle=ink;ctx.font=`bold ${markerFont}px system-ui`;ctx.textAlign='center';ctx.fillText(labels[kind],q.x,q.y-32-p*5);
    } else if(kind==='pickup') {
      for(let i=0;i<4;i++){const a=i*TAU/4+Math.PI/4,r=16+p*10,x=q.x+Math.cos(a)*r,y=q.y+Math.sin(a)*r-p*10;ctx.beginPath();ctx.moveTo(x-3,y);ctx.lineTo(x+3,y);ctx.moveTo(x,y-3);ctx.lineTo(x,y+3);ctx.stroke();}
      ctx.fillStyle=ink;ctx.font=`bold ${markerFont}px system-ui`;ctx.textAlign='center';ctx.fillText(effect.itemLabel||itemLabels[effect.itemType]||'획득',q.x,q.y-30-p*12);
    } else if(kind==='hit') {
      // A readable water crown on first contact, not a body- or camera-position kick.
      const spread=1-(1-p)*(1-p);
      ctx.strokeStyle=highContrast?'#073247':'#267f9e';
      ctx.lineWidth=highContrast?2.5:1.5;
      for(let i=0;i<5;i++) {
        const angle=-Math.PI*.94+i*Math.PI*.47,dx=Math.cos(angle),dy=Math.sin(angle);
        const reach=34+spread*(i%2?10:7);
        sprayDrop(ctx,q.x+dx*reach,q.y+dy*reach+5*p*p,dx,dy,7*(1-p)+2,4.5-2*p,'#dcfaff');
      }
    } else if(kind==='death') {
      for(let i=0;i<3;i++)ring(q.x+(i-1)*11,q.y+10+p*14,3,'#d5e9ef');
    } else ring(q.x,q.y+14,20+Math.sin(p*Math.PI)*4);
    ctx.restore();
  }
}
