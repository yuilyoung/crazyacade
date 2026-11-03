"""Actual Chromium acceptance: friend + AI, guided training and accessible inputs.

Uses normal WebSocket inputs and real timers; never patches game state.
Requires Python Playwright and Chromium.
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.request
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]


async def until(predicate, timeout=10):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError('Timed out waiting for playability state')
        await asyncio.sleep(.025)


class Client:
    def __init__(self, page, errors):
        self.page, self.messages = page, []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('websocket', lambda ws: ws.on('framereceived', self.record))

    def record(self, frame):
        if isinstance(frame, str):
            self.messages.append(json.loads(frame))

    def state(self):
        return next((m for m in reversed(self.messages) if m.get('type') == 'state'), {})

    def joined(self):
        return next((m for m in reversed(self.messages) if m.get('type') == 'joined'), {})

    def me(self):
        return next((p for p in self.state().get('players', []) if p['id'] == self.joined().get('playerId')), {})

    async def move(self, key, x, y):
        await self.page.locator('#arena').focus()
        await self.page.keyboard.press(key)
        await until(lambda: self.me().get('x') == x and self.me().get('y') == y)

    async def stage(self, stage):
        await until(lambda: (self.state().get('training') or {}).get('stage') == stage)

    async def ready(self, stage):
        await self.stage(stage)
        await until(lambda: (self.state().get('training') or {}).get('status') == 'ready')
        await self.page.locator('#training-ready-button').click()
        await until(lambda: (self.state().get('training') or {}).get('status') == 'active')
        await self.page.locator('#arena').focus()

    async def bomb_lesson(self, stage):
        await self.ready(stage)
        await self.page.keyboard.press('Space')
        await until(lambda: len(self.state().get('orbs', [])) > 0)
        await self.move('ArrowUp', 1, 2)
        await self.move('ArrowUp', 1, 3)
        await self.move('ArrowRight', 2, 3)
        if stage == 'escape':
            await self.stage('item')
            return
        await until(lambda: any(i.get('type') == 'wave' for i in self.state().get('items', [])))
        await until(lambda: not self.state().get('waves'))
        await self.move('ArrowLeft', 1, 3)
        await self.move('ArrowDown', 1, 2)
        await self.move('ArrowDown', 1, 1)
        await self.move('ArrowRight', 2, 1)
        await self.page.keyboard.press('ArrowRight')
        await self.stage('rescue')


async def train(client, outcome='replay', fail=True):
    page = client.page
    await page.locator('#quick-training').click()
    await client.stage('escape')
    assert client.state()['practice'] is True and len(client.state()['players']) == 8
    if fail:
        # Deliberately miss the first escape: the real blast bubbles and eliminates us.
        await client.ready('escape')
        await page.keyboard.press('Space')
        await until(lambda: (client.state().get('training') or {}).get('status') == 'retrying')
        await until(lambda: (client.state().get('training') or {}).get('status') == 'ready' and client.me().get('alive'))
        assert client.state()['training']['attempts'] >= 1
        assert client.state()['training']['stage'] == 'escape'
    # Complete escape with actual keyboard input, then break and collect a real item.
    for stage in ['escape', 'item']:
        await client.bomb_lesson(stage)
    # The rescue timer stays at ten seconds while a novice reads the ready panel.
    assert client.state()['training']['status'] == 'ready'
    target = lambda: next(p for p in client.state()['players'] if p['x'] == 3 and p['y'] == 1)
    assert target()['bubbleTicks'] == 100
    await asyncio.sleep(1.2)
    assert target()['bubbleTicks'] == 100
    await client.ready('rescue')
    await page.keyboard.press('ArrowRight')
    await client.stage('dart')
    assert '구출' in await page.locator('#event-peek').inner_text()
    await client.ready('dart')
    await page.keyboard.press('f')
    await until(lambda: client.state().get('phase') == 'finished')
    assert client.state()['result']['reason'] == 'training_complete'
    assert client.state()['resultSaving']['status'] == 'unranked'
    assert client.state()['training']['completed'] == 4
    assert client.me()['rescues'] >= 2 and client.me()['itemsCollected'] >= 1
    await page.locator('#result-saving[data-status="unranked"]').wait_for()
    feed = await page.locator('#event-feed').inner_text()
    assert all(word in feed for word in ['아이템 습득', '구출', '훈련 완료']), feed
    assert await page.locator('#music-toggle').get_attribute('aria-pressed') == 'false'
    assert await page.locator('#sound-toggle').get_attribute('aria-pressed') == 'false'
    assert '완료' in await page.locator('#training-status').inner_text()
    await page.screenshot(path='/tmp/poppop-playability-training.png', full_page=True)
    room = client.state()['roomId']
    if outcome == 'friends':
        await page.locator('#training-friends-button').click()
        assert await page.locator('#human-slots').input_value() == '2'
        assert await page.locator('#mode').input_value() == 'team'
        assert await page.locator('#arena').get_attribute('data-phase') == 'preview'
        assert await page.locator('input[name="mapId"][value="candy"]').is_checked()
        await page.screenshot(path='/tmp/poppop-playability-handoff.png',full_page=True)
        return
    if outcome == 'practice':
        await page.locator('#training-practice-button').click()
        await until(lambda: client.state().get('phase') == 'playing' and client.state().get('roomId') != room)
        assert client.state()['practice'] is True and client.state()['training'] is None
        assert client.state()['mapId'] == 'candy'
        await page.locator('#leave-button').click()
        return
    await page.locator('#replay-button').click()
    await until(lambda: client.state().get('phase') == 'playing' and client.state().get('roomId') != room)
    assert client.state()['training']['stage'] == 'escape'
    assert client.state()['training']['completed'] == 0
    assert client.state()['training']['status'] == 'ready'
    await page.locator('#leave-button').click()


async def preferences(client):
    page = client.page
    await page.locator('#play-settings-toggle').click()
    await page.locator('[data-binding="up"]').click()
    await page.keyboard.press('i')
    assert await page.locator('[data-binding="up"]').inner_text() == 'I'
    await page.locator('[data-binding="down"]').click()
    await page.keyboard.press('i')
    assert '중복' in await page.locator('#binding-status').inner_text() or '사용' in await page.locator('#binding-status').inner_text()
    await page.keyboard.press('Escape')
    assert await page.locator('[data-binding="down"]').inner_text() == 'S'
    await page.locator('#contrast-toggle').click()
    await page.locator('#left-hand-toggle').click()
    await page.reload()
    await page.locator('#play-settings-toggle').click()
    assert await page.locator('[data-binding="up"]').inner_text() == 'I'
    assert await page.locator('#contrast-toggle').get_attribute('aria-pressed') == 'true'
    assert await page.locator('#left-hand-toggle').get_attribute('aria-pressed') == 'true'
    await page.locator('#training-button').click()
    await client.stage('escape')
    await client.ready('escape')
    ratios = await page.evaluate("""() => {
      const rgb = value => (value.match(/[\\d.]+/g) || []).map(Number);
      const light = color => color.slice(0,3).map(v => {
        v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
      }).reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i],0);
      return Object.fromEntries(['player-stats','player-count','audio-note','training-instruction','relay-status'].map(id => {
        const element = document.getElementById(id), foreground = light(rgb(getComputedStyle(element).color));
        let node = element, background = [255,255,255];
        while(node) {
          const color = rgb(getComputedStyle(node).backgroundColor);
          if(color.length === 3 || color[3] === 1) { background = color; break; }
          node = node.parentElement;
        }
        const luminance = light(background);
        return [id,(Math.max(foreground,luminance)+.05)/(Math.min(foreground,luminance)+.05)];
      }));
    }""")
    assert all(ratio >= 4.5 for ratio in ratios.values()), ratios
    print('High-contrast small text ratios:', {key:round(value,2) for key,value in ratios.items()}, flush=True)
    await page.locator('#arena').focus()
    # Old primary W has been unbound; physical I still works with a Korean key value.
    await page.keyboard.press('w')
    await asyncio.sleep(.3)
    assert (client.me()['x'], client.me()['y']) == (1, 1)
    await page.evaluate("""() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'ㅑ',code:'KeyI',bubbles:true}));
      document.dispatchEvent(new KeyboardEvent('keyup', {key:'ㅑ',code:'KeyI',bubbles:true}));
    }""")
    await until(lambda: client.me().get('y') == 2)
    await page.locator('#arena').focus()
    await page.keyboard.press('ArrowDown')
    await until(lambda: client.me().get('y') == 1)
    # Pressing a form key never moves the character.
    await page.locator('#invite-url').focus()
    await page.keyboard.press('i')
    await asyncio.sleep(.3)
    assert client.me()['y'] == 1
    bombs = client.me()['bombsPlaced']
    await page.locator('.brand').focus()
    await page.keyboard.press('Space')
    await asyncio.sleep(.3)
    assert client.me()['bombsPlaced'] == bombs and client.me()['y'] == 1
    await page.locator('#reset-keys').click()
    assert await page.locator('[data-binding="up"]').inner_text() == 'W'
    await page.locator('#arena').focus()
    await page.evaluate("""() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'ㅈ',code:'KeyW',bubbles:true}));
      document.dispatchEvent(new KeyboardEvent('keyup', {key:'ㅈ',code:'KeyW',bubbles:true}));
    }""")
    await until(lambda: client.me().get('y') == 2)
    await page.screenshot(path='/tmp/poppop-playability-contrast.png', full_page=True)
    await page.locator('#leave-button').click()


async def friends(browser, base, errors):
    contexts = [await browser.new_context(viewport={'width':1440,'height':1000}) for _ in range(2)]
    clients = [Client(await c.new_page(), errors) for c in contexts]
    a, b = clients
    await a.page.goto(base)
    await a.page.locator('#quick-friends').click()
    assert await a.page.locator('#human-slots').input_value() == '2'
    assert await a.page.locator('#arena').get_attribute('data-phase') == 'preview'
    await a.page.locator('#team-preference').select_option('blue')
    await a.page.locator('#room-id').fill('two-friends-browser')
    await a.page.locator('#invite-button').click()
    url = await a.page.locator('#invite-url').input_value()
    assert 'humans=2' in url and 'teamPreference' not in url
    await a.page.locator('#join-button').click()
    await until(lambda: a.state().get('phase') == 'waiting')
    await b.page.goto(url)
    assert await b.page.locator('#human-slots').input_value() == '2'
    await b.page.locator('#team-preference').select_option('blue')
    await b.page.locator('#join-button').click()
    await until(lambda: a.state().get('phase') == 'playing')
    assert a.state()['humanSlots'] == 2 and a.state()['withBots'] is True and a.state()['ranked'] is False
    assert len(a.state()['players']) == 8 and sum(p['isBot'] for p in a.state()['players']) == 6
    assert sum(p['team'] == 'blue' for p in a.state()['players']) == 4
    assert all(p['team'] == 'blue' for p in a.state()['players'] if not p['isBot'])
    await a.page.screenshot(path='/tmp/poppop-playability-friends.png', full_page=True)
    old_id, match_id = a.joined()['playerId'], a.state()['matchId']
    a.messages.clear()
    await a.page.reload()
    await until(lambda: a.joined().get('playerId') == old_id and a.state().get('phase') == 'playing')
    assert a.state()['matchId'] == match_id and sum(p['isBot'] for p in a.state()['players']) == 6
    ranking = await (await a.page.request.get(base+'/api/leaderboard')).json()
    assert ranking['entries'] == []
    for c in clients:
        await c.page.locator('#leave-button').click()
    for context in contexts:
        await context.close()


async def mobile(browser, base, errors):
    context = await browser.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
    await context.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked','SecurityError')}})")
    page = await context.new_page()
    client = Client(page, errors)
    await page.goto(base)
    await page.locator('#play-settings-toggle').tap()
    await page.locator('#contrast-toggle').tap()
    await page.locator('#left-hand-toggle').tap()
    await page.locator('#training-button').tap()
    await client.stage('escape')
    await page.screenshot(path='/tmp/poppop-playability-mobile-ready.png', full_page=True)
    await client.ready('escape')
    await page.locator('[data-action="up"]').tap()
    await until(lambda: client.me().get('y') == 2)
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    # Game entry scrolls arena into view. Every touch control must fit without extra scrolling.
    for selector in ['[data-action="up"]','[data-action="left"]','[data-action="down"]','[data-action="right"]','[data-action="use_dart"]','[data-action="place_orb"]']:
        box = await page.locator(selector).bounding_box()
        assert box and min(box['width'],box['height']) >= 44, (selector,box)
        assert box['y'] >= 0 and box['y'] + box['height'] <= 844, ('touch outside viewport',selector,box)
    dpad = await page.locator('.dpad').bounding_box()
    actions = await page.locator('.action-buttons').bounding_box()
    assert actions['x'] < dpad['x'], (actions,dpad)
    await page.locator('[data-action="down"]').tap()
    await until(lambda: client.me().get('y') == 1)
    await page.locator('[data-action="place_orb"]').tap()
    await until(lambda: client.me().get('bubbleTicks',0) > 0)
    await page.locator('#event-peek').wait_for(state='visible')
    assert '물 감옥' in await page.locator('#event-peek').inner_text()
    peek = await page.locator('#event-peek').bounding_box()
    assert peek and 0 <= peek['y'] and peek['y'] + peek['height'] <= 844, peek
    for selector in ['[data-action="up"]','[data-action="left"]','[data-action="down"]','[data-action="right"]','[data-action="use_dart"]','[data-action="place_orb"]']:
        box = await page.locator(selector).bounding_box()
        assert box and box['y'] >= 0 and box['y'] + box['height'] <= 844, ('bubble moves control outside viewport',selector,box)
    await page.screenshot(path='/tmp/poppop-playability-mobile.png', full_page=True)
    await until(lambda: (client.state().get('training') or {}).get('status') == 'ready')
    await client.bomb_lesson('escape')
    await client.bomb_lesson('item')
    await client.ready('rescue')
    await page.locator('#rescue-alert').wait_for(state='visible')
    assert float(await page.locator('#arena').get_attribute('data-essential-marker-css-px')) >= 10
    assert float(await page.locator('#arena').get_attribute('data-team-marker-css-px')) >= 12
    await page.screenshot(path='/tmp/poppop-playability-mobile-rescue.png',full_page=True)
    await page.locator('#leave-button').tap()
    await context.close()


async def main(mobile_only=False):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0))
        port = listener.getsockname()[1]
    env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', ALLOW_DEV_GUESTS='true', SUPABASE_URL='', SUPABASE_ANON_KEY='', SUPABASE_SERVICE_ROLE_KEY='')
    with tempfile.TemporaryFile() as log:
        server = subprocess.Popen(['node','src/index.js'], cwd=ROOT/'Server',env=env,stdout=log,stderr=log)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base+'/health',timeout=1) as response:
                        if response.status == 200: break
                except OSError:
                    await asyncio.sleep(.05)
            else: raise AssertionError('Server did not start')
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox'])
                errors = []
                try:
                    if mobile_only:
                        await mobile(browser,base,errors)
                        assert not errors, errors
                        print('PASS: mobile controls remain in viewport before and during bubble, visible caption and ready instruction',flush=True)
                        return
                    context = await browser.new_context(viewport={'width':1440,'height':1000}, reduced_motion='reduce')
                    client = Client(await context.new_page(), errors)
                    await client.page.goto(base)
                    for selector in ['#quick-training','#quick-practice','#quick-friends']:
                        box = await client.page.locator(selector).bounding_box()
                        assert box and box['y'] + box['height'] < 1000, (selector,box)
                    await client.page.screenshot(path='/tmp/poppop-playability-entry.png',full_page=True)
                    await client.page.locator('input[name="mapId"][value="candy"]').check()
                    await train(client, outcome='friends')
                    await train(client, outcome='practice', fail=False)
                    await train(client, fail=False)
                    print('PASS: discoverable entry, real training failure/retry, reading pauses rescue timer, four actual lessons, completion to friends/practice, preserved map and fresh replay',flush=True)
                    await preferences(client)
                    print('PASS: primary key remap, duplicate rejection, Korean IME physical keys, form focus, preference persistence and reset',flush=True)
                    await friends(browser,base,errors)
                    print('PASS: two friends from invite, same-team choice, six bots, balanced 4v4, unranked and same-seat reload',flush=True)
                    await mobile(browser,base,errors)
                    assert not errors, errors
                    print('PASS: high contrast, left-hand touch, storage-denied preferences, 390x844 controls >=44px and within viewport; pageerror0',flush=True)
                finally:
                    await browser.close()
        finally:
            server.terminate()
            try: server.wait(timeout=5)
            except subprocess.TimeoutExpired: server.kill(); server.wait()


if __name__ == '__main__':
    asyncio.run(main('--mobile-only' in sys.argv))
