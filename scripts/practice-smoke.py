"""Production guest-off solo practice and onboarding browser acceptance.
Requires Python Playwright + Chromium. No external authentication/storage services.
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

async def until(predicate, timeout=10):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError('Timed out waiting for practice state')
        await asyncio.sleep(.025)

async def main():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', ALLOW_DEV_GUESTS='false',
               SUPABASE_URL='', SUPABASE_ANON_KEY='', SUPABASE_SERVICE_ROLE_KEY='')
    with tempfile.TemporaryFile() as log:
        server = subprocess.Popen(['node', 'src/index.js'], cwd=ROOT/'Server', env=env, stdout=log, stderr=log)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(80):
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
                    context = await browser.new_context(viewport={'width':1440,'height':1000}, reduced_motion='reduce')
                    await context.add_init_script('''
                        window.__audioStarts = 0;
                        const Audio = window.AudioContext || window.webkitAudioContext;
                        if (Audio) {
                          const original = Audio.prototype.createOscillator;
                          Audio.prototype.createOscillator = function(...args) {
                            const oscillator = original.apply(this, args), start = oscillator.start;
                            oscillator.start = function(...values) { window.__audioStarts++; return start.apply(this, values); };
                            return oscillator;
                          };
                        }
                    ''')
                    page = await context.new_page()
                    messages = []
                    page.on('pageerror', lambda e: errors.append(str(e)))
                    page.on('websocket', lambda ws: ws.on('framereceived', lambda frame: messages.append(json.loads(frame))))
                    await page.goto(base)
                    await page.locator('#practice-button').wait_for(timeout=5000)
                    await page.locator('#music-toggle').wait_for(timeout=5000)
                    assert await page.locator('#music-toggle').get_attribute('aria-pressed') == 'false'
                    assert await page.locator('#sound-toggle').get_attribute('aria-pressed') == 'false'
                    assert await page.locator('#motion-toggle').get_attribute('aria-pressed') == 'true'
                    await page.locator('#motion-toggle').click()
                    assert await page.locator('#motion-toggle').get_attribute('aria-pressed') == 'false'
                    await page.reload()
                    assert await page.locator('#motion-toggle').get_attribute('aria-pressed') == 'false'
                    # Keyboard activation of a focused button must not place a bomb.
                    await page.locator('#nickname').fill('첫탐험가')
                    await page.locator('#practice-button').click()
                    def latest():
                        return next((m for m in reversed(messages) if m.get('type') == 'state'), {})
                    def me():
                        return next((p for p in latest().get('players',[]) if not p.get('isBot')), {})
                    await until(lambda: latest().get('phase') == 'playing')
                    assert latest().get('practice') is True and len(latest()['players']) == 8
                    assert sum(bool(p.get('isBot')) for p in latest()['players']) == 7
                    assert sum(p['team']=='blue' for p in latest()['players']) == 4
                    assert await page.locator('#arena').get_attribute('data-practice') == 'true'
                    assert '연습' in await page.locator('#match-kind').inner_text()
                    initial = {p['id']:(p['x'],p['y']) for p in latest()['players'] if p.get('isBot')}
                    await page.locator('#arena').focus()
                    await page.keyboard.press('ArrowRight')
                    await until(lambda: me().get('x') == 2)
                    await page.locator('[data-step="move"][data-complete="true"]').wait_for()
                    await page.keyboard.press('Space')
                    await until(lambda: me().get('bombsPlaced',0) == 1)
                    await page.locator('[data-step="bomb"][data-complete="true"]').wait_for()
                    await page.keyboard.press('ArrowRight')
                    await until(lambda: me().get('x') == 3)
                    await page.keyboard.press('ArrowUp')
                    await until(lambda: me().get('y') == 2)
                    await until(lambda: any(p.get('isBot') and (p['x'],p['y']) != initial[p['id']] for p in latest()['players']))
                    await until(lambda: any(p.get('isBot') and p.get('bombsPlaced',0)>0 for p in latest()['players']))
                    await page.locator('#tutorial-toggle').click()
                    assert await page.locator('#tutorial-toggle').get_attribute('aria-expanded') == 'false'
                    await page.locator('#tutorial-toggle').click()
                    assert await page.evaluate('window.__audioStarts') == 0
                    await page.locator('#sound-toggle').focus()
                    bombs_before = me().get('bombsPlaced',0)
                    await page.keyboard.press('Space')
                    await page.locator('#sound-toggle[aria-pressed="true"]').wait_for()
                    await page.wait_for_function('window.__audioStarts > 0')
                    await asyncio.sleep(.25)
                    assert me().get('bombsPlaced',0) == bombs_before
                    await page.locator('#sound-toggle').click()
                    assert await page.locator('#sound-toggle').get_attribute('aria-pressed') == 'false'
                    muted_count = await page.evaluate('window.__audioStarts')
                    await asyncio.sleep(.5)
                    assert await page.evaluate('window.__audioStarts') == muted_count
                    await page.screenshot(path='/tmp/poppop-practice-desktop.png',full_page=True)
                    # Finish one real round to check results/replay, while exercising mobile independently.
                    mobile = await browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
                    mobile_page = await mobile.new_page()
                    mobile_page.on('pageerror',lambda e:errors.append(str(e)))
                    await mobile_page.add_init_script("Object.defineProperty(window, 'localStorage', {get(){throw new DOMException('blocked','SecurityError')}})")
                    await mobile_page.add_init_script('window.AudioContext = undefined; window.webkitAudioContext = undefined;')
                    mobile_messages=[]
                    mobile_page.on('websocket',lambda ws:ws.on('framereceived',lambda f:mobile_messages.append(json.loads(f))))
                    await mobile_page.goto(base)
                    assert await mobile_page.locator('#sound-toggle').is_disabled()
                    await mobile_page.locator('#item-mode').uncheck()
                    await mobile_page.locator('input[name="mapId"][value="candy"]').check()
                    await mobile_page.locator('#practice-button').tap()
                    def mobile_state():
                        return next((m for m in reversed(mobile_messages) if m.get('type')=='state'),{})
                    await until(lambda:mobile_state().get('phase')=='playing')
                    assert mobile_state()['mapId']=='candy' and mobile_state()['itemMode'] is False
                    assert await mobile_page.locator('[data-step="item"]').get_attribute('data-optional')=='true'
                    await mobile_page.locator('[data-action="right"]').tap()
                    await until(lambda:any(not p.get('isBot') and p['x']==2 for p in mobile_state()['players']))
                    assert await mobile_page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    for selector in ['[data-action="up"]','[data-action="place_orb"]','#sound-toggle','#motion-toggle']:
                        box=await mobile_page.locator(selector).bounding_box()
                        assert box and min(box['width'],box['height'])>=44, (selector,box)
                        if selector.startswith('[data-action'):
                            assert box['y'] >= 0 and box['y']+box['height'] <= 844, ('touch control outside viewport',selector,box)
                    await mobile_page.screenshot(path='/tmp/poppop-practice-mobile.png',full_page=True)
                    await mobile_page.locator('#leave-button').tap()
                    await mobile_page.locator('#practice-button').wait_for(state='visible')
                    print('PASS: production guest-off one-click practice, seven active bots, actual tutorial progress, audio/motion controls, mobile and storage-denied flow',flush=True)
                    await until(lambda:latest().get('phase')=='finished',timeout=130)
                    await page.locator('#scoreboard-rows .score-row').first.wait_for()
                    assert len(latest()['result']['scoreboard'])==8
                    assert all('rescues' in p for p in latest()['result']['scoreboard'])
                    await page.screenshot(path='/tmp/poppop-practice-result.png',full_page=True)
                    previous_room=latest()['roomId']
                    await page.locator('#replay-button').click()
                    await until(lambda:latest().get('phase')=='playing' and latest().get('roomId')!=previous_room)
                    assert latest()['practice'] is True
                    assert await page.locator('[data-step="bomb"]').get_attribute('data-complete')=='false'
                    await page.locator('#leave-button').click()
                    await page.locator('#join-button').click()
                    await page.locator('#status.error').wait_for()
                    assert await page.locator('#arena').get_attribute('data-phase')=='preview'
                    assert not errors,errors
                    print('PASS: unranked result, instant fresh practice replay, tutorial reset, normal auth still required; no page errors',flush=True)
                finally:
                    await browser.close()
        finally:
            server.terminate()
            try: server.wait(timeout=5)
            except subprocess.TimeoutExpired: server.kill(); server.wait()

if __name__=='__main__':
    asyncio.run(main())
