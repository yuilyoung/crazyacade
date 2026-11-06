"""Eight independent Chromium players exercise real Harmony UI/keys and download a result PNG.

No state injection, socket sending from page.evaluate, or clock overrides. Public
WebSocket frames are observed only; all gameplay uses the visible UI and physical keys.
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import urllib.parse
import urllib.request
from playwright.async_api import async_playwright
from arena_smoke_helpers import arena, assert_arena, bases, center, rescue_plan

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get('HARMONY_ARTIFACTS', '/tmp/poppop-harmony80'))
DIRECTIONS = [('ArrowUp', 0, 1), ('ArrowRight', 1, 0), ('ArrowDown', 0, -1), ('ArrowLeft', -1, 0)]

async def until(predicate, label, timeout=10):
    end = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > end:
            raise AssertionError(f'Timed out: {label}')
        await asyncio.sleep(.025)

async def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', ALLOW_DEV_GUESTS='true',
               SUPABASE_URL='', SUPABASE_ANON_KEY='', SUPABASE_SERVICE_ROLE_KEY='')
    with (ARTIFACTS / 'server.log').open('w') as server_log:
        server = subprocess.Popen(['node', 'src/index.js'], cwd=ROOT / 'Server', env=env,
                                  stdout=server_log, stderr=server_log)
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
                clients, errors, milestones = [], [], []
                try:
                    async def new_client():
                        context = await browser.new_context(viewport={'width': 1440, 'height': 1100}, accept_downloads=True)
                        page = await context.new_page()
                        client = {'page': page, 'messages': []}
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.on('websocket', lambda ws: ws.on('framereceived', lambda frame: client['messages'].append(json.loads(frame))))
                        clients.append(client)
                        return page

                    page = await new_client()
                    await page.goto(base)
                    await page.locator('#mode').select_option('team')
                    await page.locator('#rule-set').select_option('harmony')
                    assert '7점' in await page.locator('#rule-help').inner_text()
                    await page.locator('input[name="mapId"][value="harbor"]').check()
                    assert await page.locator('input[name="mapId"][value="harbor"]').is_checked()
                    await page.locator('input[name="mapId"][value="festival"]').check()
                    await page.locator('#orb-skin').select_option('star')
                    await page.locator('#invite-button').click()
                    invite = await page.locator('#invite-url').input_value()
                    query = urllib.parse.parse_qs(urllib.parse.urlparse(invite).query)
                    assert query['rules'] == ['harmony'] and query['map'] == ['festival']
                    await page.locator('#nickname').fill('HarmonyMe')
                    await page.locator('#join-button').click()
                    for i in range(1, 8):
                        other = await new_client()
                        await other.goto(invite)
                        assert await other.locator('#rule-set').input_value() == 'harmony'
                        assert await other.locator('input[name="mapId"][value="festival"]').is_checked()
                        await other.locator('#nickname').fill(f'Friend{i}')
                        await other.locator('#join-button').click()

                    def state(i=0):
                        return next((m for m in reversed(clients[i]['messages']) if m.get('type') == 'state'), {})
                    def identity(i):
                        return next((m['playerId'] for m in clients[i]['messages'] if m.get('type') == 'joined'), None)
                    def player(i):
                        return next((p for p in state().get('players', []) if p['id'] == identity(i)), {})
                    def record(label):
                        current = state()
                        milestones.append({'label': label, 'tick': current['tick'], 'relay': current['relay'],
                                           'players': [{key: p.get(key) for key in ['name', 'team', 'x', 'y', 'passes', 'interceptions', 'rescues', 'deliveries']} for p in current['players']]})
                        print(f'PASS: {label} (tick {current["tick"]})', flush=True)
                    async def key(i, value):
                        await clients[i]['page'].locator('#arena').focus()
                        await clients[i]['page'].keyboard.press(value)
                    async def move(i, direction, x, y):
                        await key(i, direction)
                        await until(lambda: (player(i).get('x'), player(i).get('y')) == (x, y), f'player {i} move {direction} to {x},{y}')
                    async def walk(i, x, y):
                        for _ in range(99):
                            current = player(i)
                            if (current['x'], current['y']) == (x, y):
                                return
                            blocked = set(state()['solid'] + state()['soft']) | {f'{o["x"]},{o["y"]}' for o in state()['orbs']}
                            queue, seen, action = [(current['x'], current['y'], None)], {(current['x'], current['y'])}, None
                            for qx, qy, first in queue:
                                if action:
                                    break
                                for direction, dx, dy in DIRECTIONS:
                                    nx, ny = qx + dx, qy + dy
                                    if not (0 < nx < arena(state())[0] - 1 and 0 < ny < arena(state())[1] - 1) or (nx, ny) in seen or f'{nx},{ny}' in blocked:
                                        continue
                                    seen.add((nx, ny))
                                    chosen = first or (direction, current['x'] + dx, current['y'] + dy)
                                    queue.append((nx, ny, chosen))
                                    if (nx, ny) == (x, y):
                                        action = chosen
                                        break
                            assert action, f'No route for {i}: {current["x"]},{current["y"]} -> {x},{y}'
                            await move(i, *action)
                        raise AssertionError('Too many route steps')
                    async def pass_to(i, target):
                        await until(lambda: state(i)['relay']['passCooldownTicks'] == 0, 'pass cooldown')
                        await clients[i]['page'].wait_for_function("!document.querySelector('#pass-button').disabled", timeout=3000)
                        assert not await clients[i]['page'].locator('#pass-button').is_disabled()
                        await key(i, 'g')
                        await until(lambda: state()['relay']['carrierId'] == identity(target), f'G pass {i} -> {target}')

                    await until(lambda: state().get('phase') == 'playing', 'eight humans start')
                    assert len(state()['players']) == 8 and not any(p['isBot'] for p in state()['players'])
                    assert state()['ranked'] is False and state()['relay']['goal'] == 7
                    assert '하모니' in await page.locator('#match-kind').inner_text()
                    assert '목표 7점' in await page.locator('#relay-status').inner_text()
                    assert_arena(state())
                    cx, cy = center(state())
                    # Join order assigns blue slots 0, 2, 4, 6 and pink slots 1, 3, 5, 7.
                    await walk(0, cx, cy)
                    await until(lambda: state()['relay']['carrierId'] == identity(0), 'central star pickup')
                    await walk(2, 4, cy)
                    await walk(4, 8, cy)
                    await walk(1, 10, cy)
                    await walk(0, 6, cy)
                    await walk(0, 7, cy)
                    await pass_to(0, 4)
                    assert state()['relay']['charges']['passes'] == 1
                    await walk(0, cx, cy + 1)
                    await walk(4, 7, cy)
                    await pass_to(4, 2)
                    assert state()['relay']['charges']['passes'] == 2
                    await walk(2, 5, cy)
                    await pass_to(2, 4)
                    assert state()['relay']['charges']['passes'] == 2
                    record('physical G key passes reach distinct allies and cap charge at two')
                    await page.screenshot(path=str(ARTIFACTS / 'charged.png'), full_page=True)
                    await walk(4, 8, cy)
                    await pass_to(4, 1)
                    assert state()['relay']['charges']['total'] == 0 and player(1)['interceptions'] == 1
                    record('opposing first receiver intercepts and clears all charge')
                    await page.screenshot(path=str(ARTIFACTS / 'interception.png'), full_page=True)
                    await walk(1, 9, cy)
                    await pass_to(1, 4)
                    assert player(4)['interceptions'] == 1 and state()['relay']['charges']['total'] == 0
                    # An actual bomb bubbles an ally while their team holds the star elsewhere.
                    victim = (2, cy)
                    stage, rescue_steps = rescue_plan(state(), victim)
                    await walk(2, *victim)
                    await walk(0, *stage)
                    await key(2, 'Space')
                    await until(lambda: player(2)['bubbleTicks'] > 0, 'real bomb traps teammate', timeout=4)
                    await until(lambda: not state()['waves'], 'bomb waves expire')
                    assert player(2)['bubbleTicks'] > 0
                    for step in rescue_steps:
                        await move(0, *step)
                    await until(lambda: player(2)['bubbleTicks'] == 0 and player(0)['rescues'] == 1, 'real adjacent rescue')
                    assert state()['relay']['charges']['rescue'] == 1
                    # Face left through ordinary movement, then pass to two distinct teammates.
                    await walk(0, 4, cy)
                    await walk(0, 3, cy)
                    await walk(2, 2, cy)
                    await walk(4, 9, cy)
                    await walk(4, 8, cy)
                    await pass_to(4, 0)
                    await pass_to(0, 2)
                    assert state()['relay']['charges'] == {'passes': 2, 'rescue': 1, 'total': 3}
                    assert '4점' in await clients[2]['page'].locator('#relay-status').inner_text()
                    record('real bomb and adjacent rescue combine with two passes for four-point delivery')
                    await clients[2]['page'].screenshot(path=str(ARTIFACTS / 'rescue-four-points.png'), full_page=True)
                    await walk(2, 1, cy)
                    await until(lambda: state()['relay']['scores']['blue'] == 4, 'first four-point delivery')
                    assert state()['relay']['charges']['total'] == 0
                    await walk(0, cx, cy)
                    await until(lambda: state()['relay']['carrierId'] == identity(0), 'five-second star respawn', timeout=7)
                    await pass_to(0, 4)
                    await pass_to(4, 0)
                    assert state()['relay']['charges']['passes'] == 2
                    await walk(0, 1, cy)
                    await until(lambda: state()['phase'] == 'finished', 'seven-point finish')
                    result = state()['result']
                    assert result['reason'] == 'harmony_goal' and result['winnerTeam'] == 'blue'
                    assert result['relayScores'] == {'blue': 7, 'pink': 0}
                    own = next(p for p in result['scoreboard'] if p['id'] == identity(0))
                    assert own['rescues'] == 1 and own['passes'] >= 2 and own['deliveries'] == 1
                    await page.locator('#result-saving[data-status="unranked"]').wait_for()
                    leaderboard = await (await page.request.get(base + '/api/leaderboard')).json()
                    assert leaderboard['entries'] == []
                    await page.screenshot(path=str(ARTIFACTS / 'result.png'), full_page=True)
                    async with page.expect_download() as download_info:
                        await page.locator('#download-result-button').click()
                    download = await download_info.value
                    assert not await download.failure()
                    destination = ARTIFACTS / 'my-result.png'
                    await download.save_as(destination)
                    data = destination.read_bytes()
                    assert data[:8] == b'\x89PNG\r\n\x1a\n'
                    dimensions = struct.unpack('>II', data[16:24])
                    assert dimensions == (1200, 630), dimensions
                    record('seven-point finish stays unranked and user click downloads own 1200x630 PNG')
                    # A ninth independent browser verifies the second new map through the real lobby.
                    harbor = await new_client()
                    await harbor.goto(base)
                    await harbor.locator('#mode').select_option('team')
                    await harbor.locator('#rule-set').select_option('harmony')
                    await harbor.locator('input[name="mapId"][value="harbor"]').check()
                    await harbor.locator('#practice-button').click()
                    await until(lambda: state(8).get('phase') == 'playing', 'harbor practice starts')
                    assert_arena(state(8))
                    assert state(8)['mapId'] == 'harbor' and state(8)['mapFeatures']['type'] == 'tidegates'
                    assert state(8)['ruleSet'] == 'harmony' and state(8)['ranked'] is False
                    await harbor.screenshot(path=str(ARTIFACTS / 'harbor.png'), full_page=True)
                    assert not errors, errors
                    (ARTIFACTS / 'milestones.json').write_text(json.dumps({'milestones': milestones, 'pageErrors': errors, 'resultPng': str(destination)}, ensure_ascii=False, indent=2))
                    print(f'PASS: harbor lobby/map feature, no browser errors; evidence: {ARTIFACTS}', flush=True)
                except Exception:
                    for i, client in enumerate(clients[:1]):
                        await client['page'].screenshot(path=str(ARTIFACTS / f'failure-{i}.png'), full_page=True)
                        public_states = [m for m in client['messages'] if m.get('type') == 'state']
                        (ARTIFACTS / 'failure-state.json').write_text(json.dumps(public_states[-1:] + [{'pageErrors': errors}], ensure_ascii=False, indent=2))
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
    asyncio.run(main())
