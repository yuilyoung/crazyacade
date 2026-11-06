"""Actual normal-match motion capture using UI, physical keys and public snapshots.

Run: python3 scripts/motion85-smoke.py. Requires system Chromium/ffmpeg and Python
Playwright. --self-test checks the route/blast safety planner without a browser.
No game state, time or WebSocket command injection. The server subprocess uses
the existing deterministic dart-drop RNG fixture; this is recorded in report.json. page.evaluate
is restricted to read-only canvas/rAF measurement and DOM/layout observations.
Artifacts default to /tmp/poppop-motion85 (MOTION85_ARTIFACTS overrides it).
"""
import asyncio
import base64
import json
import math
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get('MOTION85_ARTIFACTS', '/tmp/poppop-motion85'))
if '--solo-motion' in sys.argv:
    ARTIFACTS = ARTIFACTS / 'solo'
DIRECTIONS = [('ArrowUp', 0, 1), ('ArrowRight', 1, 0),
              ('ArrowDown', 0, -1), ('ArrowLeft', -1, 0)]


def route(state, start, goal):
    blocked = set(state['solid'] + state['soft']) | {
        f'{o["x"]},{o["y"]}' for o in state.get('orbs', [])}
    queue, seen = [(start, [])], {start}
    for (x, y), steps in queue:
        if (x, y) == goal:
            return steps
        for key, dx, dy in DIRECTIONS:
            cell = x + dx, y + dy
            if (not (0 < cell[0] < 12 and 0 < cell[1] < 10) or
                    cell in seen or f'{cell[0]},{cell[1]}' in blocked):
                continue
            seen.add(cell)
            queue.append((cell, steps + [(key, *cell)]))
    return None


def blast(state, origin, reach):
    cells = {origin}
    for _, dx, dy in DIRECTIONS:
        for distance in range(1, reach + 1):
            x, y = origin[0] + distance * dx, origin[1] + distance * dy
            if not (0 < x < 12 and 0 < y < 10) or f'{x},{y}' in state['solid']:
                break
            cells.add((x, y))
            if f'{x},{y}' in state['soft']:
                break
    return cells


def self_test():
    state = {'solid': ['2,2'], 'soft': ['3,1'], 'orbs': []}
    assert route(state, (1, 1), (3, 2)) == [
        ('ArrowUp', 1, 2), ('ArrowUp', 1, 3), ('ArrowRight', 2, 3),
        ('ArrowRight', 3, 3), ('ArrowDown', 3, 2)]
    assert route(state, (1, 1), (3, 1)) is None
    assert (3, 1) in blast(state, (1, 1), 7)
    assert (4, 1) not in blast(state, (1, 1), 7)
    assert (1, 4) in blast(state, (1, 1), 3)
    assert route(state, (1, 1), (1, 1)) == []
    print('PASS: 6 route/blast safety assertions')


async def until(predicate, label, timeout=10):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f'Timed out: {label}')
        await asyncio.sleep(.015)


# Independent rAF observer: it neither replaces app rAF nor writes app state.
# PNG samples are explicitly separate from the frame-interval sample below.
SAMPLE_FRAMES = """async ({count, every, marker, crop, maxMs}) => {
  const canvas = document.querySelector('#arena');
  const frames = []; let n = 0, started = null;
  const output = crop ? document.createElement('canvas') : canvas;
  const scale=canvas.width/780;
  if(crop) {output.width=Math.round(crop.w*scale);output.height=Math.round(crop.h*scale);}
  return await new Promise(resolve => {
    function sample(t) {
      if(started === null) started=t;
      if (n++ % every === 0) {
        let markerX = null;
        if (marker) {
          const scale=canvas.width/780, x0=Math.round(50*scale), y0=Math.round(520*scale);
          const w=Math.round(150*scale), h=Math.round(100*scale);
          const data=canvas.getContext('2d').getImageData(x0,y0,w,h).data;
          let sum=0, hits=0;
          for(let i=0;i<data.length;i+=4) {
            if(Math.abs(data[i]-255)<10 && Math.abs(data[i+1]-229)<10 && Math.abs(data[i+2]-129)<10) {
              sum += (x0+(i/4)%w)/scale; hits++;
            }
          }
          if(hits) markerX=sum/hits;
        }
        if(crop) output.getContext('2d').drawImage(canvas,crop.x*scale,crop.y*scale,crop.w*scale,crop.h*scale,0,0,output.width,output.height);
        frames.push({time:t, markerX, png:output.toDataURL('image/png')});
      }
      if (frames.length < count && t-started < maxMs) requestAnimationFrame(sample); else resolve(frames);
    }
    requestAnimationFrame(sample);
  });
}"""
SAMPLE_INTERVALS = """async (count) => await new Promise(resolve => {
  let last = null, started = null; const intervals = [];
  function sample(t) {
    if(started === null) started=t;
    if (last !== null) intervals.push(t-last); last=t;
    if (intervals.length < count && t-started < 5000) requestAnimationFrame(sample); else resolve(intervals);
  }
  requestAnimationFrame(sample);
})"""


class Client:
    def __init__(self, page, context, errors):
        self.page, self.context, self.messages = page, context, []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('websocket', lambda ws: ws.on('framereceived', self.record))

    def record(self, frame):
        if isinstance(frame, str):
            self.messages.append(json.loads(frame))

    def state(self):
        return next((m for m in reversed(self.messages) if m.get('type') == 'state'), {})

    def joined(self):
        return next((m for m in reversed(self.messages) if m.get('type') == 'joined'), {})


class Capture:
    def __init__(self, browser, base):
        self.browser, self.base, self.clients = browser, base, []
        self.errors, self.milestones, self.frames, self.intervals = [], [], [], []
        self.native_viewports = []
        self.started = time.monotonic()
        self.videos, self.coverage, self.concerns = [], set(), []
        self.video_name, self.video_start, self.video_starts = None, None, {}

    def state(self):
        return self.clients[0].state()

    def player(self, i):
        identity = self.clients[i].joined().get('playerId')
        return next((p for p in self.state().get('players', []) if p['id'] == identity), {})

    def mark(self, label, *coverage):
        state = self.state()
        record = {'label': label, 'elapsedSeconds': round(time.monotonic()-self.started, 3),
                  'video': self.video_name,
                  'approxVideoSeconds': round(time.monotonic()-self.video_start, 3) if self.video_start else None,
                  'tick': state.get('tick'), 'matchId': state.get('matchId'),
                  'phase': state.get('phase'), 'map': state.get('mapId'),
                  'players': state.get('players'), 'orbs': state.get('orbs'),
                  'waves': state.get('waves'), 'items': state.get('items'),
                  'soft': state.get('soft'), 'dartEffects': state.get('dartEffects'),
                  'relay': state.get('relay')}
        self.milestones.append(record)
        self.coverage.update(coverage)
        (ARTIFACTS / 'milestones.json').write_text(json.dumps(self.milestones, ensure_ascii=False, indent=2))
        print(f'PASS: {label} (tick {state.get("tick")})', flush=True)

    async def still(self, name):
        await self.clients[0].page.locator('#arena').screenshot(path=str(ARTIFACTS / f'{name}.png'))

    async def frames_during(self, name, action, count=18, every=1, max_ms=350, recipient=None):
        page = self.clients[0].page
        capture_start = time.monotonic()
        before = self.state()
        crop = None
        if 'walk' in name or 'direction' in name:
            player = self.player(0)
            cx, cy = player['x']*60+30, (10-player['y'])*60+30
            crop = {'x': max(0, cx-100), 'y': max(0, min(460, cy-100)), 'w': 220, 'h': 200}
        samples = asyncio.create_task(page.evaluate(SAMPLE_FRAMES, {'count': count, 'every': every, 'marker': name == 'full-walk', 'crop': crop, 'maxMs': max_ms}))
        # Let the observer register before sending the actual key.
        await asyncio.sleep(.025)
        await action()
        results = await samples
        for i, frame in enumerate(results):
            (ARTIFACTS / f'{name}-{i:02}.png').write_bytes(base64.b64decode(frame['png'].split(',', 1)[1]))
        self.frames.append({'label': name, 'count': len(results),
                            'video': self.video_name,
                            'approxVideoStartSeconds': round(capture_start-self.video_start, 3),
                            'logicalCanvasCrop': crop, 'observerMaxMs': max_ms,
                            'recipientId': self.clients[recipient].joined().get('playerId') if recipient is not None else None,
                            'beforeSnapshot': {'tick': before.get('tick'), 'players': before.get('players'), 'orbs': before.get('orbs')},
                            'afterSnapshot': {'tick': self.state().get('tick'), 'players': self.state().get('players'), 'orbs': self.state().get('orbs')},
                            'timesMs': [f['time'] for f in results],
                            'goldSelfMarkerCentroidX': [f.get('markerX') for f in results],
                            'uniquePngs': len({f['png'] for f in results})})

    async def key(self, i, key):
        page = self.clients[i].page
        await page.locator('#arena').focus()
        await page.keyboard.press(key)

    async def move(self, i, key, x, y):
        # Physical key down/up passes through the production input controller.
        await self.key(i, key)
        await until(lambda: (self.player(i).get('x'), self.player(i).get('y')) == (x, y),
                    f'player {i} move {key} to {x},{y}', timeout=4)

    async def walk(self, i, x, y):
        for _ in range(100):
            player = self.player(i)
            start = player.get('x'), player.get('y')
            steps = route(self.state(), start, (x, y))
            assert steps is not None, f'No route: {i} {start} -> {(x, y)}'
            if not steps:
                return
            assert player.get('alive') and not player.get('bubbleTicks'), f'Player {i} cannot walk'
            await self.move(i, *steps[0])
        raise AssertionError('Route exceeded 100 steps')

    async def open_match(self, name, map_id, rules):
        assert not self.clients, 'Close previous match before opening another'
        for i in range(8):
            options = {'viewport': {'width': 1440, 'height': 1100}, 'reduced_motion': 'no-preference'}
            if i == 0:
                options.update(record_video_dir=str(ARTIFACTS / 'raw-video'),
                               record_video_size={'width': 1280, 'height': 978})
            context = await self.browser.new_context(**options)
            if i == 0:
                self.video_name, self.video_start = name, time.monotonic()
                self.video_starts[name] = self.video_start-self.started
            page = await context.new_page()
            client = Client(page, context, self.errors)
            self.clients.append(client)
            await page.goto(self.base)
            if i > 0:
                await page.locator('#motion-toggle').click()
                await page.locator('#settings-open').click()
                await page.locator('#render-quality').select_option('low')
                await page.locator('#effect-level').select_option('minimal')
                await page.locator('#settings-close').click()
            await page.locator('#nickname').fill(f'Motion{i}')
            await page.locator('#room-id').fill(f'motion85-{name}')
            await page.locator('#mode').select_option('team')
            await page.locator('#rule-set').select_option(rules)
            await page.locator('#orb-skin').select_option(['bubble', 'star', 'duck'][i % 3])
            await page.locator('input[name="mapId"][value="'+map_id+'"]').check()
            await page.locator('#join-button').click()
            await until(lambda: client.joined(), f'{name} player {i} joins')
        await until(lambda: self.state().get('phase') == 'playing', f'{name} starts')
        assert len(self.state()['players']) == 8
        assert not any(p['isBot'] for p in self.state()['players'])
        assert not self.state().get('training')
        await self.clients[0].page.locator('#arena').scroll_into_view_if_needed()
        self.mark(f'{name}: eight automated browser clients in normal non-bot slots start')

    async def close_match(self, name):
        if not self.clients:
            return
        first = self.clients[0]
        video = first.page.video
        for client in self.clients:
            await client.context.close()
        if video:
            path = ARTIFACTS / f'{name}.webm'
            await video.save_as(str(path))
            self.videos.append(str(path))
        self.clients = []

    async def performance(self, label):
        # No PNG encodes/screenshots during this bounded, separate sample.
        values = await self.clients[0].page.evaluate(SAMPLE_INTERVALS, 180)
        ordered = sorted(values)
        self.intervals.append({'label': label, 'count': len(values), 'maximumSampleMs': 5000,
            'durationMs': round(sum(values), 2), 'medianMs': ordered[len(ordered)//2],
            'p95Ms': ordered[math.ceil(.95*len(ordered))-1], 'maxMs': max(values),
            'estimatedRafHz': round(1000*len(values)/sum(values), 2),
            'over33_4Ms': sum(v > 33.4 for v in values),
            'scope': f'Observed rAF intervals; shared host, headless Chromium, {len(self.clients)} pages, one recording. No render CPU timing or production FPS/SLO claim.'})

    async def garden(self):
        await self.open_match('full-combat', 'garden', 'classic')
        await self.frames_during('full-walk', lambda: self.move(0, 'ArrowRight', 2, 1))
        await self.move(0, 'ArrowLeft', 1, 1)
        self.mark('confirmed adjacent movement with actual canvas frames', 'movement')
        # Same normal-input match route and drop fixture as browser-smoke.
        await self.move(2, 'ArrowDown', 1, 2)
        async def place_and_escape():
            await self.key(0, 'Space')
            await until(lambda: len(self.state()['orbs']) == 1, 'real bomb placed')
            self.mark('real physical Space installs bomb', 'bomb')
            await self.move(0, 'ArrowRight', 2, 1)
            await self.move(0, 'ArrowRight', 3, 1)
            await self.move(0, 'ArrowUp', 3, 2)
        await self.frames_during('full-place', place_and_escape)
        await until(lambda: self.player(2).get('bubbleTicks', 0) > 0, 'actual ally bubble', 4)
        self.mark('actual bomb explosion traps ally', 'explosion', 'bubble')
        await self.still('full-bubble')
        await until(lambda: not self.state()['waves'], 'waves expire')
        await self.move(0, 'ArrowDown', 3, 1)
        await self.move(0, 'ArrowLeft', 2, 1)
        async def rescue_then_recipient_moves():
            await self.move(0, 'ArrowLeft', 1, 1)
            assert self.player(2)['bubbleTicks'] == 0 and self.player(0)['rescues'] == 1
            await self.move(2, 'ArrowUp', 1, 3)
            await self.move(2, 'ArrowRight', 2, 3)
        await self.frames_during('full-rescue', rescue_then_recipient_moves, max_ms=650, recipient=2)
        assert self.player(2)['bubbleTicks'] == 0 and self.player(0)['rescues'] == 1
        self.mark('actual rescued recipient moves while rescuer remains distinct', 'recipient-rescue-follow')
        self.mark('adjacent real movement rescues ally', 'rescue')
        # Existing integration fixture changes only drop RNG in this test server.
        # Crate destruction and pickup still follow actual normal input/ticks.
        await self.move(0, 'ArrowRight', 2, 1)
        await self.move(0, 'ArrowRight', 3, 1)
        await self.key(0, 'Space')
        await until(lambda: any(o['x'] == 3 and o['y'] == 1 for o in self.state()['orbs']), 'crate bomb')
        await self.move(0, 'ArrowLeft', 2, 1)
        await self.move(0, 'ArrowLeft', 1, 1)
        await self.move(0, 'ArrowUp', 1, 2)
        await until(lambda: any(i['x'] == 5 and i['y'] == 1 and i['type'] == 'dart' for i in self.state()['items']), 'actual crate dart drop', 4)
        self.mark('real explosion removes crate and drops server dart', 'crate')
        await self.still('full-crate-break')
        await until(lambda: not self.state()['waves'], 'crate waves expire')
        await self.move(0, 'ArrowDown', 1, 1)
        for x in [2, 3, 4]:
            await self.move(0, 'ArrowRight', x, 1)
        # Walk nearby ally around the pickup cell instead of collecting it.
        for step in [('ArrowRight', 3, 3), ('ArrowRight', 4, 3), ('ArrowRight', 5, 3), ('ArrowDown', 5, 2)]:
            await self.move(2, *step)
        previous = self.player(0)['itemsCollected']
        async def pickup_then_recipient_moves():
            await self.move(0, 'ArrowRight', 5, 1)
            await self.move(0, 'ArrowRight', 6, 1)
        await self.frames_during('full-pickup', pickup_then_recipient_moves, max_ms=650, recipient=0)
        self.mark('actual pickup recipient immediately moves with nearby separate ally', 'recipient-pickup-follow')
        assert self.player(0)['darts'] == 1 and self.player(0)['itemsCollected'] == previous+1
        self.mark('real movement collects dart and increments counter', 'pickup')
        # Preposition and face the target before its actual two-second bubble.
        await self.move(0, 'ArrowLeft', 5, 1)
        await self.walk(2, 1, 1)
        before_rescues = self.player(0)['rescues']
        await self.key(2, 'Space')
        await until(lambda: self.player(2)['bubbleTicks'] > 0, 'dart target bubbles', 4)
        await until(lambda: not self.state()['waves'], 'dart blast expires')
        assert self.player(2)['bubbleTicks'] > 0
        async def dart_then_rescued_recipient_moves():
            await self.key(0, 'f')
            await until(lambda: self.player(0)['darts'] == 0 and self.player(2)['bubbleTicks'] == 0, 'actual dart rescues recipient')
            await self.move(2, 'ArrowUp', 1, 2)
            await self.move(2, 'ArrowUp', 1, 3)
        await self.frames_during('full-dart', dart_then_rescued_recipient_moves, max_ms=650, recipient=2)
        assert self.player(0)['darts'] == 0 and self.player(2)['bubbleTicks'] == 0
        assert self.player(0)['rescues'] == before_rescues+1
        assert any(m.get('dartEffects') for m in self.clients[0].messages if m.get('type') == 'state')
        self.mark('physical F path actually rescues distant bubbled ally', 'dart')
        await self.performance('full garden after actual combat')
        await self.close_match('full-combat')

    async def settings(self, effects, reduced=False, contrast=False):
        page = self.clients[0].page
        if (await page.locator('#motion-toggle').get_attribute('aria-pressed') == 'true') != reduced:
            await page.locator('#motion-toggle').click()
        await page.locator('#settings-open').click()
        await page.locator('#effect-level').select_option(effects)
        if (await page.locator('#contrast-toggle').get_attribute('aria-pressed') == 'true') != contrast:
            await page.locator('#contrast-toggle').click()
        await page.locator('#settings-close').click()
        await page.locator('#arena').scroll_into_view_if_needed()
        assert await page.locator('body').get_attribute('data-effects') == effects
        self.mark(f'UI effects={effects}, reduced={reduced}, contrast={contrast}', 'settings')

    async def harmony(self):
        await self.open_match('modes-and-harmony', 'festival', 'harmony')
        # Normal relay permits real death and subsequent respawn without ending match.
        await self.walk(2, 2, 5)
        await self.walk(0, 4, 4)
        await self.key(2, 'Space')
        await until(lambda: self.player(2)['bubbleTicks'] > 0, 'harmony actual hit', 4)
        self.mark('normal Harmony bomb bubbles ally')
        await until(lambda: not self.player(2)['alive'], 'actual bubble timeout death', 4)
        self.mark('actual timeout eliminates player', 'death')
        await self.still('full-death')
        await until(lambda: self.player(2)['alive'], 'normal timed respawn', 7)
        self.mark('server timed rejoin observed', 'respawn')
        await self.frames_during('recipient-spawn-follow', lambda: self.move(2, 'ArrowRight', 2, 3), max_ms=650, recipient=2)
        self.mark('actual respawned recipient moves during spawn cue window', 'recipient-spawn-follow')
        await self.still('full-respawn')
        await self.walk(0, 6, 5)
        await until(lambda: self.state()['relay']['carrierId'] == self.clients[0].joined()['playerId'], 'actual central star pickup')
        await self.walk(2, 4, 5)
        await self.walk(0, 5, 5)
        await self.frames_during('full-pass', lambda: self.pass_to(0, 2), count=18)
        self.mark('physical G passes to actual ally', 'pass')
        await self.walk(0, 5, 6)
        for direction, key, x, y in [('right', 'ArrowRight', 6, 6), ('up', 'ArrowUp', 6, 7), ('left', 'ArrowLeft', 5, 7), ('down', 'ArrowDown', 5, 6)]:
            await self.frames_during(f'full-direction-{direction}', lambda key=key, x=x, y=y: self.move(0, key, x, y))
        self.mark('actual four-direction inputs with frame samples for visual review', 'directions')
        await self.walk(4, 6, 5)  # Actual ally positioned in the upcoming reduced blast lane.
        # Repeated observed movement in the same live match under each preference.
        for name, effects, reduced, contrast in [
                ('reduced', 'full', True, False), ('calm', 'calm', False, False),
                ('minimal', 'minimal', False, True)]:
            await self.settings(effects, reduced, contrast)
            await self.walk(0, 5, 6)
            await self.frames_during(f'{name}-walk', lambda: self.move(0, 'ArrowRight', 6, 6))
            async def place_and_escape_mode():
                await self.key(0, 'Space')
                await until(lambda: bool(self.state()['orbs']), f'{name} bomb installed')
                await self.move(0, 'ArrowUp', 6, 7)
                await self.move(0, 'ArrowRight', 7, 7)
            await self.frames_during(f'{name}-place', place_and_escape_mode)
            if name == 'reduced':
                await until(lambda: any(o['fuse'] <= 2 for o in self.state()['orbs']), 'reduced fuse approaches actual hit')
                async def observe_reduced_hit():
                    await until(lambda: self.player(4)['bubbleTicks'] > 0, 'actual reduced ally bubble', 4)
                    self.mark('reduced actual ally bubble: frame observer spans hit and countdown', 'reduced-hit-countdown')
                    await self.still('reduced-explosion')
                await self.frames_during('reduced-hit', observe_reduced_hit, count=18)
                await self.still('reduced-bubble-countdown')
                assert self.player(4)['bubbleTicks'] > 0
                await until(lambda: not self.state()['waves'], 'reduced waves expire')
                await self.walk(0, 7, 5)
                assert self.player(4)['bubbleTicks'] == 0
                await self.walk(4, 8, 5)
            else:
                await until(lambda: bool(self.state()['waves']), f'{name} real explosion', 4)
                await self.still(f'{name}-explosion')
                await until(lambda: not self.state()['waves'], f'{name} waves expire')
            self.mark(f'{name}: actual move, placement and immediate dangerous cells', name)
        await self.performance('minimal high-contrast live match')
        page = self.clients[0].page
        await page.locator('#settings-open').click()
        await page.locator('#text-scale').select_option('130')
        await page.locator('#settings-close').click()
        await page.set_viewport_size({'width': 390, 'height': 844})
        await page.locator('#arena').scroll_into_view_if_needed()
        assert await page.locator('body').get_attribute('data-font-scale') == '130'
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile130 overflow'
        await page.screenshot(path=str(ARTIFACTS / 'mobile130-viewport.png'))
        png = (ARTIFACTS / 'mobile130-viewport.png').read_bytes()
        dimensions = [int.from_bytes(png[16:20], 'big'), int.from_bytes(png[20:24], 'big')]
        assert dimensions == [390, 844], dimensions
        self.native_viewports.append({'file': 'mobile130-viewport.png', 'pngDimensions': dimensions,
            'browserViewport': page.viewport_size, 'fontScale': await page.locator('body').get_attribute('data-font-scale'),
            'horizontalOverflow': await page.evaluate('document.documentElement.scrollWidth > innerWidth')})
        await page.screenshot(path=str(ARTIFACTS / 'mobile130.png'), full_page=True)
        self.mark('390x844 viewport and actual 130% text preference have no horizontal overflow', 'mobile130')
        await page.set_viewport_size({'width': 1440, 'height': 1100})
        await self.settings('full')
        before_id = self.clients[0].joined()['playerId']
        before_match = self.state()['matchId']
        await page.reload()
        await until(lambda: self.clients[0].joined().get('resumed') and self.state().get('phase') == 'playing', 'real reload resume')
        assert self.clients[0].joined()['playerId'] == before_id and self.state()['matchId'] == before_match
        await page.locator('#arena').scroll_into_view_if_needed()
        await self.still('reload-resume')
        self.mark('real reload resumes same identity and ongoing match', 'resume')
        # Finish via normal charged Harmony deliveries, then all players ready.
        await self.walk(0, 5, 5)
        await self.walk(2, 4, 5)
        while self.state()['phase'] == 'playing':
            carrier = self.state()['relay']['carrierId']
            if carrier is None:
                await self.walk(0, 6, 5)
                await until(lambda: self.state()['relay']['carrierId'] is not None, 'normal star respawn', 7)
                carrier = self.state()['relay']['carrierId']
            index = next(i for i, c in enumerate(self.clients) if c.joined()['playerId'] == carrier)
            # Deliver current star normally. Three or more deliveries are fine;
            # using real G to two recipients also captures charged pass motion.
            if index == 2:
                await self.walk(2, 4, 5)
                await self.walk(0, 5, 5)
                await self.move(2, 'ArrowLeft', 3, 5)
                await self.move(2, 'ArrowRight', 4, 5)
                await self.pass_to(2, 0)
                index = 0
            await self.walk(2, 4, 5)
            await self.walk(0, 5, 5)
            await self.move(0, 'ArrowRight', 6, 5)
            await self.move(0, 'ArrowLeft', 5, 5)
            await self.pass_to(0, 2)
            await self.move(2, 'ArrowLeft', 3, 5)
            await self.move(2, 'ArrowRight', 4, 5)
            await self.pass_to(2, 0)
            await self.walk(0, 1, 5)
            if self.state()['phase'] == 'playing':
                await self.walk(0, 5, 5)
        assert self.state()['result']['reason'] == 'harmony_goal'
        self.mark('normal Harmony score reaches result', 'result')
        await self.still('harmony-result')
        old = self.state()['matchId']
        for client in self.clients:
            await client.page.locator('#replay-button').click()
        await until(lambda: self.state()['phase'] == 'playing' and self.state()['matchId'] != old, 'all-ready actual rematch')
        assert all(p['bombsPlaced'] == 0 and p['itemsCollected'] == 0 for p in self.state()['players'])
        self.mark('all-ready fresh rematch resets gameplay counters', 'rematch')
        await self.still('fresh-rematch')
        await self.staggered_fuses()
        await self.close_match('modes-and-harmony')

    async def staggered_fuses(self):
        # A fresh normal match gives all three actors one bomb each. Different
        # skins are selected in the real lobby and all use server20-tick fuses.
        for level in ['full', 'calm', 'minimal']:
            await self.settings(level)
            for i, x in [(0, 4), (2, 6), (4, 8)]:
                await self.walk(i, x, 5)
            for i, escape in [(0, [('ArrowDown', 4, 4), ('ArrowRight', 5, 4)]),
                              (2, [('ArrowUp', 6, 6), ('ArrowRight', 7, 6)])]:
                await self.key(i, 'Space')
                await until(lambda i=i: any(o['x'] == self.player(i)['x'] and o['y'] == self.player(i)['y'] for o in self.state()['orbs']), f'{level} actual staggered bomb {i}')
                for step in escape:
                    await self.move(i, *step)
            async def third_bomb_and_escape():
                await self.key(4, 'Space')
                await until(lambda: len(self.state()['orbs']) == 3, f'{level} three actual orbs')
                fuses = [o['fuse'] for o in self.state()['orbs']]
                assert max(fuses) > min(fuses), f'{level} fuse stages must differ'
                assert {o['orbSkinId'] for o in self.state()['orbs']} == {'bubble', 'star', 'duck'}
                self.mark(f'{level}: three actual skins have staggered remaining fuse ticks', 'staggered-fuses-'+level)
                await self.move(4, 'ArrowDown', 8, 4)
                await self.move(4, 'ArrowLeft', 7, 4)
            await self.frames_during(f'dense-{level}-fuses', third_bomb_and_escape, max_ms=650)
            await self.still(f'dense-{level}-fuses')
            await until(lambda: not self.state()['orbs'], f'{level} actual chained explosions', 4)
            await until(lambda: not self.state()['waves'], f'{level} actual waves expire', 4)
            assert all(self.player(i)['alive'] and not self.player(i)['bubbleTicks'] for i in [0, 2, 4])

    async def pass_to(self, source, target):
        await until(lambda: self.state()['relay']['passCooldownTicks'] == 0, 'pass cooldown')
        await self.key(source, 'g')
        await until(lambda: self.state()['relay']['carrierId'] == self.clients[target].joined()['playerId'], 'real G pass target')

    def report(self, outcome, failure=None, required=None):
        required = required if required is not None else {'movement', 'bomb', 'explosion', 'crate', 'pickup', 'bubble', 'rescue',
                    'death', 'respawn', 'dart', 'pass', 'reduced', 'calm', 'minimal',
                    'mobile130', 'resume', 'result', 'rematch', 'recipient-pickup-follow',
                    'recipient-rescue-follow', 'recipient-spawn-follow', 'staggered-fuses-full',
                    'staggered-fuses-calm', 'staggered-fuses-minimal'}
        data = {'outcome': outcome, 'failure': failure, 'coverage': sorted(self.coverage),
            'missingCoverage': sorted(required-self.coverage), 'pageErrors': self.errors,
            'frames': self.frames, 'frameIntervals': self.intervals, 'videos': self.videos,
            'nativeViewportScreenshots': self.native_viewports,
            'concerns': self.concerns, 'videoStartsRelativeSeconds': self.video_starts,
            'timestampLimits': 'Video times approximate local monotonic page creation; PNG frame times are actual browser rAF timestamps. Encoding/page initialization may offset video by a small amount.',
            'conditions': {
                'baselineCommit': '4f647ef',
                'baselineVideo': '/workspace/artifacts/crazyacade-motion-audit-2026-11-06/movement-and-bomb.webm',
                'chromium': shutil.which('chromium'), 'ffmpeg': shutil.which('ffmpeg'),
                'viewports': ['1440x1100', '390x844 at text 130%'],
                'nonRecordedClients': 'Seven normal UI clients use low render quality, minimal effects and reduced motion to reduce shared-host observer overhead.',
                'input': 'Visible UI and physical keyboard only. Public server snapshots observed read-only.',
                'humanPlaytesters': 0,
                'noInjection': 'No state, clock, WebSocket command or fake event injection.',
                'deterministicDropFixture': True,
                'dropFixture': 'Server/test/fixtures/dart-drops.mjs, test subprocess only; no production random-distribution claim.',
                'normalTickIntervalMs': 100,
                'frameEvidence': 'Canvas PNGs sampled read-only from actual rAF frames; visual review still required.',
                'performanceLimits': 'Bounded rAF interval samples on shared host; page count is recorded per sample and one video is active; excludes PNG windows. Not production SLO, render CPU timing, service capacity, or human playtesting.'}}
        (ARTIFACTS / 'report.json').write_text(json.dumps(data, ensure_ascii=False, indent=2))
        return data


async def capture_solo(browser, base):
    """One normal practice page with seven server AI, matching baseline load shape."""
    capture = Capture(browser, base)
    context = await browser.new_context(viewport={'width': 1440, 'height': 1100},
        reduced_motion='no-preference', record_video_dir=str(ARTIFACTS / 'raw-video'),
        record_video_size={'width': 1280, 'height': 978})
    capture.video_name, capture.video_start = 'solo-practice', time.monotonic()
    capture.video_starts['solo-practice'] = capture.video_start-capture.started
    page = await context.new_page()
    capture.clients = [Client(page, context, capture.errors)]
    required = {'movement', 'bomb', 'explosion'}
    try:
        await page.goto(base)
        await page.locator('#nickname').fill('MotionSolo')
        await page.locator('#mode').select_option('team')
        await page.locator('input[name="mapId"][value="garden"]').check()
        await page.locator('#practice-button').click()
        await until(lambda: capture.state().get('phase') == 'playing', 'normal solo practice starts')
        assert capture.state()['practice'] and not capture.state().get('training')
        assert len(capture.state()['players']) == 8 and sum(p['isBot'] for p in capture.state()['players']) == 7
        await page.locator('#arena').scroll_into_view_if_needed()
        clip_start = time.monotonic()
        capture.mark('one automated browser plus seven authoritative AI starts normal practice')
        await capture.frames_during('full-walk', lambda: capture.move(0, 'ArrowRight', 2, 1))
        capture.mark('one-page actual adjacent movement sampled', 'movement')
        await capture.move(0, 'ArrowLeft', 1, 1)
        async def place_escape():
            await capture.key(0, 'Space')
            await until(lambda: capture.player(0)['bombsPlaced'] > 0, 'solo bomb installed')
            capture.mark('actual solo Space installs bomb', 'bomb')
            await capture.move(0, 'ArrowRight', 2, 1)
            await capture.move(0, 'ArrowRight', 3, 1)
            await capture.move(0, 'ArrowUp', 3, 2)
        await capture.frames_during('full-place', place_escape)
        await until(lambda: bool(capture.state()['waves']), 'solo actual explosion', 4)
        capture.mark('actual solo bomb explodes under normal server timing', 'explosion')
        await capture.still('solo-explosion')
        await capture.performance('one page full effects and seven server AI, after actual movement/bomb')
        remaining = 8.25-(time.monotonic()-clip_start)
        if remaining > 0:
            await asyncio.sleep(remaining)
        await capture.still('solo-rest')
        clip_offset = clip_start-capture.video_start
        await capture.close_match('solo-practice')
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(clip_offset),
            '-i', str(ARTIFACTS / 'solo-practice.webm'), '-t', '8', '-an', '-c:v', 'libvpx-vp9',
            '-crf', '32', '-b:v', '0', str(ARTIFACTS / 'solo-gameplay-8s.webm')], check=True)
        export_filmstrips()
        report = capture.report('passed', required=required)
        assert not report['missingCoverage'] and not capture.errors
        report['conditions']['scenario'] = 'One Chromium page, actual full-effects/no-reduced normal garden practice, seven authoritative AI, 100ms server ticks; comparable load shape to before audit.'
        report['conditions']['nonRecordedClients'] = 'None: seven opponents/allies are server AI; one browser page total.'
        report['conditions']['humanPlaytesters'] = 0
        report['conditions']['viewports'] = ['1440x1100 actual browser viewport; video 1280x978']
        report['conditions']['performanceLimits'] = 'Bounded rAF intervals, one headless Chromium page, one recording, seven server AI, shared host. No PNGs during this sample. Not production SLO, render CPU timing, service capacity or human playtesting.'
        report['clips'] = [str(ARTIFACTS / 'solo-gameplay-8s.webm')]
        (ARTIFACTS / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print('PASS: isolated one-page actual practice motion; evidence '+str(ARTIFACTS), flush=True)
    except Exception as error:
        if capture.clients:
            await capture.still('solo-failure')
            await capture.close_match('solo-failure')
        capture.report('failed', repr(error), required=required)
        raise


def export_video_events():
    """Recover short transients from the original video, not late screenshots."""
    events = json.loads((ARTIFACTS / 'milestones.json').read_text())
    requests = [('crate', 'real explosion removes crate and drops server dart', .45),
                ('death', 'actual timeout eliminates player', .35),
                ('minimal-wave', 'minimal: actual move, placement and immediate dangerous cells', .85)]
    index = {}
    for name, label, before in requests:
        event = next((e for e in events if e['label'] == label), None)
        if event is None:
            continue
        start = max(0, event['approxVideoSeconds']-before)
        source = ARTIFACTS / (event['video']+'.webm')
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(start),
            '-i', str(source), '-t', '1.2', '-vf', 'fps=10,format=rgb24',
            str(ARTIFACTS / f'video-{name}-%02d.png')], check=True)
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-framerate', '10',
            '-i', str(ARTIFACTS / f'video-{name}-%02d.png'), '-vf',
            'scale=320:244,format=rgb24,tile=4x3', '-frames:v', '1',
            str(ARTIFACTS / f'video-{name}-filmstrip.png')], check=True)
        index[name] = {'source': source.name, 'startSeconds': start, 'intervalSeconds': .1,
            'frames': [p.name for p in sorted(ARTIFACTS.glob(f'video-{name}-[0-9][0-9].png'))],
            'timestampLimit': 'Approximate video time from local page creation; visually verify selected frames.'}
    if index:
        (ARTIFACTS / 'video-event-index.json').write_text(json.dumps(index, indent=2))


def export_filmstrips():
    """Derive static review sheets from actual captured pixels, after browsers close."""
    index = {}
    baseline = Path('/workspace/artifacts/crazyacade-motion-audit-2026-11-06/movement-and-bomb.webm')
    if baseline.exists():
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(baseline),
                        '-vf', 'fps=2,scale=390:-1,tile=4x4', '-frames:v', '1',
                        str(ARTIFACTS / 'before-baseline-filmstrip.png')], check=True)
        index['before-baseline-filmstrip.png'] = {'source': str(baseline), 'timesSeconds': [i/2 for i in range(16)]}
    groups = {
        'after-walk-filmstrip': sorted(ARTIFACTS.glob('full-walk-*.png')),
        'after-recipient-follow-filmstrip': [p for name in ['full-pickup', 'full-rescue', 'full-dart', 'recipient-spawn-follow']
            for p in sorted(ARTIFACTS.glob(name+'-[0-9][0-9].png'))],
        'after-staggered-fuses-filmstrip': [p for level in ['full','calm','minimal']
            for p in sorted(ARTIFACTS.glob(f'dense-{level}-fuses-[0-9][0-9].png'))],
        'after-directions-filmstrip': [paths[i] for direction in ['right', 'up', 'left', 'down']
            for paths in [sorted(ARTIFACTS.glob(f'full-direction-{direction}-*.png'))]
            for i in sorted({0, len(paths)//3, 2*len(paths)//3, len(paths)-1}) if paths],
        'after-events-filmstrip': [ARTIFACTS / name for name in ['full-bubble.png', 'full-crate-break.png',
            'full-pickup-02.png', 'full-rescue-02.png', 'full-dart-02.png', 'full-pass-02.png',
            'full-death.png', 'full-respawn.png', 'reduced-explosion.png', 'calm-explosion.png',
            'minimal-explosion.png', 'reduced-bubble-countdown.png', 'reduced-hit-02.png', 'fresh-rematch.png']]}
    for name, sources in groups.items():
        sources = [p for p in sources if p.exists()]
        if not sources:
            continue
        folder = ARTIFACTS / name
        folder.mkdir(exist_ok=True)
        for old in folder.glob('*.png'):
            old.unlink()
        for i, source in enumerate(sources):
            # Canvas backing PNGs and CSS screenshots can differ in dimensions.
            # Normalize each real frame before tile accumulation; a changing
            # input size otherwise resets ffmpeg's tile filter and drops tiles.
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                '-i', str(source), '-vf',
                'scale=390:330:force_original_aspect_ratio=decrease,pad=390:330:(ow-iw)/2:(oh-ih)/2,format=rgb24,setsar=1',
                '-frames:v', '1', str(folder / f'{i:03}.png')], check=True)
        rows = math.ceil(len(sources)/4)
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-framerate', '1',
            '-i', str(folder / '%03d.png'), '-vf', f'tile=4x{rows}',
            '-frames:v', '1', str(ARTIFACTS / f'{name}.png')], check=True)
        index[f'{name}.png'] = [str(p.name) for p in sources]
    (ARTIFACTS / 'filmstrip-index.json').write_text(json.dumps(index, indent=2))


async def main():
    from playwright.async_api import async_playwright
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    # Previous attempts are archived separately; never mix stale frame samples.
    for pattern in ['*.png', '*.json', '*.webm']:
        for old in ARTIFACTS.glob(pattern):
            old.unlink()
    # Prefer Playwright's bundled encoder. If absent, derive its revision from
    # the installed driver manifest and use a per-process /tmp cache fallback.
    import playwright
    manifest = Path(playwright.__file__).parent / 'driver/package/browsers.json'
    revision = next(b['revision'] for b in json.loads(manifest.read_text())['browsers'] if b['name'] == 'ffmpeg')
    current_cache = Path(os.environ.get('PLAYWRIGHT_BROWSERS_PATH', str(Path.home() / '.cache/ms-playwright')))
    current_encoder = current_cache / f'ffmpeg-{revision}' / 'ffmpeg-linux'
    if not current_encoder.exists():
        cache = Path('/tmp/poppop-motion-playwright')
        encoder = cache / f'ffmpeg-{revision}' / 'ffmpeg-linux'
        encoder.parent.mkdir(parents=True, exist_ok=True)
        if not encoder.exists():
            encoder.symlink_to(shutil.which('ffmpeg') or '/usr/bin/ffmpeg')
        os.environ['PLAYWRIGHT_BROWSERS_PATH'] = str(cache)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', ALLOW_DEV_GUESTS='true',
               SUPABASE_URL='', SUPABASE_ANON_KEY='', SUPABASE_SERVICE_ROLE_KEY='')
    with (ARTIFACTS / 'server.log').open('w') as log:
        server = subprocess.Popen(['node', '--import', './test/fixtures/dart-drops.mjs', 'src/index.js'], cwd=ROOT / 'Server', env=env, stdout=log, stderr=log)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base + '/health', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    await asyncio.sleep(.05)
            else:
                raise AssertionError('Server did not start')
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
                if '--solo-motion' in sys.argv:
                    try:
                        await capture_solo(browser, base)
                    finally:
                        await browser.close()
                    return
                capture = Capture(browser, base)
                try:
                    await capture.garden()
                    await capture.harmony()
                    export_filmstrips()
                    export_video_events()
                    assert not capture.errors, capture.errors
                    report = capture.report('passed')
                    assert not report['missingCoverage'], report['missingCoverage']
                    print(f'PASS: normal gameplay motion capture; evidence {ARTIFACTS}', flush=True)
                except Exception as error:
                    if capture.clients:
                        await capture.still('failure')
                        (ARTIFACTS / 'failure-state.json').write_text(json.dumps(capture.state(), ensure_ascii=False, indent=2))
                        await capture.close_match('failure-partial')
                    capture.report('failed', repr(error))
                    raise
                finally:
                    await browser.close()
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == '__main__':
    if '--self-test' in sys.argv:
        self_test()
    else:
        asyncio.run(main())
