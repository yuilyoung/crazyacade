"""Measure real keyboard input to WebSocket, authoritative state and Canvas motion.

Run from the repository root:
  python scripts/input-latency-smoke.py --output /tmp/crazyacade-input/baseline.json
  python scripts/input-latency-smoke.py --assert-latency --network-delay-ms 40

Uses an isolated server and two real guest browser sessions, without bots. Every
movement is a Playwright keyboard event. The browser probes only observe trusted
keyboard events, unchanged WebSocket messages, and the own-player yellow
Canvas marker. No game state, clocks, inputs or application modules are injected.
Canvas submission is measured; browser compositor/display scanout is not.
The optional WebSocket proxy adds the stated delay to EACH direction, preserves
message order and payloads, and does not claim to reproduce a real WAN.
The gate also checks the 95th percentile of moving-frame intervals during holds.
Use --jitter-corridor for a separate 1:1 long-corridor diagnostic with bursty
snapshot delivery, reversals and mid-stride releases. It reports tile displacement,
backward movement and visible stalls separately from delayed browser frames.
"""
import argparse
import asyncio
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import shutil
import time
import traceback

from playwright.async_api import async_playwright


HELPERS = Path(__file__).with_name('game-shell-smoke.py')
SPEC = importlib.util.spec_from_file_location('game_shell_smoke', HELPERS)
shell = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(shell)
HELD_FRAME_GAP_P95_LIMIT_MS = 50
# At a 100 ms server tick, the 216/120/24 sequence delivers three ordered
# snapshots within ~8 ms after a period with no new authoritative information.
JITTER_STATE_DELAYS_MS = (24, 216, 120, 24, 55, 24, 70, 24)
JITTER_OUTBOUND_MS = 30
JITTER_START_OFFSETS_MS = {0: 35, 5: 80}

PROBE = r"""(() => {
  const directions = {ArrowRight:'right',ArrowLeft:'left',ArrowUp:'up',ArrowDown:'down',
    KeyD:'right',KeyA:'left',KeyW:'up',KeyS:'down'};
  const delta = {right:[1,0],left:[-1,0],up:[0,-1],down:[0,1]};
  const probe = window.__inputLatency = {events:[],sends:[],states:[],markers:[],playerId:null,state:null,marker:null};
  const me = () => probe.state?.players?.find(p=>p.id===probe.playerId);
  const copy = p => p ? {x:p.x,y:p.y,alive:p.alive,bubbleTicks:p.bubbleTicks} : null;
  addEventListener('keydown', e => {
    if(!directions[e.code] || e.repeat) return;
    probe.events.push({index:probe.events.length,key:e.code,action:directions[e.code],category:probe.nextCategory,trusted:e.isTrusted,
      keydownAt:performance.now(),eventTimeStamp:e.timeStamp,from:copy(me()),baseline:probe.marker ? {...probe.marker}:null});
  },true);
  const NativeWebSocket = window.WebSocket;
  const nativeSend = NativeWebSocket.prototype.send;
  NativeWebSocket.prototype.send = function(data) {
    const at=performance.now();
    let message; try {message=JSON.parse(data);}catch{}
    if(message?.type==='input') {
      probe.sends.push({at,...message});
      if(message.phase===undefined){
        const event=probe.events.findLast(e=>e.action===message.action && e.sentAt===undefined);
        if(event)event.sentAt=at;
      }
    }
    return nativeSend.call(this,data);
  };
  window.WebSocket = new Proxy(NativeWebSocket,{construct(target,args){
    const socket=new target(...args);
    socket.addEventListener('message', e=>{
      let message;try{message=JSON.parse(e.data);}catch{return;}
      if(message.type==='joined')probe.playerId=message.playerId;
      if(message.type!=='state')return;
      const at=performance.now(),previousOwn=copy(me());probe.state=message;
      const own=copy(me());probe.states.push({at,tick:message.tick,player:own});
      if(!own)return;
      for(const event of probe.events){
        if(event.stateAt!==undefined || !previousOwn || at<event.keydownAt)continue;
        const [dx,dy]=delta[event.action];
        if((own.x-previousOwn.x)*dx-(own.y-previousOwn.y)*dy>0){event.stateAt=at;event.to=own;}
      }
    });return socket;
  }});
  const nativeFill=CanvasRenderingContext2D.prototype.fill;
  CanvasRenderingContext2D.prototype.fill=function(...args){
    const result=nativeFill.apply(this,args);
    // This color belongs to the own-player triangle; its ring is stroked.
    if(this.canvas.id!=='arena' || this.fillStyle!=='#ffe581')return result;
    const at=performance.now(), t=this.getTransform(), rect=this.canvas.getBoundingClientRect();
    const current={at,x:t.e*rect.width/this.canvas.width,y:t.f*rect.height/this.canvas.height,
      bufferX:t.e,bufferY:t.f,markerPixelX:t.e-33*t.c,markerPixelY:t.f-33*t.d};
    const previous=probe.marker;probe.marker=current;probe.markers.push(current);
    for(const event of probe.events){
      if(event.visibleAt!==undefined || !event.baseline || !previous || at<event.keydownAt)continue;
      const [dx,dy]=delta[event.action];
      if((current.x-previous.x)*dx+(current.y-previous.y)*dy>=0.5){
        event.visibleAt=at;event.firstVisible=current;
      }
    }
    return result;
  };
  addEventListener('keyup', e=>{
    const event=probe.events.findLast(event=>event.key===e.code && event.keyupAt===undefined);
    if(event)event.keyupAt=performance.now();
  },true);
})()"""


def summary(values):
    values = sorted(values)
    if not values:
        return {'count': 0, 'p50': None, 'p95': None, 'max': None}
    return {**{'count': len(values)}, **{
        key: round(values[max(0, math.ceil(len(values) * percentile) - 1)], 3)
        for key, percentile in [('p50', .5), ('p95', .95), ('max', 1)]}}


def source_fingerprints():
    sources = ['Server/public/index.html', 'Server/public/shell.css', 'Server/public/app.js',
               'Server/public/arena-renderer.js', 'Server/public/arena-effects.js', 'Server/public/visuals.js',
               'Server/public/water-blast.js', 'Server/public/motion-timeline.js',
               'Server/public/input-controller.js', 'Server/public/arena-viewmodel.js', 'Server/public/local-movement.js',
               'Server/src/index.js', 'Server/src/match-engine.js']
    return {name: hashlib.sha256((shell.ROOT / name).read_bytes()).hexdigest()
            for name in sources if (shell.ROOT / name).exists()}


async def install_delay(page, milliseconds, tasks, jitter=False):
    """Apply ordered network delay to the existing WebSocket messages."""
    async def route(client):
        remote = client.connect_to_server()

        def delayed(destination, inbound=False):
            # Chaining independently scheduled tasks would reorder packets.
            # A FIFO worker retains order without accumulating per-packet delay.
            queue = asyncio.Queue()

            async def forward():
                while True:
                    due, message = await queue.get()
                    await asyncio.sleep(max(0, due - time.monotonic()))
                    try:
                        destination.send(message)
                    except Exception:
                        return

            task = asyncio.create_task(forward())
            tasks.add(task)
            def enqueue(message):
                delay = milliseconds
                if inbound and jitter:
                    payload = json.loads(message)
                    if payload.get('type') == 'state':
                        delay = JITTER_STATE_DELAYS_MS[payload['tick'] % len(JITTER_STATE_DELAYS_MS)]
                queue.put_nowait((time.monotonic() + delay / 1000, message))
            return enqueue

        client.on_message(delayed(remote))
        remote.on_message(delayed(client, inbound=True))

    await page.route_web_socket('**/*', route)


async def browser_wait(page, expression, timeout=4000):
    await page.wait_for_function(expression, polling=10, timeout=timeout)


async def settled(page):
    # Wait until the rendered marker reaches the last AUTHORITATIVE coordinate.
    # This observes position rather than completing animations through a clock edit.
    condition = """() => {
      const p=window.__inputLatency,m=p?.state?.players.find(x=>x.id===p.playerId),r=p?.marker;
      if(!m || !r)return false;
      const c=document.querySelector('#arena'),b=c.getBoundingClientRect(),a=p.state.arena;
      const x=(m.x+.5)*b.width/a.width,y=(a.height-.5-m.y)*b.height/a.height;
      return Math.hypot(x-r.x,y-r.y)<.05;
    }"""
    await browser_wait(page, condition)
    # Let any already-transmitted held input drain before taking the next sample.
    await page.wait_for_timeout(220)
    await browser_wait(page, condition)


async def sample_press(page, key, category, hold_until=None):
    index = await page.evaluate('window.__inputLatency.events.length')
    await page.evaluate('(category)=>{window.__inputLatency.nextCategory=category}', category)
    if hold_until:
        await page.keyboard.down(key)
        await browser_wait(page, f'() => {{const p=window.__inputLatency,m=p.state.players.find(x=>x.id===p.playerId);return {hold_until};}}')
    else:
        await page.keyboard.press(key)
    await browser_wait(page, f'() => {{const e=window.__inputLatency.events[{index}];return e.stateAt!==undefined && e.visibleAt!==undefined;}}')
    return index


async def exercise_corridor(page, phase):
    # Anchor the first input to an observed tick of the delay schedule; wall
    # clock alignment by waiting after navigation leaves reversals incomparable.
    offset = JITTER_START_OFFSETS_MS[phase]
    await browser_wait(page, f"""() => {{
      const state = window.__inputLatency.states.at(-1);
      return state?.tick % {len(JITTER_STATE_DELAYS_MS)} === {phase} && performance.now() - state.at >= {offset};
    }}""")
    # The Festival map has a completely open row from (1,1) to (11,1).
    # Reverse at x=2/9 as reported by the server, away from the wall.
    previous = None
    for _ in range(5):
        for key, condition in [('ArrowRight', 'm.x>=9'), ('ArrowLeft', 'm.x<=2')]:
            await sample_press(page, key, 'held-turn' if previous else 'held-walk', condition)
            if previous:
                await page.keyboard.up(previous)
            previous = key
    await page.keyboard.up(previous)
    await settled(page)
    # Release mid-stride, leaving the already-transmitted repeats in flight.
    for _ in range(4):
        for key in ['ArrowRight', 'ArrowLeft']:
            await page.evaluate("window.__inputLatency.nextCategory = 'early-release'")
            await page.keyboard.down(key)
            await page.wait_for_timeout(285)
            await page.keyboard.up(key)
            await settled(page)


async def profile(browser, base, args, delay_ms, jitter=False):
    name = 'festival-corridor-jitter' if jitter else ('local' if not delay_ms else f'websocket-{delay_ms:g}ms-each-way')
    source_hashes = source_fingerprints()
    contexts, tasks = [], set()
    try:
        room = f'input-latency-{time.time_ns()}'
        pages = []
        observations = []
        for index in range(2):
            context = await browser.new_context(viewport={'width': 1280, 'height': 720}, device_scale_factor=1)
            contexts.append(context)
            page = await context.new_page()
            page.set_default_timeout(8000)
            pages.append(page)
            observed = shell.PublicState(page)
            observations.append(observed)
            if delay_ms and (not jitter or index == 0):
                # Playwright installs its routed WebSocket implementation as an
                # init script. Install it FIRST so the passive probe observes
                # the app-facing socket, including the delayed inbound leg.
                await install_delay(page, delay_ms, tasks, jitter=jitter)
            await page.add_init_script(PROBE)
            await page.goto(base, wait_until='domcontentloaded')
            await shell.open_lobby(page)
            await page.locator('#quick-friends').click()
            await shell.screen(page, 'maps')
            await page.locator('#mode').select_option('duel')
            if jitter:
                await page.locator('input[name=mapId][value=festival]').check()
            await page.locator('#room-id').fill(room)
            await page.locator('#item-mode').uncheck()
            await page.locator('#join-button').click()
            if index == 0:
                await shell.screen(page, 'waiting')
        for page, observed in zip(pages, observations):
            await shell.until(lambda: observed.state.get('phase') == 'playing', 'two humans playing')
            await shell.screen(page, 'battle')
        page = pages[0]
        await page.bring_to_front()
        await page.locator('#arena').focus()
        await settled(page)
        marker = await page.evaluate("""() => {
          const p=window.__inputLatency,m=p.marker,c=document.querySelector('#arena'),ctx=c.getContext('2d');
          p.tileCss = c.getBoundingClientRect().width / p.state.arena.width;
          const rgba=[...ctx.getImageData(Math.round(m.markerPixelX),Math.round(m.markerPixelY),1,1).data];
          return {rgba,position:m,player:p.state.players.find(x=>x.id===p.playerId)};
        }""")
        assert marker['rgba'] == [255, 229, 129, 255], f'Own-player marker color mismatch: {marker}'
        assert [marker['player']['x'], marker['player']['y']] == [1, 1], marker
        await page.screenshot(path=str(args.output.parent / f'{args.output.stem}-{name}-start.png'))
        async def finish():
            await page.screenshot(path=str(args.output.parent / f'{args.output.stem}-{name}-finish.png'))
            data = await page.evaluate('window.__inputLatency')
            errors = [error for item in observations for error in item.errors]
            assert not errors, errors
            result = analyze(name, delay_ms, data, args.threshold_ms, jitter=jitter)
            result['markerVerification'] = marker
            result['sourceSha256'] = source_hashes
            result['sourceChangedDuringMeasurement'] = source_hashes != source_fingerprints()
            return result

        if jitter:
            await exercise_corridor(page, args.jitter_start_phase)
            result = await finish()
            result['startingTickModulo'] = args.jitter_start_phase
            result['startingOffsetAfterReceiptMs'] = JITTER_START_OFFSETS_MS[args.jitter_start_phase]
            return result

        # 24 independent real presses through both clear branches of the spawn L.
        excursions = 0
        for _ in range(args.samples):
            own = await page.evaluate('window.__inputLatency.state.players.find(p=>p.id===window.__inputLatency.playerId)')
            # A real tap can straddle the 80 ms held-input timer and queue a
            # second movement. Choose a legal return from the actual authority
            # instead of assuming every previous tap moved exactly one tile.
            if own['x'] > 1:
                key = 'ArrowLeft'
            elif own['y'] > 1:
                key = 'ArrowDown'
            else:
                key = 'ArrowRight' if excursions % 2 == 0 else 'ArrowUp'
                excursions += 1
            await sample_press(page, key, 'tap')
            await settled(page)
            # Avoid phase-locking samples to the 100 ms simulation timer.
            await page.wait_for_timeout((len(await page.evaluate('window.__inputLatency.events')) * 37) % 91)
        for _ in range(6):
            own = await page.evaluate('window.__inputLatency.state.players.find(p=>p.id===window.__inputLatency.playerId)')
            if own['x'] == own['y'] == 1:
                break
            await sample_press(page, 'ArrowLeft' if own['x'] > 1 else 'ArrowDown', 'positioning')
            await settled(page)
        else:
            raise AssertionError('Could not return to the clear spawn corner through real key presses')
        # Hold the first direction for two tiles, then reverse while it is still
        # physically held. Most-recent direction must win without OS auto-repeat.
        for outgoing, incoming, reached, returned in [
            ('ArrowRight', 'ArrowLeft', 'm.x>=3', 'm.x<=1'),
            ('ArrowUp', 'ArrowDown', 'm.y>=3', 'm.y<=1'),
        ] * 2:
            await sample_press(page, outgoing, 'held-walk', reached)
            await sample_press(page, incoming, 'held-turn', returned)
            await page.keyboard.up(outgoing)
            await page.keyboard.up(incoming)
            await settled(page)
        # Trace the two open branches of the spawn L with six uninterrupted
        # right-angle turns. Turn at the authoritative corner even when the
        # rendered avatar is still approaching it. Exercise arrows and WASD.
        await sample_press(page, 'ArrowUp', 'held-walk', 'm.y>=3')
        await sample_press(page, 'ArrowDown', 'held-turn', 'm.y<=1')
        await page.keyboard.up('ArrowUp')
        previous = 'ArrowDown'
        for outward, homeward, outward_target, home_target in [
            ('KeyD', 'KeyA', 'm.x>=3', 'm.x<=1'),
            ('KeyW', 'KeyS', 'm.y>=3', 'm.y<=1'),
        ] * 3:
            await sample_press(page, outward, 'held-corner', outward_target)
            await page.keyboard.up(previous)
            await sample_press(page, homeward, 'held-turn', home_target)
            await page.keyboard.up(outward)
            previous = homeward
        await page.keyboard.up(previous)
        await settled(page)
        return await finish()
    except Exception as error:
        if pages:
            try:
                data = await pages[0].evaluate('window.__inputLatency')
                if data:
                    error.partial_measurement = analyze(name, delay_ms, data, args.threshold_ms, jitter=jitter)
                    error.partial_measurement['sourceSha256'] = source_hashes
                    error.partial_measurement['sourceChangedDuringMeasurement'] = source_hashes != source_fingerprints()
                await pages[0].screenshot(path=str(args.output.parent / f'{args.output.stem}-{name}-FAILURE.png'))
            except Exception:
                pass
        raise
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for context in contexts:
            await context.close()


def analyze(name, delay_ms, data, threshold, jitter=False):
    metrics = {'keydownToWebSocketMs': 'sentAt', 'keydownToAuthoritativeStateMs': 'stateAt',
               'keydownToVisibleCanvasMs': 'visibleAt'}
    events = data['events']
    for event in events:
        assert event['trusted'], f'Untrusted input: {event}'
        for metric, at in metrics.items():
            event[metric] = round(event[at] - event['keydownAt'], 3) if at in event else None
        event['stateToVisibleCanvasMs'] = round(event['visibleAt'] - event['stateAt'], 3) if 'stateAt' in event and 'visibleAt' in event else None
    stats = {metric: summary([event[metric] for event in events if event[metric] is not None]) for metric in metrics}
    category_names = ['held-walk', 'held-turn', 'early-release'] if jitter else ['tap', 'positioning', 'held-walk', 'held-turn', 'held-corner']
    categories = {category: {metric: summary([event[metric] for event in events if event.get('category') == category and event[metric] is not None])
                             for metric in metrics} for category in category_names}
    missing = [event['index'] for event in events if any(event[m] is None for m in metrics)]
    over = [event['index'] for event in events if event['keydownToVisibleCanvasMs'] is not None and event['keydownToVisibleCanvasMs'] > threshold]
    late_sends = [event['index'] for event in events if event['keydownToWebSocketMs'] is not None and event['keydownToWebSocketMs'] > threshold]
    held_segments = []
    moving_gaps = []
    stationary_intervals = 0
    interior_intervals = 0
    for index, event in enumerate(events):
        if event.get('category') not in ['held-walk', 'held-turn', 'held-corner']:
            continue
        observed_until = max([item['at'] for item in data['markers']] + [item['at'] for item in data['states']] + [event['keydownAt']])
        end = min(event.get('keyupAt', observed_until), events[index + 1]['keydownAt'] if index + 1 < len(events) else observed_until)
        markers = [marker for marker in data['markers'] if event['keydownAt'] <= marker['at'] < end]
        moving = [i for i in range(1, len(markers))
                  if math.hypot(markers[i]['x'] - markers[i-1]['x'], markers[i]['y'] - markers[i-1]['y']) >= .1]
        gaps = [markers[b]['at'] - markers[a]['at'] for a, b in zip(moving, moving[1:])]
        # Exclude leading and trailing stationary frames, including a key
        # held at a wall. Keep any pause between two visible displacements.
        if len(moving) > 1:
            interior_intervals += moving[-1] - moving[0]
            stationary_intervals += moving[-1] - moving[0] - len(gaps)
            moving_gaps.extend(gaps)
        states = [state for state in data['states'] if event['keydownAt'] <= state['at'] < end and state['player']]
        steps = [current['at'] for previous, current in zip(states, states[1:]) if current['player']['x'] != previous['player']['x'] or current['player']['y'] != previous['player']['y']]
        held_segments.append({'sample': index, 'category': event['category'], 'durationMs': round(end - event['keydownAt'], 3),
                              'canvasFrames': len(markers), 'movingCanvasFrames': len(moving),
                              'movingCanvasFrameGapMs': summary(gaps),
                              'authoritativeStepGapMs': summary([b - a for a, b in zip(steps, steps[1:])])})
    held_gaps = summary(moving_gaps)
    smooth = held_gaps['count'] > 0 and held_gaps['p95'] <= HELD_FRAME_GAP_P95_LIMIT_MS
    details = {'fixedDelayMsEachWay': delay_ms, 'simulatedRttMs': 2 * delay_ms}
    if jitter:
        details = {'outboundDelayMs': delay_ms, 'inboundStateDelayScheduleMs': JITTER_STATE_DELAYS_MS}
        if data.get('tileCss'):
            details['corridorMotion'] = corridor_motion(data)
    return {'profile': name, **details,
            'summary': stats, 'byCategory': categories, 'thresholdMs': threshold,
            'passesThreshold': not missing and not over and not late_sends and smooth, 'missingSamples': missing, 'samplesOverThreshold': over,
            'sendsOverThreshold': late_sends,
            'heldMotion': {'movingCanvasFrameGapMs': held_gaps, 'p95LimitMs': HELD_FRAME_GAP_P95_LIMIT_MS, 'passesThreshold': smooth,
                           'stationaryInteriorFrameIntervals': stationary_intervals,
                           'interiorFrameIntervals': interior_intervals},
            'heldSegments': held_segments, 'samples': events, 'raw': {'outgoingInputs': data['sends'], 'authoritativeStates': data['states'], 'canvasMarkers': data['markers']}}


def corridor_motion(data):
    """Observe the local marker on the open horizontal run in units of map tiles."""
    events, markers, tile = data['events'], data['markers'], data['tileCss']

    def measure(after_release):
        displacements, normalized, backtracks, moving_gaps, visible_pauses = [], [], [], [], []
        for index, event in enumerate(events):
            if (event['category'] == 'early-release') != after_release:
                continue
            until = events[index+1]['keydownAt'] if index+1 < len(events) else markers[-1]['at']
            if after_release:
                start = event.get('keyupAt', until)
            else:
                start = event['keydownAt']
                until = min(until, event.get('keyupAt', until))
            frames = [frame for frame in markers if start <= frame['at'] < until]
            direction = 1 if event['action'] == 'right' else -1
            started = after_release
            last_moved = None
            still = 0
            for a, b in zip(frames, frames[1:]):
                dt = b['at'] - a['at']
                if dt <= 1:
                    continue
                step = direction * (b['x'] - a['x']) / tile
                displacements.append(abs(step))
                normalized.append(abs(step) * (1000/60) / dt)
                if step > .0025:
                    started = True
                # Ignore residual motion in the old direction immediately after
                # turning. Count a correction once the new direction has begun.
                if started and step < -.005:
                    backtracks.append(-step)
                if abs(step) > .0025:
                    if last_moved is not None:
                        moving_gaps.append(b['at'] - last_moved)
                        if still:
                            visible_pauses.append(still)
                    last_moved = b['at']
                    still = 0
                elif last_moved is not None:
                    # A long browser frame is observable in the gap above. Only
                    # count the avatar as stopped if it was actually redrawn still.
                    still += dt
        return {'frameStepTiles': summary(displacements), 'frameStepTilesPer60HzFrame': summary(normalized),
                'movingFrameGapMs': summary(moving_gaps), 'interiorStationaryMs': summary(visible_pauses),
                'interiorStationaryOver50Ms': sum(pause > 50 for pause in visible_pauses),
                'backwardFrames': len(backtracks), 'totalBackwardTiles': round(sum(backtracks), 3),
                'largestBackwardFrameTiles': round(max(backtracks, default=0), 3)}

    return {'duringHold': measure(False), 'afterEarlyRelease': measure(True)}


async def main(args):
    args.output = Path(args.output).resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.server_root:
        shell.ROOT = Path(args.server_root).resolve()
    evidence = shell.Evidence(args.output.parent)
    result = {'measurement': 'trusted keydown to app-facing WebSocket.send, received authoritative own-player movement, and own-player Canvas marker movement',
              'probeVersion': 5, 'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'sourceLabel': args.source_label, 'serverRoot': str(shell.ROOT),
              'sourceSha256': source_fingerprints(),
              'canvasMovementThresholdCssPxPerFrame': .5,
              'caveats': ['Canvas draw submission timing excludes compositor, physical screen scanout and input hardware.',
                          'Loopback is a local measurement, not a latency guarantee across a WAN.',
                          'WebSocket forwarding preserves order and payloads. The optional corridor schedule delays incoming states by tick. Neither profile simulates packet loss.',
                          'Authoritative movement and turn eligibility retain the game movement cooldown; samples do not bypass simulation rules.'],
              'profiles': []}
    try:
        async with shell.server(True, evidence) as base:
            async with async_playwright() as playwright:
                executable = args.chromium or shutil.which('chromium') or shutil.which('chromium-browser') or playwright.chromium.executable_path
                browser = await playwright.chromium.launch(executable_path=executable, headless=True, args=['--no-sandbox'])
                try:
                    delays = [JITTER_OUTBOUND_MS] if args.jitter_corridor else [0] + ([args.network_delay_ms] if args.network_delay_ms else [])
                    for delay_ms in delays:
                        measured = await profile(browser, base, args, delay_ms, jitter=args.jitter_corridor)
                        result['profiles'].append(measured)
                        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
                        print(json.dumps({key: value for key, value in measured.items() if key not in ['samples', 'raw', 'markerVerification', 'heldSegments', 'sourceSha256']}, ensure_ascii=False), flush=True)
                finally:
                    await browser.close()
    except Exception as error:
        result['error'] = str(error)
        result['traceback'] = traceback.format_exc()
        if hasattr(error, 'partial_measurement'):
            result['failedProfile'] = error.partial_measurement
        raise
    finally:
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    if args.assert_latency:
        for measured in result['profiles']:
            assert not measured['sourceChangedDuringMeasurement'], f"Source changed during {measured['profile']}"
            assert measured['passesThreshold'], (
                f"{measured['profile']} failed: missing inputs {measured['missingSamples']}, "
                f"send/visible inputs over {args.threshold_ms:g} ms {measured['sendsOverThreshold']}/{measured['samplesOverThreshold']}, "
                f"held-motion intervals {measured['heldMotion']['movingCanvasFrameGapMs']} (required p95 ≤ {HELD_FRAME_GAP_P95_LIMIT_MS} ms). "
                f"See {args.output}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='/tmp/crazyacade-input/measurement.json')
    parser.add_argument('--chromium')
    parser.add_argument('--server-root', help='serve a pinned repository copy instead of the working tree')
    parser.add_argument('--source-label', help='human-readable source revision label, recorded alongside file SHA256 hashes')
    parser.add_argument('--samples', type=int, default=24, help='tap sample count, at least 20 and a multiple of 4')
    parser.add_argument('--jitter-corridor', action='store_true',
                        help='instead of the standard profiles, run Festival holds/releases with ordered, variable inbound delay and fixed 30 ms outgoing')
    parser.add_argument('--jitter-start-phase', type=int, choices=tuple(JITTER_START_OFFSETS_MS), default=5,
                        help='corridor start tick modulo the eight-message schedule; test both phases for comparisons')
    parser.add_argument('--network-delay-ms', type=float, default=40, help='additional delay in EACH WebSocket direction; 0 skips this profile')
    parser.add_argument('--threshold-ms', type=float, default=100)
    parser.add_argument('--assert-latency', action='store_true',
                        help='enforce input-send and visible-onset maxima and the 50 ms held-frame p95 on every profile')
    arguments = parser.parse_args()
    if arguments.samples < 20 or arguments.samples % 4:
        parser.error('--samples must be >=20 and divisible by 4')
    if arguments.network_delay_ms < 0:
        parser.error('--network-delay-ms must be nonnegative')
    asyncio.run(main(arguments))
