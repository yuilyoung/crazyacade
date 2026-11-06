"""Eight actual Chromium clients: expanded edges, real combat/pass and rematch.

Run sequentially after other tests: python3 scripts/arena8-smoke.py
ARENA8_ARTIFACTS defaults to /tmp/poppop-arena8. ARENA8_BASE_URL may
point to an already running exact-source server (including a Docker image).
Without it this script starts a local server using the existing deterministic
RNG drop fixture. That fixture changes drops only; no gameplay state, clock,
WebSocket commands or timers are injected. External servers must use that same
fixture for this dart-pickup scenario. ARENA8_VIEWPORTS_ONLY=1 skips already
verified eight-client gameplay for focused layout reruns; ARENA8_VIEWPORTS may
restrict cases to comma-separated sizes such as 1280x720,1920x1080.
ARENA8_PARTY=1 selects ordinary three-round party practice for layout checks. CHROMIUM may override the executable.
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import urllib.request
from playwright.async_api import async_playwright
from arena_smoke_helpers import arena, assert_arena, blast, center, crate_plan, route

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get('ARENA8_ARTIFACTS', '/tmp/poppop-arena8'))


async def until(predicate, label, timeout=10):
    end = asyncio.get_running_loop().time() + timeout
    while not predicate():
        assert asyncio.get_running_loop().time() < end, f'Timed out: {label}'
        await asyncio.sleep(.02)


async def acceptance(browser, base):
    clients, errors, milestones, layouts = [], [], [], []
    full_run = os.environ.get('ARENA8_VIEWPORTS_ONLY') != '1'

    async def client(width=1440, height=1100, dpr=1):
        context = await browser.new_context(viewport={'width': width, 'height': height},
                                            device_scale_factor=dpr, has_touch=True)
        page = await context.new_page()
        entry = {'context': context, 'page': page, 'messages': []}
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('websocket', lambda ws: ws.on('framereceived', lambda frame: entry['messages'].append(json.loads(frame))))
        clients.append(entry)
        await page.goto(base)
        return page

    def state(i=0):
        return next((m for m in reversed(clients[i]['messages']) if m.get('type') == 'state'), {})

    def identity(i):
        return next((m['playerId'] for m in reversed(clients[i]['messages']) if m.get('type') == 'joined'), None)

    def player(i):
        return next((p for p in state()['players'] if p['id'] == identity(i)), {})

    def mark(label):
        milestones.append({'label': label, 'state': state()})
        (ARTIFACTS / 'milestones.json').write_text(json.dumps(milestones, indent=2))
        print('PASS: ' + label, flush=True)

    async def key(i, value):
        await clients[i]['page'].locator('#arena').focus()
        await clients[i]['page'].keyboard.press(value)

    async def move(i, step):
        await key(i, step[0])
        await until(lambda: (player(i)['x'], player(i)['y']) == tuple(step[1:]), f'key {i} {step}')

    async def walk(i, goal):
        for _ in range(195):
            p = player(i)
            steps = route(state(), (p['x'], p['y']), goal)
            assert steps is not None, (i, goal, state())
            if not steps:
                return
            await move(i, steps[0])
        raise AssertionError('Route exceeded board area')

    try:
        if full_run:
            # Programmatic team selections must redraw mode-specific miniatures.
            lobby = await client()
            await lobby.locator('#mode').select_option('duel')
            await lobby.wait_for_function("[...document.querySelectorAll('canvas.map-art')].every(c=>c.width===130&&c.height===110)")
            await lobby.locator('#quick-friends').click()
            assert await lobby.locator('#mode').input_value() == 'team'
            await lobby.wait_for_function("[...document.querySelectorAll('canvas.map-art')].every(c=>c.width===150&&c.height===130)")
            await lobby.locator('#mode').select_option('duel')
            await lobby.locator('#practice-button').click()
            await until(lambda: state().get('phase') == 'playing', 'practice from duel selection')
            assert_arena(state())
            await lobby.locator('#leave-button').click()
            assert await lobby.locator('#mode').input_value() == 'team'
            await lobby.wait_for_function("[...document.querySelectorAll('canvas.map-art')].every(c=>c.width===150&&c.height===130)")
            await clients[0]['context'].close()
            clients.clear()
            for i in range(8):
                page = await client()
                await page.locator('#nickname').fill(f'ArenaEdge{i}')
                await page.locator('#room-id').fill('arena8-acceptance')
                await page.locator('#mode').select_option('team')
                await page.locator('#rule-set').select_option('harmony')
                await page.locator('input[name="mapId"][value="garden"]').check()
                await page.locator('#join-button').click()
                await until(lambda: identity(i), f'client {i} joins')
            await until(lambda: state().get('phase') == 'playing', 'eight humans start')
            assert_arena(state())
            assert len(state()['players']) == 8 and not any(p['isBot'] for p in state()['players'])
            assert {team: sum(p['team'] == team for p in state()['players']) for team in ['blue', 'pink']} == {'blue': 4, 'pink': 4}
            width, height = arena(state())
            for x in range(width):
                assert f'{x},0' in state()['solid'] and f'{x},{height-1}' in state()['solid']
            for y in range(height):
                assert f'0,{y}' in state()['solid'] and f'{width-1},{y}' in state()['solid']
            mark('eight humans, 4v4 roster, 15x13 snapshot and all four border strips')
            # Move into both newly added interior bands through physical keys.
            await walk(0, (width-2, height-2))
            await walk(0, (1, height-2))
            await walk(0, (width-2, 1))
            await walk(0, (1, 1))
            mark('real actor reaches x13/y11 far corner and both new edge bands')
            # Break and collect a genuine crate with the existing drop RNG fixture.
            origin, crate, escape = crate_plan(state(), (1, 1))
            await walk(0, origin)
            await key(0, 'Space')
            await until(lambda: any((o['x'], o['y']) == origin for o in state()['orbs']), 'actual crate orb')
            for step in escape:
                await move(0, step)
            await until(lambda: any((item['x'], item['y']) == crate and item['type'] == 'dart' for item in state()['items']), 'real dart drop', 4)
            await until(lambda: not state()['waves'], 'crate waves expire')
            await walk(0, crate)
            assert player(0)['darts'] >= 1
            # A four-cell ray crosses the old y10 boundary at expanded x13.
            # Park all other actors off the ray before starting the original fuse.
            for i in [1, 3, 5, 7]:
                await walk(i, (width-3, 1))
            shooter, target = (width-2, height-6), (width-2, height-2)
            await walk(0, (shooter[0], shooter[1]-1))
            await move(0, ('ArrowUp', *shooter))
            await walk(2, target)
            assert shooter not in blast(state(), target, 3)
            rescues = player(0)['rescues']
            await key(2, 'Space')
            await until(lambda: player(2)['bubbleTicks'] > 0, 'far-edge real blast bubbles ally', 4)
            wave_cells = {(w['x'],w['y']) for w in state()['waves']}
            assert {(13,10), (13,9), (13,8), (12,11), (11,11), (10,11)} <= wave_cells, wave_cells
            mark('actual corner explosion rays reach new x13 and y11 bands beyond both old bounds')
            await until(lambda: not state()['waves'], 'far-edge waves expire')
            assert player(2)['bubbleTicks'] > 0
            await key(0, 'f')
            await until(lambda: player(2)['bubbleTicks'] == 0 and player(0)['rescues'] == rescues+1, 'far-edge real dart rescue')
            assert player(2)['alive'] and player(0)['darts'] == 0
            mark('real dart rescues across former y10 stop without extending bubble timer')
            # Carry star to a horizontal line crossing old x12, face right,
            # and pass to the first eligible allied recipient at x13.
            await walk(0, center(state()))
            await until(lambda: state()['relay']['carrierId'] == identity(0), 'central star')
            await walk(2, (width-2, 3))
            await walk(0, (width-5, 3))
            await move(0, ('ArrowRight', width-4, 3))
            await until(lambda: state()['relay']['passCooldownTicks'] == 0, 'pass cooldown')
            await key(0, 'g')
            await until(lambda: state()['relay']['carrierId'] == identity(2), 'pass crosses old x12 stop')
            assert player(0)['passes'] >= 1
            mark('real physical G pass crosses old x12 stop to x13 receiver')
            await clients[0]['page'].screenshot(path=str(ARTIFACTS / 'eight-client-far-edge.png'), full_page=True)
            # Finish through ordinary team departures, then ready and refill the
            # room as the existing classic smoke does.
            old_match = state()['matchId']
            for i in [1, 3, 5, 7]:
                await clients[i]['page'].locator('#leave-button').click()
            await until(lambda: state().get('phase') == 'finished', 'opponents leave')
            assert state()['result']['winnerTeam'] == 'blue'
            for i in [0, 2, 4, 6]:
                await clients[i]['page'].locator('#replay-button').click()
            await until(lambda: state().get('phase') == 'waiting', 'same-room rematch waits for refill')
            assert_arena(state())
            for i in [1, 3, 5, 7]:
                await clients[i]['page'].locator('#join-button').click()
            await until(lambda: state().get('phase') == 'playing' and state()['matchId'] != old_match, 'eight-client rematch')
            assert_arena(state())
            assert len(state()['players']) == 8
            assert all(p['bombsPlaced'] == 0 and p['rescues'] == 0 for p in state()['players'])
            mark('actual same-room rematch/refill retains expanded geometry and resets counters')
            # Close the eight live clients before the five native DPR contexts.
            for entry in clients:
                await entry['context'].close()
            clients.clear()
        for width, height, dpr, map_id in [(360,640,1,'garden'), (390,844,2,'lagoon'),
                (844,390,2,'candy'), (1280,720,1,'harbor'), (1920,1080,2,'festival')]:
            requested = os.environ.get('ARENA8_VIEWPORTS')
            if requested and f'{width}x{height}' not in requested.split(','):
                continue
            page = await client(width, height, dpr)
            index = len(clients)-1
            await page.locator('#settings-open').click()
            await page.locator('#render-quality').select_option('high')
            await page.locator('#text-scale').select_option('130')
            await page.locator('#settings-close').click()
            await page.locator('#rule-set').select_option('harmony')
            if os.environ.get('ARENA8_PARTY') == '1':
                await page.locator('#seriesModeSelect').select_option('party3')
            await page.locator('input[name="mapId"][value="'+map_id+'"]').check()
            await page.locator('#practice-button').click()
            await until(lambda: state(index).get('phase') == 'playing', f'{map_id} solo bot practice')
            assert_arena(state(index))
            if os.environ.get('ARENA8_PARTY') == '1':
                assert state(index)['seriesMode'] == 'party3' and state(index)['series']
            assert sum(bool(p['isBot']) for p in state(index)['players']) == 7
            initial = {p['id']: (p['x'],p['y']) for p in state(index)['players'] if p['isBot']}
            await until(lambda: any(p['isBot'] and (p['x'],p['y']) != initial[p['id']] for p in state(index)['players']), 'bots move in expanded board')
            # Match experience80's real scroll position: a desktop board may
            # already be mostly visible while its controls sit below the fold.
            if width >= 1280:
                await page.locator('#arena').evaluate('(canvas)=>canvas.scrollIntoView({block:"start"})')
            await page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            layout = await page.evaluate("""() => {
                const c=document.querySelector('#arena'), r=c.getBoundingClientRect();
                const bounds=e=>{const b=e.getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom,visible:e.checkVisibility()}};
                return {viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,scrollX,scrollY,
                    buffer:[c.width,c.height],arena:bounds(c),overflow:document.documentElement.scrollWidth>innerWidth,
                    marker:+c.dataset.essentialMarkerCssPx, teamMarker:+c.dataset.teamMarkerCssPx,
                    controls:[...document.querySelectorAll('[data-action]')].map(e=>({action:e.dataset.action,...bounds(e)}))};
            }""")
            assert layout['buffer'] == [1800,1560], layout
            assert not layout['overflow'] and layout['marker'] >= 10 and layout['teamMarker'] >= 10, layout
            board = layout['arena']
            assert abs(board['width']/board['height']-15/13) < .01, layout
            for bounds in [board] + layout['controls']:
                assert bounds['visible'] and bounds['x'] >= -1 and bounds['y'] >= -1 and bounds['right'] <= width+1 and bounds['bottom'] <= height+1, layout
            assert len(layout['controls']) == 7
            for bounds in layout['controls']:
                assert min(bounds['width'],bounds['height']) >= 44, layout
            # Actual touch input is visible in public snapshots, not a synthetic event.
            me_id = identity(index)
            await page.locator('[data-action="right"]').tap()
            await until(lambda: any(p['id'] == me_id and p['x'] == 2 for p in state(index)['players']), 'real touch movement')
            await page.screenshot(path=str(ARTIFACTS / f'{map_id}-{width}x{height}-dpr{dpr}.png'))
            # Use the actual controls to exercise focus and browser fullscreen.
            # If fullscreen is denied, production intentionally keeps focus on.
            modes = []
            for selector, mode in [('#focus-toggle', 'focus'), ('#fullscreen-toggle', 'fullscreen')]:
                await page.locator(selector).click()
                await page.wait_for_function("document.body.classList.contains('arena-focus')")
                await page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                mode_layout = await page.locator('#arena').evaluate("""e => {
                    const r=e.getBoundingClientRect(), hud=document.querySelector('#seriesHud'), h=hud.getBoundingClientRect();
                    return {missionHud:{x:h.x,y:h.y,right:h.right,bottom:h.bottom,width:h.width,height:h.height,visible:hud.checkVisibility(),text:hud.textContent},x:r.x,y:r.y,right:r.right,bottom:r.bottom,
                    width:r.width,height:r.height,buffer:[e.width,e.height],fullscreen:!!document.fullscreenElement,scrollX,scrollY,
                    marker:+e.dataset.essentialMarkerCssPx, teamMarker:+e.dataset.teamMarkerCssPx,
                    controls:[...document.querySelectorAll('[data-action]')].map(button=>{const b=button.getBoundingClientRect();
                    return {action:button.dataset.action,x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height,visible:button.checkVisibility()}})};
                }""")
                assert mode_layout['x'] >= -1 and mode_layout['y'] >= -1 and mode_layout['right'] <= width+1 and mode_layout['bottom'] <= height+1, (mode, mode_layout)
                assert mode_layout['buffer'] == [1800,1560]
                if os.environ.get('ARENA8_PARTY') == '1':
                    hud = mode_layout['missionHud']
                    assert hud['visible'] and hud['text'].strip() and hud['x'] >= -1 and hud['y'] >= -1 and hud['right'] <= width+1 and hud['bottom'] <= height+1, (mode, hud)
                assert mode_layout['marker'] >= 10 and mode_layout['teamMarker'] >= 10, (mode, mode_layout)
                assert len(mode_layout['controls']) == 7
                for bounds in mode_layout['controls']:
                    assert bounds['visible'] and min(bounds['width'],bounds['height']) >= 44, (mode, mode_layout)
                    assert bounds['x'] >= -1 and bounds['y'] >= -1 and bounds['right'] <= width+1 and bounds['bottom'] <= height+1, (mode, mode_layout)
                assert abs(mode_layout['width']/mode_layout['height']-15/13) < .01
                actual_mode = mode if mode == 'focus' else 'native-fullscreen' if mode_layout['fullscreen'] else 'focus-fallback'
                await page.screenshot(path=str(ARTIFACTS / f'{map_id}-{width}x{height}-{actual_mode}.png'))
                modes.append({'requestedMode':mode, 'mode':actual_mode, **mode_layout})
                if mode_layout['fullscreen']:
                    # Chromium's emulated Escape reaches the app's settings
                    # binding; use the real fullscreen toggle to exit natively.
                    await page.locator('#fullscreen-toggle').click()
                    await page.wait_for_function('!document.fullscreenElement')
                if await page.locator('#focus-toggle').get_attribute('aria-pressed') == 'true':
                    await page.locator('#focus-toggle').click()
            layouts.append({'mapId':map_id, 'arena':state(index)['arena'], 'seriesMode':state(index)['seriesMode'], 'displayModes':modes, **layout})
            (ARTIFACTS / 'layouts.json').write_text(json.dumps(layouts, indent=2))
            print(f'PASS: {map_id} {width}x{height} DPR{dpr}, 130% text, 7 controls, markers, focus and '+','.join(m['mode'] for m in modes), flush=True)
            await clients[index]['context'].close()
        assert layouts, 'At least one requested viewport must match the supported cases'
        assert not errors, errors
        report = {'result':'PASS', 'scope':'full' if full_run else 'viewports-only',
                  'humanPlaytesters':0, 'clients':8 if full_run else 1, 'deterministicDropFixture':True,
                  'input':'visible UI, physical keys and touch only', 'tickMs':100, 'bubbleTicks':20,
                  'pageErrors':errors, 'layouts':layouts, 'milestones':len(milestones),
                  'nativeFullscreenCases':sum(mode['mode']=='native-fullscreen' for layout in layouts for mode in layout['displayModes']),
                  'fullscreenFallbackCases':sum(mode['mode']=='focus-fallback' for layout in layouts for mode in layout['displayModes'])}
        (ARTIFACTS / 'report.json').write_text(json.dumps(report, indent=2))
        scope = 'eight clients, far edges/blast/dart/pass/rematch and ' if full_run else ''
        print(f'PASS: {scope}{len(layouts)} maps/viewports/DPR, markers and touch: {ARTIFACTS}', flush=True)
    except Exception:
        for entry in reversed(clients):
            if not entry['page'].is_closed():
                await entry['page'].screenshot(path=str(ARTIFACTS / 'failure-viewport.png'))
                break
        (ARTIFACTS / 'failure.json').write_text(json.dumps({'pageErrors':errors, 'states':[state(i) for i in range(len(clients))]}, indent=2))
        raise
    finally:
        for entry in clients:
            await entry['context'].close()


async def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    base = os.environ.get('ARENA8_BASE_URL')
    server = None
    with (ARTIFACTS / 'server.log').open('w') as log:
        try:
            if not base:
                with socket.socket() as listener:
                    listener.bind(('127.0.0.1',0))
                    port = listener.getsockname()[1]
                env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', ALLOW_DEV_GUESTS='true',
                           SUPABASE_URL='', SUPABASE_ANON_KEY='', SUPABASE_SERVICE_ROLE_KEY='')
                server = subprocess.Popen(['node','--import','./test/fixtures/dart-drops.mjs','src/index.js'],
                                          cwd=ROOT/'Server', env=env, stdout=log, stderr=log)
                base = f'http://127.0.0.1:{port}'
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base+'/health', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    await asyncio.sleep(.05)
            else:
                raise AssertionError('Server did not become healthy')
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(executable_path=os.environ.get('CHROMIUM',shutil.which('chromium')), args=['--no-sandbox'])
                try:
                    await acceptance(browser, base)
                finally:
                    await browser.close()
        finally:
            if server:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == '__main__':
    asyncio.run(main())
