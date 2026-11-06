"""Real Chromium acceptance for the four Harmony lessons.

Only normal UI/keyboard inputs and real server timers drive gameplay. WebSocket
frames are observed for assertions; no test hook or authoritative state injection.
Run from the repository root: python3 scripts/harmony-training-smoke.py
"""
import asyncio
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import urllib.parse
import urllib.request

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]


async def until(predicate, description, timeout=12):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError(f'Timed out: {description}')
        await asyncio.sleep(.025)


class Client:
    def __init__(self, page, errors):
        self.page, self.messages, self.sent = page, [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('websocket', self.observe)

    def observe(self, ws):
        ws.on('framereceived', lambda frame: self.record(frame, self.messages))
        ws.on('framesent', lambda frame: self.record(frame, self.sent))

    @staticmethod
    def record(frame, records):
        if isinstance(frame, str):
            records.append(json.loads(frame))

    def state(self):
        return next((m for m in reversed(self.messages) if m.get('type') == 'state'), {})

    def joined(self):
        return next((m for m in reversed(self.messages) if m.get('type') == 'joined'), {})

    def me(self):
        return next((p for p in self.state().get('players', [])
                     if p['id'] == self.joined().get('playerId')), {})

    def training(self):
        return self.state().get('training') or {}

    async def stage(self, stage, status='ready'):
        await until(lambda: self.training().get('stage') == stage and
                    self.training().get('status') == status, f'{stage}/{status}')

    async def ready(self, stage):
        await self.stage(stage)
        await self.page.locator('#training-ready-button').click()
        await self.stage(stage, 'active')
        await self.page.locator('#arena').focus()

    async def move(self, key, x, y):
        await self.page.locator('#arena').focus()
        await self.page.keyboard.press(key)
        await until(lambda: (self.me().get('x'), self.me().get('y')) == (x, y),
                    f'movement to {x},{y}')


async def remap(client):
    page = client.page
    await page.locator('#settings-open').click()
    for action, key in [('pass', 'h'), ('dart', 'r')]:
        await page.locator(f'[data-binding="{action}"]').click()
        await page.keyboard.press(key)
        assert await page.locator(f'[data-binding="{action}"]').inner_text() == key.upper()
    await page.locator('#settings-close').click()


async def pass_guide(client, outcome, toggle=False):
    page = client.page
    await page.locator(f'#arena[data-pass-guide="{outcome}"][data-pass-target="6,5"]').wait_for()
    hint = '아군' if outcome == 'ally' else '가로채요'
    await page.locator('#relay-status').filter(has_text='H').filter(has_text=hint).wait_for()
    if toggle:
        await page.locator('#settings-open').click()
        await page.locator('#pass-guide-toggle').uncheck()
        await page.locator('#arena[data-pass-guide=""][data-pass-target=""]').wait_for()
        await page.locator('#settings-close').click()
        await page.wait_for_function("!document.getElementById('relay-status').textContent.includes('아군에게 패스 가능')")
        assert client.training()['stage'] == 'pass' and client.training()['status'] == 'active'
        await page.locator('#settings-open').click()
        await page.locator('#pass-guide-toggle').check()
        await page.locator('#settings-close').click()
        await page.locator('#arena[data-pass-guide="ally"][data-pass-target="6,5"]').wait_for()
        await page.locator('#relay-status').filter(has_text='H').filter(has_text=hint).wait_for()
        await page.locator('#arena').scroll_into_view_if_needed()
        await page.screenshot(path='/tmp/poppop80-harmony-pass-guide-viewport.png', full_page=False)
    await page.locator('#arena').focus()


async def train(client, deliberate_failure=False, dart_rescue=True):
    page = client.page
    await page.locator('#harmony-training-button').click()
    await client.stage('pass')
    state = client.state()
    assert state['practice'] is True and state['ranked'] is False
    assert state['ruleSet'] == 'harmony' and state['mapId'] == 'festival'
    assert state['training']['mode'] == 'harmony'
    join = next(m for m in reversed(client.sent) if m.get('type') == 'join')
    assert join['practice'] is True and join['training'] is True
    assert join['trainingMode'] == 'harmony'
    assert 'H' in await page.locator('#training-instruction').inner_text()

    # Reading a lesson freezes its actors while the bounded session clock advances.
    tick, pose = state['tick'], (client.me()['x'], client.me()['y'])
    carrier = state['relay']['carrierId']
    await page.locator('#arena').focus()
    await page.keyboard.press('h')
    await asyncio.sleep(1.1)
    assert client.training()['status'] == 'ready'
    assert client.state()['tick'] > tick
    assert (client.me()['x'], client.me()['y']) == pose
    assert client.state()['relay']['carrierId'] == carrier
    assert client.me()['passes'] == 0

    if deliberate_failure:
        await client.ready('pass')
        await page.keyboard.press('Space')
        await until(lambda: bool(client.state().get('orbs')), 'real failure bomb placement')
        await until(lambda: client.training().get('status') == 'retrying', 'bomb failure and retry', timeout=15)
        await client.stage('pass')
        assert client.training()['attempts'] >= 1 and client.training()['completed'] == 0
        assert client.me()['alive'] and client.me()['bubbleTicks'] == 0
        assert client.me()['passes'] == 0 and client.state()['relay']['charges']['total'] == 0
        assert not client.state()['orbs'] and not client.state()['waves']
        print('PASS: actual bomb failure retries the same lesson without fabricated pass credit', flush=True)

    await client.ready('pass')
    await pass_guide(client, 'ally', toggle=deliberate_failure)
    # The old default G is unbound; only the configured H submits the pass.
    pass_count = sum(m.get('action') == 'pass_star' for m in client.sent)
    await page.keyboard.press('g')
    await asyncio.sleep(.3)
    assert client.training()['stage'] == 'pass'
    assert sum(m.get('action') == 'pass_star' for m in client.sent) == pass_count
    await page.keyboard.press('h')
    await client.stage('intercept')
    assert client.me()['passes'] >= 1
    assert client.state()['relay']['charges']['passes'] == 1
    await client.ready('intercept')
    await pass_guide(client, 'enemy')
    await page.keyboard.press('h')
    await client.stage('charge_rescue')
    assert client.state()['relay']['charges']['total'] == 0
    assert any(p.get('interceptions', 0) >= 1 for p in client.state()['players'])

    target = lambda: next(p for p in client.state()['players'] if p['x'] == 6 and p['y'] == 5)
    bubble_ticks, tick = target()['bubbleTicks'], client.state()['tick']
    assert bubble_ticks == 100
    await asyncio.sleep(1.1)
    assert target()['bubbleTicks'] == bubble_ticks and client.state()['tick'] > tick
    await client.ready('charge_rescue')
    if dart_rescue:
        assert 'R' in await page.locator('#training-instruction').inner_text()
        darts = client.me()['darts']
        await page.keyboard.press('f')
        await asyncio.sleep(.3)
        assert client.me()['darts'] == darts and client.training()['stage'] == 'charge_rescue'
        await page.keyboard.press('r')
    else:
        await page.keyboard.press('ArrowRight')
    await client.stage('delivery')
    assert client.me()['rescues'] >= 1
    assert client.state()['relay']['charges']['rescue'] == 1
    assert client.state()['relay']['charges']['total'] == 1
    await client.ready('delivery')
    await client.move('ArrowLeft', 3, 5)
    await client.move('ArrowLeft', 2, 5)
    await page.keyboard.press('ArrowLeft')
    await until(lambda: client.state().get('phase') == 'finished', 'actual charged delivery completes training')
    assert client.training()['completed'] == 4 and client.training()['status'] == 'complete'
    assert client.state()['result']['reason'] == 'training_complete'
    assert client.state()['resultSaving']['status'] == 'unranked'
    assert client.me()['deliveries'] >= 1
    assert client.state()['relay']['scores']['blue'] == 2
    await page.locator('#result-saving[data-status="unranked"]').wait_for()
    assert '완료' in await page.locator('#training-status').inner_text()
    for selector in ['#rescue-recognition', '#tutorial-summary', '#training-instruction', '#overlay-copy']:
        await page.locator(selector).filter(has_text='2점 전달').wait_for()
        summary = await page.locator(selector).inner_text()
        assert re.search(r'4\s*/\s*4단계 완료', summary), (selector, summary)
        assert '패스 1회' in summary and '구출 1회' in summary and '전달 1회' in summary, (selector, summary)
        assert not re.search(r'B\s*0\s*:\s*0\s*P|현재\s*전달\s*1점', summary), (selector, summary)
    await page.screenshot(path=f'/tmp/poppop80-harmony-training-{ "dart" if dart_rescue else "adjacent" }.png', full_page=True)
    print(f'PASS: four real Harmony lessons, remapped pass/dart, reading pauses and {"dart" if dart_rescue else "adjacent"} rescue earn a two-point delivery', flush=True)
    print('PASS: real ally/enemy pass guidance uses H; completion summaries report actual two-point achievement without a generic 0:0 result', flush=True)


async def main():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', ALLOW_DEV_GUESTS='true',
               SUPABASE_URL='', SUPABASE_ANON_KEY='', SUPABASE_SERVICE_ROLE_KEY='')
    with tempfile.TemporaryFile() as server_log:
        server = subprocess.Popen(['node', 'src/index.js'], cwd=ROOT/'Server', env=env,
                                  stdout=server_log, stderr=server_log)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base+'/health', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    await asyncio.sleep(.05)
            else:
                raise AssertionError('Server did not start')
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
                errors = []
                try:
                    context = await browser.new_context(viewport={'width':1440, 'height':1000}, reduced_motion='reduce')
                    client = Client(await context.new_page(), errors)
                    page = client.page
                    await page.goto(base)
                    await page.locator('input[name="mapId"][value="harbor"]').check()
                    await page.locator('input[name="skinId"][value="bee"]').check()
                    await page.locator('#orb-skin').select_option('duck')
                    await remap(client)
                    await train(client, deliberate_failure=True)
                    await page.locator('#training-friends-button').click()
                    assert await page.locator('#arena').get_attribute('data-phase') == 'preview'
                    assert await page.locator('#mode').input_value() == 'team'
                    assert await page.locator('#rule-set').input_value() == 'harmony'
                    assert await page.locator('#human-slots').input_value() == '2'
                    assert await page.locator('input[name="mapId"][value="harbor"]').is_checked()
                    assert await page.locator('input[name="skinId"][value="bee"]').is_checked()
                    assert await page.locator('#orb-skin').input_value() == 'duck'
                    await page.locator('#invite-button').click()
                    invite = urllib.parse.parse_qs(urllib.parse.urlparse(await page.locator('#invite-url').input_value()).query)
                    assert invite['rules'] == ['harmony'] and invite['map'] == ['harbor'] and invite['humans'] == ['2']
                    print('PASS: completion prepares two-person Harmony invitation with the selected harbor map and cosmetics', flush=True)
                    await train(client, dart_rescue=False)
                    old_room = client.state()['roomId']
                    await page.locator('#training-practice-button').click()
                    await until(lambda: client.state().get('phase') == 'playing' and client.state().get('roomId') != old_room,
                                'completion launches ordinary Harmony AI practice')
                    state = client.state()
                    assert state['practice'] is True and state['training'] is None
                    assert state['ruleSet'] == 'harmony' and state['mapId'] == 'harbor'
                    assert state['ranked'] is False and sum(p['isBot'] for p in state['players']) == 7
                    assert client.me()['skinId'] == 'bee' and client.me()['orbSkinId'] == 'duck'
                    ranking = await (await page.request.get(base+'/api/leaderboard')).json()
                    assert ranking['entries'] == []
                    await page.locator('#leave-button').click()
                    assert not errors, errors
                    print('PASS: completion launches selected-map Harmony AI practice, preserves cosmetics, never ranks training; pageerror0', flush=True)
                except Exception:
                    if 'client' in locals():
                        state = client.state()
                        print('Failure state:', json.dumps({
                            'phase': state.get('phase'), 'training': client.training(),
                            'player': {key: client.me().get(key) for key in
                                       ['x', 'y', 'alive', 'bubbleTicks', 'darts', 'passes', 'rescues', 'deliveries']},
                            'charges': (state.get('relay') or {}).get('charges'),
                            'scores': (state.get('relay') or {}).get('scores'),
                            'pageErrors': errors,
                        }, ensure_ascii=False), flush=True)
                        await client.page.screenshot(path='/tmp/poppop80-harmony-training-failure.png', full_page=True)
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
