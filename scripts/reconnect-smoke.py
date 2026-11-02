"""Real Chromium recovery, reload, expiry and explicit-leave acceptance checks."""
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


async def until(predicate, timeout=10):
    end = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > end:
            raise AssertionError('Timed out waiting for recovery state')
        await asyncio.sleep(.025)


async def main():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', ALLOW_DEV_GUESTS='true',
               SUPABASE_URL='', SUPABASE_ANON_KEY='', SUPABASE_SERVICE_ROLE_KEY='')
    with tempfile.TemporaryFile() as log:
        server = subprocess.Popen(['node', 'src/index.js'], cwd=ROOT / 'Server', env=env, stdout=log, stderr=log)
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
                errors = []
                try:
                    async def client(mobile=False):
                        context = await browser.new_context(viewport={'width': 390, 'height': 844} if mobile else {'width': 1440, 'height': 1000}, is_mobile=mobile, has_touch=mobile)
                        await context.add_init_script('''
                            window.__testSockets = [];
                            const NativeSocket = WebSocket;
                            window.WebSocket = class extends NativeSocket {
                                constructor(...args) { super(...args); window.__testSockets.push(this); }
                            };
                        ''')
                        page = await context.new_page()
                        result = {'page': page, 'context': context, 'messages': []}
                        page.on('pageerror', lambda e: errors.append(str(e)))
                        page.on('websocket', lambda ws: ws.on('framereceived', lambda frame: result['messages'].append(json.loads(frame))))
                        await page.goto(base)
                        return result

                    def state(c):
                        return next((m for m in reversed(c['messages']) if m.get('type') == 'state'), {})

                    def joins(c):
                        return [m for m in c['messages'] if m.get('type') == 'joined']

                    async def join(c, name):
                        page = c['page']
                        await page.locator('#mode').select_option('duel')
                        await page.locator('#room-id').fill('recovery-browser')
                        await page.locator('#nickname').fill(name)
                        await page.locator('input[name="mapId"][value="lagoon"]').check()
                        await page.locator('input[name="characterId"][value="nori"]').check()
                        await page.locator('input[name="skinId"][value="mint"]').check()
                        await page.locator('#join-button').click()
                        await until(lambda: joins(c))

                    first, peer = await client(), await client()
                    await join(first, 'Returner')
                    # Waiting-room reload restores a reserved participant, not a duplicate.
                    initial = joins(first)[0]
                    assert initial.get('resumeToken') and initial['reconnectGraceMs'] == 30000
                    await first['page'].reload()
                    await until(lambda: len(joins(first)) == 2)
                    assert joins(first)[-1]['resumed'] and joins(first)[-1]['playerId'] == initial['playerId']
                    await join(peer, 'Teammate')
                    await until(lambda: state(peer).get('phase') == 'playing')
                    match_id = state(peer)['matchId']
                    player_id = initial['playerId']

                    def me():
                        return next((p for p in state(peer).get('players', []) if p['id'] == player_id), {})

                    page = first['page']
                    # Place a real bomb and leave its blast path. Progress must survive recovery.
                    await page.locator('#arena').focus()
                    await page.keyboard.press('Space')
                    await until(lambda: me().get('bombsPlaced') == 1)
                    for key, x, y in [('ArrowUp', 1, 2), ('ArrowUp', 1, 3), ('ArrowRight', 2, 3)]:
                        await page.keyboard.press(key)
                        await until(lambda: me().get('x') == x and me().get('y') == y)
                    await until(lambda: me().get('score', 0) > 0, timeout=4)
                    before = {key: me()[key] for key in ['id', 'characterId', 'skinId', 'x', 'y', 'score', 'bombsPlaced']}
                    await first['context'].set_offline(True)
                    await page.evaluate('window.__testSockets.at(-1).close()')
                    await until(lambda: me().get('connected') is False)
                    await page.locator('#arena[data-connection="reconnecting"]').wait_for()
                    assert me()['reconnectRemainingMs'] > 0 and state(peer)['phase'] == 'playing'
                    await page.locator('#arena').focus()
                    await page.keyboard.press('ArrowRight')
                    await page.keyboard.press('Space')
                    await asyncio.sleep(.5)
                    assert all(me()[key] == value for key, value in before.items())
                    assert await page.locator('#leave-button').is_visible()
                    assert '복' in await peer['page'].locator('#roster').inner_text()
                    await page.screenshot(path='/tmp/poppop-reconnect-offline.png', full_page=True)
                    await first['context'].set_offline(False)
                    await until(lambda: len(joins(first)) == 3 and me().get('connected') is True)
                    await page.locator('#arena[data-connection="connected"]').wait_for()
                    assert joins(first)[-1]['playerId'] == player_id
                    assert state(peer)['matchId'] == match_id and len(state(peer)['players']) == 2
                    assert all(me()[key] == value for key, value in before.items())
                    assert me()['reconnectRemainingMs'] == 0
                    await page.locator('#arena').focus()
                    await page.keyboard.press('ArrowRight')
                    await until(lambda: me().get('x') == 3)
                    await page.reload()
                    await until(lambda: len(joins(first)) == 4)
                    await page.locator('#arena[data-connection="connected"]').wait_for()
                    assert joins(first)[-1]['playerId'] == player_id and (me()['x'], me()['y']) == (3, 3)
                    assert state(peer)['matchId'] == match_id
                    await page.locator('#invite-button').click()
                    assert initial['resumeToken'] not in await page.locator('#invite-url').input_value()
                    public_messages = [m for m in peer['messages'] if m.get('type') == 'state']
                    assert initial['resumeToken'] not in json.dumps(public_messages)
                    await page.screenshot(path='/tmp/poppop-reconnect-restored.png', full_page=True)
                    print('PASS: waiting/play reload, offline recovery preserves identity/match/cosmetics/progress, no offline input or public token leak', flush=True)

                    # Exercise the real 30-second reservation, then reject its stale reload.
                    await first['context'].set_offline(True)
                    await page.evaluate('window.__testSockets.at(-1).close()')
                    await until(lambda: me().get('connected') is False)
                    await until(lambda: state(peer).get('phase') == 'finished', timeout=35)
                    assert not me() and state(peer)['matchId'] == match_id
                    await first['context'].set_offline(False)
                    # Simulate a saved tab snapshot that outlived the server reservation.
                    await page.evaluate("record => sessionStorage.setItem('popPop:resume:v1:/', JSON.stringify(record))", {**initial, 'practice': False})
                    await page.reload()
                    await page.locator('#selection-fields:not([disabled])').wait_for()
                    await asyncio.sleep(.7)
                    assert len(joins(first)) == 4
                    assert await page.locator('#arena').get_attribute('data-phase') == 'preview'
                    print('PASS: real grace expiry finalizes departure and stale recovery cannot create a new participant', flush=True)

                    mobile = await client(mobile=True)
                    mp = mobile['page']
                    await mp.locator('#rule-set').select_option('relay')
                    await mp.locator('#practice-button').tap()
                    await until(lambda: state(mobile).get('phase') == 'playing')
                    mid = joins(mobile)[0]['playerId']
                    mroom = state(mobile)['roomId']
                    await mobile['context'].set_offline(True)
                    await mp.evaluate('window.__testSockets.at(-1).close()')
                    await mp.locator('#arena[data-connection="reconnecting"]').wait_for()
                    assert await mp.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    await mp.screenshot(path='/tmp/poppop-reconnect-mobile.png', full_page=True)
                    for selector in ['#leave-button', '[data-action="down"]', '[data-action="place_orb"]']:
                        box = await mp.locator(selector).bounding_box()
                        assert box and box['y'] + box['height'] <= 844, (selector, box)
                    await mobile['context'].set_offline(False)
                    await until(lambda: len(joins(mobile)) == 2)
                    assert joins(mobile)[-1]['playerId'] == mid and state(mobile)['roomId'] == mroom
                    await mp.locator('#leave-button').tap()
                    await mp.reload()
                    await asyncio.sleep(.7)
                    assert len(joins(mobile)) == 2 and await mp.locator('#arena').get_attribute('data-phase') == 'preview'
                    assert not errors, errors
                    print('PASS: mobile relay-practice recovery, visible leave/controls, explicit leave prevents automatic rejoin, no page errors', flush=True)
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
