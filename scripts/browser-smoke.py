"""Real eight-browser POC smoke test. Requires Python Playwright and Chromium.
Run from repo root: python3 scripts/browser-smoke.py
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import urllib.request
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]

async def until(predicate, timeout=8):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError('Timed out waiting for game state')
        await asyncio.sleep(.025)

async def main():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', ALLOW_DEV_GUESTS='true',
               SUPABASE_URL='', SUPABASE_ANON_KEY='', SUPABASE_SERVICE_ROLE_KEY='')
    with tempfile.TemporaryFile() as log:
        server = subprocess.Popen(['node', '--import', './test/fixtures/dart-drops.mjs', 'src/index.js'], cwd=ROOT / 'Server', env=env, stdout=log, stderr=log)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(80):
                try:
                    with urllib.request.urlopen(base + '/health', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    await asyncio.sleep(.05)
            else:
                raise AssertionError('Server failed to start')
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
                errors, clients = [], []
                try:
                    for i in range(8):
                        context = await browser.new_context(viewport={'width': 1440, 'height': 960})
                        page = await context.new_page()
                        client = {'page': page, 'messages': [], 'context': context}
                        def record(frame, c=client):
                            if isinstance(frame, str):
                                c['messages'].append(json.loads(frame))
                        page.on('websocket', lambda ws, cb=record: ws.on('framereceived', cb))
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        await page.goto(base)
                        await page.locator('#nickname').fill(f'Player{i+1}')
                        await page.locator('#room-id').fill('browser-poc')
                        await page.locator('#mode').select_option('team')
                        await page.locator(f'input[name="characterId"][value="{["momo","nori","bibi","toto"][i%4]}"]').check()
                        await page.locator(f'input[name="skinId"][value="{["classic","sunset","mint"][i%3]}"]').check()
                        await page.locator('input[name="mapId"][value="garden"]').check()
                        await page.locator('#join-button').click()
                        await until(lambda: any(m.get('type') == 'joined' for m in client['messages']))
                        client['id'] = next(m['playerId'] for m in client['messages'] if m.get('type') == 'joined')
                        clients.append(client)
                    def latest():
                        return next((m for m in reversed(clients[0]['messages']) if m.get('type') == 'state'), {})
                    def player(i):
                        return next((p for p in latest().get('players', []) if p['id'] == clients[i]['id']), {})
                    await until(lambda: latest().get('phase') == 'playing')
                    assert len(latest()['players']) == 8
                    assert sum(p['team'] == 'blue' for p in latest()['players']) == 4
                    assert sum(p['team'] == 'pink' for p in latest()['players']) == 4
                    for i in range(8):
                        assert player(i)['characterId'] == ['momo','nori','bibi','toto'][i%4]
                        assert player(i)['skinId'] == ['classic','sunset','mint'][i%3]
                    await clients[0]['page'].screenshot(path='/tmp/poppop-poc-playing.png', full_page=True)
                    ninth = await browser.new_page()
                    await ninth.goto(base)
                    await ninth.locator('#room-id').fill('browser-poc')
                    await ninth.locator('#join-button').click()
                    await ninth.locator('#status.error').wait_for()
                    assert await ninth.locator('#arena').get_attribute('data-phase') == 'preview'
                    await ninth.close()
                    async def move(i, key, x, y):
                        await clients[i]['page'].locator('#arena').focus()
                        await clients[i]['page'].keyboard.press(key)
                        await until(lambda: player(i).get('x') == x and player(i).get('y') == y)
                    # Real keyboard controls, bomb placement and allied rescue.
                    await clients[0]['page'].locator('#arena').focus()
                    await clients[0]['page'].keyboard.press('Space')
                    await until(lambda: len(latest().get('orbs', [])) == 1)
                    await move(0, 'ArrowRight', 2, 1)
                    await move(0, 'ArrowRight', 3, 1)
                    await move(0, 'ArrowUp', 3, 2)
                    await move(2, 'ArrowDown', 1, 2)
                    await until(lambda: player(2).get('bubbleTicks', 0) > 0, timeout=4)
                    await until(lambda: not latest().get('waves'))
                    await move(0, 'ArrowDown', 3, 1)
                    await move(0, 'ArrowLeft', 2, 1)
                    await move(0, 'ArrowLeft', 1, 1)
                    assert player(2)['bubbleTicks'] == 0 and player(2)['alive']
                    # Break a real crate, collect its deterministic dart drop, then rescue from range.
                    await move(0, 'ArrowRight', 2, 1)
                    await move(0, 'ArrowRight', 3, 1)
                    await clients[0]['page'].keyboard.press('Space')
                    await until(lambda: any(o['x'] == 3 and o['y'] == 1 for o in latest().get('orbs', [])))
                    await move(0, 'ArrowLeft', 2, 1)
                    await move(0, 'ArrowLeft', 1, 1)
                    await move(0, 'ArrowUp', 1, 2)
                    await until(lambda: any(i['x'] == 5 and i['y'] == 1 and i['type'] == 'dart' for i in latest().get('items', [])), timeout=4)
                    await until(lambda: not latest().get('waves'))
                    await move(0, 'ArrowDown', 1, 1)
                    for x in [2, 3, 4, 5]:
                        await move(0, 'ArrowRight', x, 1)
                    assert player(0)['darts'] == 1
                    await move(0, 'ArrowUp', 5, 2)
                    await move(2, 'ArrowDown', 1, 1)
                    await clients[2]['page'].keyboard.press('Space')
                    await until(lambda: player(2).get('bubbleTicks', 0) > 0, timeout=4)
                    await until(lambda: not latest().get('waves'))
                    await move(0, 'ArrowDown', 5, 1)
                    await move(0, 'ArrowLeft', 4, 1)
                    await move(0, 'ArrowLeft', 3, 1)
                    assert player(2)['bubbleTicks'] > 0
                    await clients[0]['page'].keyboard.press('f')
                    await until(lambda: player(0)['darts'] == 0 and player(2)['bubbleTicks'] == 0)
                    assert player(2)['alive'] and player(0)['score'] >= 115
                    await clients[0]['page'].screenshot(path='/tmp/poppop-service-dart.png', full_page=True)
                    # Leaving one team ends the game for the other team.
                    for i in [0, 2, 4, 6]:
                        await clients[i]['page'].locator('#leave-button').click()
                    def pink_state():
                        return next((m for m in reversed(clients[1]['messages']) if m.get('type') == 'state'), {})
                    await until(lambda: pink_state().get('phase') == 'finished')
                    assert pink_state()['result']['winnerTeam'] == 'pink'
                    await clients[1]['page'].locator('#replay-button').wait_for(state='visible')
                    await clients[1]['page'].locator('#scoreboard-rows .score-row').first.wait_for()
                    await clients[1]['page'].locator('#leaderboard-rows tr').first.wait_for()
                    ranking = await (await clients[1]['page'].request.get(base + '/api/leaderboard')).json()
                    assert ranking['source'] == 'demo' and len(ranking['entries']) == 8
                    assert any(e['score'] > 0 and e['tier'] == 'Bronze' for e in ranking['entries'])
                    await clients[1]['page'].screenshot(path='/tmp/poppop-poc-result.png', full_page=True)
                    old_match = pink_state()['matchId']
                    pink_ids = {p['id'] for p in pink_state()['players']}
                    for i in [1, 3, 5, 7]:
                        await clients[i]['page'].locator('#replay-button').click()
                    await until(lambda: pink_state().get('phase') == 'waiting')
                    assert {p['id'] for p in pink_state()['players']} == pink_ids
                    assert pink_state()['matchId'] is None and len(pink_state()['players']) == 4
                    for i in [0, 2, 4, 6]:
                        await clients[i]['page'].locator('#join-button').click()
                    await until(lambda: pink_state().get('phase') == 'playing' and pink_state().get('matchId') != old_match)
                    assert len(pink_state()['players']) == 8
                    assert all(p['score'] == 0 and p['bombsPlaced'] == 0 for p in pink_state()['players'])
                    assert {p['id'] for p in pink_state()['players'] if p['team'] == 'pink'} == pink_ids
                    await clients[1]['page'].screenshot(path='/tmp/poppop-poc-rematch.png', full_page=True)
                    # Small-screen layout must remain within viewport.
                    mobile = await browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
                    page = await mobile.new_page()
                    await page.goto(base)
                    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile overflow'
                    await page.screenshot(path='/tmp/poppop-poc-mobile.png', full_page=True)
                    mobile_messages = []
                    page.on('websocket', lambda ws: ws.on('framereceived', lambda data: mobile_messages.append(json.loads(data))))
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    await page.locator('#mode').select_option('duel')
                    await page.locator('#item-mode').uncheck()
                    await page.locator('#room-id').fill('mobile-poc')
                    await page.locator('input[name="mapId"][value="lagoon"]').check()
                    await page.locator('#join-button').click()
                    await until(lambda: any(m.get('type') == 'joined' for m in mobile_messages))
                    mobile_id = next(m['playerId'] for m in mobile_messages if m.get('type') == 'joined')
                    other = await browser.new_page()
                    await other.goto(base)
                    await other.locator('#mode').select_option('duel')
                    await other.locator('#item-mode').uncheck()
                    await other.locator('#room-id').fill('mobile-poc')
                    await other.locator('input[name="mapId"][value="lagoon"]').check()
                    await other.locator('#join-button').click()
                    def mobile_state():
                        return next((m for m in reversed(mobile_messages) if m.get('type') == 'state'), {})
                    await until(lambda: mobile_state().get('phase') == 'playing')
                    assert mobile_state()['mapId'] == 'lagoon' and mobile_state()['itemMode'] is False
                    await page.locator('[data-action="right"]').tap()
                    await until(lambda: any(p['id'] == mobile_id and p['x'] == 2 for p in mobile_state()['players']))
                    await page.locator('[data-action="place_orb"]').tap()
                    await until(lambda: len(mobile_state().get('orbs', [])) == 1)
                    await page.screenshot(path='/tmp/poppop-poc-mobile-game.png', full_page=True)
                    assert not errors, errors
                    print('PASS: 8 browser players, 4v4 roster, cosmetics, keyboard, bomb, rescue, real dart pickup/rescue, scores/ranks, item-mode off, team result, partial same-room rematch/refill, room capacity, mobile layout/touch and lagoon map; no page errors')
                finally:
                    await browser.close()
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill(); server.wait()

if __name__ == '__main__':
    asyncio.run(main())
