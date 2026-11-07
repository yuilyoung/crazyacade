import test from 'node:test';
import assert from 'node:assert/strict';
import * as rendererModule from '../public/arena-renderer.js';
import { createArenaRenderer } from '../public/arena-renderer.js';

// Record actual Canvas calls in world coordinates; no renderer/timeline stubs.
function surface() {
  const calls=[], stack=[]; let tx=0,ty=0,path=[];
  const ctx={globalAlpha:1,fillStyle:'',strokeStyle:'',font:'',lineWidth:1,
    save(){stack.push({tx,ty,globalAlpha:this.globalAlpha,fillStyle:this.fillStyle,strokeStyle:this.strokeStyle,font:this.font});},
    restore(){Object.assign(this,stack.pop());tx=this.tx??tx;ty=this.ty??ty;},
    translate(x,y){tx+=x;ty+=y;}, rotate(){},scale(){},setLineDash(){},clearRect(){},clip(){},
    beginPath(){path=[];},closePath(){},
    moveTo(x,y){path.push(['moveTo',x+tx,y+ty]);},lineTo(x,y){path.push(['lineTo',x+tx,y+ty]);},
    quadraticCurveTo(...args){path.push(['curve',...args]);},
    roundRect(x,y,w,h,r){path.push(['roundRect',x+tx,y+ty,w,h,r]);},
    arc(x,y,r){path.push(['arc',x+tx,y+ty,r]);},ellipse(x,y,rx,ry){path.push(['ellipse',x+tx,y+ty,rx,ry]);},
    fill(){calls.push({op:'fill',path:structuredClone(path),style:this.fillStyle,alpha:this.globalAlpha});},
    stroke(){calls.push({op:'stroke',path:structuredClone(path),style:this.strokeStyle,alpha:this.globalAlpha});},
    fillRect(x,y,w,h){calls.push({op:'rect',x:x+tx,y:y+ty,w,h,style:this.fillStyle});},
    strokeRect(){},drawImage(){},measureText(s){return {width:s.length*8};},
    fillText(text,x,y){calls.push({op:'text',text,x:x+tx,y:y+ty,style:this.fillStyle,alpha:this.globalAlpha,font:this.font});},
    createRadialGradient(){return {addColorStop(){}};}
  };
  const canvas={dataset:{},getContext:()=>ctx,getBoundingClientRect:()=>({width:780})};
  return {canvas,calls,ctx};
}
function fixture(options={}) {
  const s=surface(), visibility=new EventTarget(); visibility.hidden=false;
  const renderer=createArenaRenderer({canvas:s.canvas,display:{renderTransform(){}},imageFactory:()=>({}),visibilitySource:visibility});
  const player={id:'p',name:'P',x:1,y:1,alive:true,bubbleTicks:0,facing:'right',team:'blue',itemsCollected:0,speedLevel:0,moveCooldownTicks:2};
  const snapshot={tick:1,phase:'playing',mapId:'garden',mode:'team',players:[player],solid:[],soft:[],orbs:[],waves:[],items:[],dartEffects:[]};
  const view={snapshot,playerId:'p',connection:'connected',selection:{mapId:'garden',mode:'team'},settings:{effects:'full',highContrast:false},...options};
  return {...s,visibility,renderer,view,player};
}
function advance(f,changes,now=100) {
  f.view={...f.view,snapshot:{...f.view.snapshot,tick:f.view.snapshot.tick+1,...changes}};
  f.calls.length=0; return f.renderer.draw(now,f.view);
}

test('renderer consumes intermediate timeline pose and draws the avatar at that cell',()=>{
  const f=fixture();f.renderer.draw(0,f.view);
  advance(f,{players:[{...f.player,x:2}]},100);
  f.calls.length=0;const frame=f.renderer.draw(200,f.view);
  assert.equal(frame.players.get('p').x,1.5);
  assert.ok(f.calls.some(c=>c.path?.some(p=>p[0]==='ellipse'&&p[1]===120&&p[3]===22)),'shadow follows interpolated x=120');
  assert.equal(f.view.snapshot.players[0].x,2,'server cell stays authoritative');
});

test('every confirmed wave cell draws immediately while its local foam evolves',()=>{
  const f=fixture();f.renderer.draw(0,f.view);
  const waves=[{x:2,y:2,ttl:4},{x:3,y:2,ttl:4},{x:4,y:2,ttl:4}];
  const frame=advance(f,{waves},100);
  for(const x of [121,181,241]) assert.ok(f.calls.some(c=>c.path?.some(p=>p[0]==='roundRect'&&p[1]===x&&p[2]===483&&p[3]===58&&p[4]===54)));
  assert.equal(frame.waves.size,3);
  const first=structuredClone(f.calls);f.calls.length=0;f.renderer.draw(160,f.view);
  assert.notDeepEqual(f.calls,first,'foam is animated on already visible danger');
});

test('death afterimage is translucent and has no live name, team or self indicators',()=>{
  const f=fixture();f.renderer.draw(0,f.view);
  const frame=advance(f,{players:[{...f.player,alive:false}]},100);
  assert.equal(frame.players.get('p').death,0);
  assert.ok(f.calls.some(c=>c.op==='fill'&&c.alpha>0&&c.alpha<=.6),'afterimage body drawn');
  assert.ok(!f.calls.some(c=>c.op==='text'&&['나','B','P · 나'].includes(c.text)));
});

test('calm and reduced motion use immediate cells and static events; minimal omits decoration',()=>{
  for(const settings of [{effects:'calm'},{effects:'full',reduced:true},{effects:'minimal'}]){
    const f=fixture();f.view.settings={...f.view.settings,effects:settings.effects};f.view.reducedMotion=Boolean(settings.reduced);
    f.renderer.draw(0,f.view);const frame=advance(f,{players:[{...f.player,x:2,bubbleTicks:20}]},100);
    assert.equal(frame.players.get('p').x,2);
    const first=structuredClone(f.calls);f.calls.length=0;f.renderer.draw(130,f.view);
    assert.deepEqual(f.calls,first,'non-full canvas remains static for an unchanged snapshot');
    assert.ok(f.calls.some(c=>c.op==='text'&&c.text==='나'),'essential self marker retained');
    assert.ok(f.calls.some(c=>c.op==='text'&&c.text==='2'),'bubble countdown retained');
    if(settings.effects==='minimal')assert.equal(frame.effects.length,0);
  }
});

test('visibility event resets interpolation even when no hidden frame ran; dispose removes listener',()=>{
  const f=fixture();f.renderer.draw(0,f.view);advance(f,{players:[{...f.player,x:2}]},100);
  f.visibility.hidden=true;f.visibility.dispatchEvent(new Event('visibilitychange'));
  f.visibility.hidden=false;f.visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.renderer.draw(140,f.view).players.get('p').x,2);
  advance(f,{players:[{...f.player,x:3}]},180);f.renderer.dispose();
  f.visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.renderer.draw(280,f.view).players.get('p').x,2.5,'disposed visibility listener no longer changes timeline');
});

test('explicit reset prevents stale interpolation and events after a connection transition',()=>{
  const f=fixture();f.renderer.draw(0,f.view);advance(f,{players:[{...f.player,x:2,bubbleTicks:10}]},100);
  f.renderer.reset();const frame=f.renderer.draw(140,f.view);
  assert.equal(frame.players.get('p').x,2);assert.deepEqual(frame.effects,[]);
});

test('arena effects project cells once, keep projectile travel on its confirmed path, and cap decoration',async()=>{
  const {drawArenaEffects}=await import('../public/arena-effects.js');const s=surface();
  const point=(x,y)=>({x:x*60+30,y:(10-y)*60+30});
  const projectile={id:'d',kind:'dart',x:1,y:2,dx:1,dy:0,length:3,ageMs:100,durationMs:200,progress:.5};
  drawArenaEffects(s.ctx,[projectile],{point,highContrast:false,level:'full',markerFont:10});
  assert.ok(s.calls.some(c=>c.path?.some(p=>p[0]==='moveTo'&&p[1]===188&&p[2]===510)),'dart nose at halfway cell x=180 plus 8px');
  for(const kind of ['place','explode','break','pickup','hit','rescue','death','spawn','pass']) {
    s.calls.length=0;drawArenaEffects(s.ctx,[{...projectile,kind}],{point,level:'full',markerFont:10});
    assert.ok(s.calls.length>0,`${kind} visibly renders`);assert.ok(s.calls.length<=16,`${kind} uses at most 8 filled+stroked shapes`);
  }
});

test('calm event markers stay fixed, minimal has none, unknown pickup does not invent a type',async()=>{
  const {drawArenaEffects}=await import('../public/arena-effects.js');const s=surface();const point=(x,y)=>({x:x*60+30,y:(10-y)*60+30});
  const effect={id:'p',kind:'pickup',x:2,y:3,ageMs:0,durationMs:600,progress:0};
  drawArenaEffects(s.ctx,[effect],{point,level:'calm',markerFont:12});const first=structuredClone(s.calls);
  s.calls.length=0;drawArenaEffects(s.ctx,[{...effect,progress:.6,ageMs:360}],{point,level:'calm',markerFont:12});
  assert.deepEqual(s.calls,first);assert.ok(s.calls.some(c=>c.op==='text'&&c.text==='획득'));
  s.calls.length=0;drawArenaEffects(s.ctx,[effect],{point,level:'minimal',markerFont:12});assert.deepEqual(s.calls,[]);
});

test('minimal high contrast preserves danger tiles, confirmed dart and pass paths, bubble and team state',()=>{
  const f=fixture();f.view.settings={effects:'minimal',highContrast:true};
  f.view.snapshot={...f.view.snapshot,players:[{...f.player,bubbleTicks:10}],waves:[{x:4,y:4,ttl:3}],dartEffects:[{x:1,y:1,dx:1,dy:0,length:3,ttl:3}],relay:{bases:{},carrierId:null,star:null,passEffects:[{x:2,y:2,dx:0,dy:1,length:2,ttl:3}]}};
  f.renderer.draw(0,f.view);
  assert.ok(f.calls.some(c=>c.style==='#8eddf8'&&c.path?.some(p=>p[0]==='roundRect'&&p[1]===241&&p[2]===363)));
  assert.ok(f.calls.some(c=>c.path?.some(p=>p[0]==='lineTo'&&p[1]===270&&p[2]===570)),'complete dart path visible immediately');
  assert.ok(f.calls.some(c=>c.path?.some(p=>p[0]==='lineTo'&&p[1]===150&&p[2]===390)),'complete pass path visible immediately');
  assert.ok(f.calls.some(c=>c.op==='text'&&c.text==='나'));assert.ok(f.calls.some(c=>c.op==='text'&&c.text==='1'));
});

test('timeline events feed actual arena pickup, rescue, destruction and projectile drawing without mutating snapshots',()=>{
  const f=fixture();f.view.snapshot={...f.view.snapshot,players:[{...f.player,bubbleTicks:10}],soft:['3,3'],orbs:[{x:3,y:3,fuse:2}],items:[{x:1,y:1,type:'dart'}]};
  f.renderer.draw(0,f.view);
  const frame=advance(f,{players:[{...f.player,itemsCollected:1,darts:1}],soft:[],orbs:[],items:[],waves:[{x:3,y:3,ttl:3}],dartEffects:[{x:1,y:1,dx:1,dy:0,length:2,ttl:3}],relay:{bases:{},passEffects:[{x:1,y:1,dx:0,dy:1,length:2,ttl:3}]}});
  const original=structuredClone(f.view.snapshot);
  assert.deepEqual(new Set(frame.effects.map(e=>e.kind)),new Set(['rescue','pickup','break','explode','dart','pass']));
  assert.ok(f.calls.some(c=>c.op==='text'&&c.text==='구출'));assert.ok(f.calls.some(c=>c.op==='text'&&c.text==='다트 +'));
  f.calls.length=0;f.renderer.draw(180,f.view);assert.deepEqual(f.view.snapshot,original);
  assert.ok(f.calls.some(c=>c.style==='#ae754c'),'local crate debris drawn');
});

test('calm death uses a fixed event marker without a dead avatar silhouette',()=>{
  const f=fixture();f.view.settings.effects='calm';f.renderer.draw(0,f.view);
  advance(f,{players:[{...f.player,alive:false}]},100);
  assert.ok(f.calls.some(c=>c.op==='text'&&c.text==='탈락'));
  assert.ok(!f.calls.some(c=>c.path?.some(p=>p[0]==='ellipse')),'calm death has no avatar body');
});

test('blocked pin hits use an accurate generic label without claiming imprisonment',()=>{
  const f=fixture();f.view.settings.effects='calm';
  f.view.snapshot={...f.view.snapshot,players:[{...f.player,pin:true}]};f.renderer.draw(0,f.view);
  const frame=advance(f,{players:[{...f.player,pin:false}]},100);
  assert.equal(frame.players.get('p').bubble,false);
  assert.ok(f.calls.some(c=>c.op==='text'&&c.text==='피격'));
  assert.ok(!f.calls.some(c=>c.op==='text'&&c.text==='감금'));
});

for(const width of [780,390]) for(const reduced of [false,true]) {
  test(`static event decoration stays behind essential overlays with a visible cue at ${width}px, reduced=${reduced}`,()=>{
    const f=fixture();f.canvas.getBoundingClientRect=()=>({width});
    f.view.settings.effects=reduced?'full':'calm';f.view.reducedMotion=reduced;
    f.renderer.draw(0,f.view);advance(f,{players:[{...f.player,bubbleTicks:20}]},100);
    const markerIndex=f.calls.findIndex(c=>c.op==='fill'&&c.style==='#fff'&&c.path?.some(p=>p[0]==='arc'&&p[3]===7));
    assert.ok(markerIndex>=0,'event circle still renders');
    const eventLabelIndex=f.calls.findIndex(c=>c.op==='text'&&['피격','감금'].includes(c.text));
    assert.ok(eventLabelIndex>=0,'event label still renders');
    const countdownIndex=f.calls.findIndex(c=>c.op==='text'&&c.text==='2');
    const teamSelfIndex=f.calls.findIndex(c=>c.op==='text'&&c.text==='나');
    const selfRingIndex=f.calls.findIndex(c=>c.op==='stroke'&&c.path?.some(p=>p[0]==='arc'&&p[3]===26));
    assert.ok(countdownIndex>markerIndex&&countdownIndex>eventLabelIndex,'countdown composites over decoration');
    assert.ok(teamSelfIndex>markerIndex&&teamSelfIndex>eventLabelIndex,'team/self composites over decoration');
    assert.ok(selfRingIndex>markerIndex,'self ring composites over decoration');
    const marker=f.calls[markerIndex].path.find(p=>p[0]==='arc');
    assert.ok(marker[1]+marker[3]<90-22,'static cue remains left of the avatar head instead of hidden behind it');
    assert.equal(f.canvas.dataset.essentialMarkerCssPx,'10.00');
  });
}

for(const settings of [{effects:'full',x:102},{effects:'calm',x:116},{effects:'full',reduced:true,x:116},{effects:'minimal',x:null}]) {
  test(`pickup label follows its moving recipient, not a nearby player: ${JSON.stringify(settings)}`,()=>{
    const f=fixture(),other={...f.player,id:'other',name:'Other',x:1,y:2};
    f.view.settings.effects=settings.effects;f.view.reducedMotion=Boolean(settings.reduced);
    f.view.snapshot={...f.view.snapshot,players:[f.player,other],items:[{x:1,y:1,type:'dart'}]};
    f.renderer.draw(0,f.view);
    const collected={...f.player,itemsCollected:1,darts:1};
    const collectedFrame=advance(f,{players:[collected,other],items:[]},100);
    const originalEvent=structuredClone(collectedFrame.effects.find(e=>e.kind==='pickup'));
    advance(f,{players:[{...collected,x:2},{...other,y:1}]},200);
    const originalSnapshot=structuredClone(f.view.snapshot);f.calls.length=0;
    const frame=f.renderer.draw(240,f.view),label=f.calls.find(c=>c.op==='text'&&c.text==='다트 +');
    if(settings.x===null)assert.equal(label,undefined);
    else {
      assert.equal(label?.x,settings.x,'label follows recipient display point, not the original x=90 or other player');
      assert.equal(label.y,settings.effects==='full'&&!settings.reduced?537.2:524);
      assert.ok(f.calls.findIndex(c=>c.op==='text'&&c.text==='나')>f.calls.indexOf(label),'essential overlays still composite last');
      const event=frame.effects.find(e=>e.kind==='pickup');assert.equal(event.x,1);assert.equal(event.y,1);
      assert.equal(event.playerId,'p');assert.equal(event.itemType,'dart');
      assert.deepEqual(collectedFrame.effects.find(e=>e.kind==='pickup'),originalEvent,'old frame event stays immutable');
    }
    assert.deepEqual(f.view.snapshot,originalSnapshot);
  });
}

for(const level of ['full','calm','minimal']) {
  test(`all player cues use an injected display point and drop missing/dead recipients: ${level}`,async()=>{
    const {drawArenaEffects}=await import('../public/arena-effects.js');
    const point=(x,y)=>({x:x*60+30,y:(10-y)*60+30});
    const effects=['pickup','hit','rescue','spawn','death'].map(kind=>({id:kind,kind,x:1,y:1,playerId:'p',progress:0,itemType:'dart'}));
    for(const effect of effects) {
      const s=surface(),original=structuredClone(effect);
      drawArenaEffects(s.ctx,[effect],{point,level,playerPoint:()=>({x:410,y:320,alive:true})});
      if(level==='minimal')assert.deepEqual(s.calls,[]);
      else if(level==='calm')assert.ok(s.calls.some(c=>c.path?.some(p=>p[0]==='arc'&&p[1]===376&&p[2]===286)));
      else if(effect.kind==='pickup')assert.ok(s.calls.some(c=>c.op==='text'&&c.text==='다트 +'&&c.x===410&&c.y===290));
      else if(['rescue','spawn'].includes(effect.kind))assert.ok(s.calls.some(c=>c.path?.some(p=>p[0]==='arc'&&p[1]===410&&p[2]===320)));
      else if(effect.kind==='death')assert.ok(s.calls.some(c=>c.path?.some(p=>p[0]==='arc'&&p[1]===399&&p[2]===330)));
      else assert.ok(s.calls.some(c=>c.path?.some(p=>p[0]==='moveTo'&&Math.abs(p[1]-424.14213562373095)<.00001&&Math.abs(p[2]-334.14213562373095)<.00001)));
      assert.deepEqual(effect,original);
      s.calls.length=0;drawArenaEffects(s.ctx,[effect],{point,level,playerPoint:()=>null});assert.deepEqual(s.calls,[],'removed recipients never keep cues');
      s.calls.length=0;drawArenaEffects(s.ctx,[effect],{point,level,playerPoint:()=>({x:410,y:320,alive:false})});
      if(effect.kind==='death'&&level!=='minimal')assert.ok(s.calls.length>0,'death cue remains valid for dead recipient');
      else assert.deepEqual(s.calls,[],'dead players have no stale alive cues');
    }
  });
}

test('origin effects and authoritative projectiles ignore player display lookup and standalone calls stay compatible',async()=>{
  const {drawArenaEffects}=await import('../public/arena-effects.js');
  const point=(x,y)=>({x:x*60+30,y:(10-y)*60+30});
  for(const level of ['full','calm','minimal'])for(const kind of ['place','explode','break','dart','pass']) {
    const a=surface(),b=surface(),effect={id:kind,kind,playerId:'p',x:1,y:2,dx:1,dy:0,length:3,progress:.5};
    drawArenaEffects(a.ctx,[effect],{point,level});
    drawArenaEffects(b.ctx,[effect],{point,level,playerPoint:()=>null});
    assert.deepEqual(b.calls,a.calls,`${kind} remains at its world origin or authoritative path in ${level}`);
    if(level==='full'&&kind==='dart')assert.ok(b.calls.some(c=>c.path?.some(p=>p[0]==='moveTo'&&p[1]===188&&p[2]===510)));
  }
  const s=surface();drawArenaEffects(s.ctx,[{id:'pickup',kind:'pickup',playerId:'p',x:1,y:1,progress:0}],{point,level:'full'});
  assert.ok(s.calls.some(c=>c.op==='text'&&c.text==='획득'&&c.x===90&&c.y===540),'standalone player event keeps its original location without lookup');
});

test('renderer suppresses lingering pickup and rescue after death while retaining valid death cue',()=>{
  const f=fixture();f.view.settings.effects='calm';f.view.snapshot={...f.view.snapshot,players:[{...f.player,bubbleTicks:10}]};f.renderer.draw(0,f.view);
  const collected={...f.player,itemsCollected:1};advance(f,{players:[collected]},100);
  assert.ok(f.calls.some(c=>c.op==='text'&&c.text==='구출'));assert.ok(f.calls.some(c=>c.op==='text'&&c.text==='획득'));
  advance(f,{players:[{...collected,alive:false}]},200);
  assert.ok(!f.calls.some(c=>c.op==='text'&&['획득','구출'].includes(c.text)));
  assert.ok(f.calls.some(c=>c.op==='text'&&c.text==='탈락'));
  advance(f,{players:[]},250);assert.ok(!f.calls.some(c=>c.op==='text'&&['획득','구출','탈락'].includes(c.text)));
});

test('renderer draws every large tile and far-edge actor from server geometry over lobby mode',()=>{
 const f=fixture();const cleared=[];f.ctx.clearRect=(...args)=>cleared.push(args);
 f.view.selection={mapId:'garden',mode:'invalid-lobby-mode'};
 f.view.snapshot={...f.view.snapshot,arena:{width:15,height:13},players:[{...f.player,x:13,y:11}],waves:[{x:13,y:11,ttl:3}]};
 f.renderer.draw(0,f.view);
 const floors=f.calls.filter(c=>c.op==='rect'&&c.w===60&&c.h===60);
 assert.equal(floors.length,195);assert.deepEqual(cleared.at(-1),[0,0,900,780]);
 for(const [x,y] of [[0,0],[840,0],[0,720],[840,720]])assert.ok(floors.some(c=>c.x===x&&c.y===y));
 assert.ok(f.calls.some(c=>c.path?.some(p=>p[0]==='ellipse'&&p[1]===810&&p[2]===110)),'far-edge player uses y inversion from 13 rows');
 assert.ok(f.calls.some(c=>c.path?.some(p=>p[0]==='roundRect'&&p[1]===781&&p[2]===63&&p[3]===58)));
 f.view.snapshot={...f.view.snapshot,arena:{width:13,height:11},players:[],waves:[]};f.calls.length=0;f.renderer.draw(100,f.view);
 assert.equal(f.calls.filter(c=>c.op==='rect'&&c.w===60&&c.h===60).length,143);assert.deepEqual(cleared.at(-1),[0,0,780,660]);
});
test('lobby uses team geometry while training and missing snapshot geometry stay legacy',()=>{
 const f=fixture();f.view.snapshot=null;f.renderer.draw(0,f.view);
 assert.equal(f.calls.filter(c=>c.op==='rect'&&c.w===60&&c.h===60).length,195);
 f.view.selection.training=true;f.calls.length=0;f.renderer.draw(100,f.view);
 assert.equal(f.calls.filter(c=>c.op==='rect'&&c.w===60&&c.h===60).length,143);
 f.view.snapshot={tick:1,phase:'playing',mode:'team',mapId:'garden',solid:[],soft:[],players:[]};f.calls.length=0;f.renderer.draw(200,f.view);
 assert.equal(f.calls.filter(c=>c.op==='rect'&&c.w===60&&c.h===60).length,143);
});
test('large mobile essential markers remain at least ten CSS pixels',()=>{
 const f=fixture();f.canvas.getBoundingClientRect=()=>({width:300});f.view.snapshot={...f.view.snapshot,arena:{width:15,height:13}};f.renderer.draw(0,f.view);
 assert.ok(Number(f.canvas.dataset.essentialMarkerCssPx)>=10);assert.ok(Number(f.canvas.dataset.teamMarkerCssPx)>=10);
 const self=f.calls.find(c=>c.op==='text'&&c.text==='나');assert.ok(Number(self.font.match(/([\d.]+)px/)[1])*300/900>=10,'actual self font uses the large logical width');
});

test('map miniatures redraw selected mode and training dimensions with complete inverted edges',()=>{
 assert.equal(typeof rendererModule.drawMapMiniature,'function');
 const s=surface();s.canvas.style={};
 for(const [mode,training,width,height] of [['team',false,15,13],['duel',false,13,11],['team',true,13,11]]) {
  s.calls.length=0;rendererModule.drawMapMiniature(s.canvas,{mapId:'garden',mode,training});
  assert.equal(s.canvas.width,width*10);assert.equal(s.canvas.height,height*10);assert.equal(s.canvas.style.aspectRatio,`${width} / ${height}`);
  const tiles=s.calls.filter(c=>c.op==='rect');assert.equal(tiles.length,width*height);
  for(const [x,y] of [[0,0],[(width-1)*10,0],[0,(height-1)*10],[(width-1)*10,(height-1)*10]])assert.ok(tiles.some(c=>c.x===x&&c.y===y&&c.style==='#477587'));
 }
});
