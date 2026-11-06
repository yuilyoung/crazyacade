"""Real Chromium checks for saved appearance, settings, resolution and touch access.

Uses the production page and ordinary inputs; no game state injection.
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
from arena_smoke_helpers import assert_arena, arena

ROOT = Path(__file__).resolve().parents[1]


async def until(predicate, timeout=10):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError('Timed out waiting for experience state')
        await asyncio.sleep(.025)


async def main():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', ALLOW_DEV_GUESTS='true',
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
                raise AssertionError('Server failed to start')
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
                errors, evidence = [], []
                try:
                    for width, height, dpr in [(360, 640, 1), (390, 844, 2), (844, 390, 2), (1280, 720, 1), (1920, 1080, 2)]:
                        context = await browser.new_context(viewport={'width': width, 'height': height},
                                                            device_scale_factor=dpr, has_touch=True)
                        page = await context.new_page()
                        messages, inputs = [], []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        def connect(ws):
                            ws.on('framereceived', lambda frame: messages.append(json.loads(frame)))
                            ws.on('framesent', lambda frame: inputs.append(json.loads(frame)))
                        page.on('websocket', connect)
                        await page.goto(base)
                        await page.locator('#join-button:not([disabled])').wait_for()
                        # Use controls, not direct localStorage edits, to configure the saved loadout.
                        await page.locator('input[name="characterId"][value="toto"]').check()
                        await page.locator('input[name="skinId"][value="raincoat"]').check()
                        await page.locator('#orb-skin').select_option('duck')
                        preview = await page.locator('#appearance-preview').evaluate('(canvas) => canvas.toDataURL()')
                        await page.locator('#settings-open').click()
                        await page.locator('#text-scale').select_option('130')
                        await page.locator('#render-quality').select_option('high')
                        await page.locator('#effect-level').select_option('calm')
                        await page.locator('#item-style').select_option('garden')
                        await page.locator('#movement-mode').select_option('step')
                        await page.keyboard.press('Escape')
                        await page.wait_for_function("!document.getElementById('settings-dialog').open && document.activeElement.id==='settings-open'")
                        await page.reload()
                        await page.locator('#join-button:not([disabled])').wait_for()
                        assert await page.locator('input[name="characterId"][value="toto"]').is_checked()
                        assert await page.locator('input[name="skinId"][value="raincoat"]').is_checked()
                        assert await page.locator('#orb-skin').input_value() == 'duck'
                        assert preview == await page.locator('#appearance-preview').evaluate('(canvas) => canvas.toDataURL()')
                        assert await page.locator('#arena').get_attribute('width') == '1800'
                        assert await page.locator('#text-scale').input_value() == '130'
                        assert await page.locator('#effect-level').input_value() == 'calm'
                        assert await page.locator('#item-style').input_value() == 'garden'
                        assert await page.locator('#movement-mode').input_value() == 'step'
                        await page.locator('#rule-set').select_option('harmony')
                        await page.locator('input[name="mapId"][value="harbor"]').check()
                        await page.locator('#practice-button').click()
                        def state():
                            return next((m for m in reversed(messages) if m.get('type') == 'state'), {})
                        def me():
                            player_id = next((m['playerId'] for m in messages if m.get('type') == 'joined'), None)
                            return next((p for p in state().get('players', []) if p['id'] == player_id), {})
                        await until(lambda: state().get('phase') == 'playing')
                        assert_arena(state())
                        assert state()['mapId'] == 'harbor' and state()['ruleSet'] == 'harmony'
                        assert state()['mapFeatures']['type'] == 'tidegates'
                        assert (me()['characterId'], me()['skinId'], me()['orbSkinId']) == ('toto', 'raincoat', 'duck')
                        await page.locator('#arena').focus()
                        await page.keyboard.down('ArrowUp')
                        await asyncio.sleep(.55)
                        await page.keyboard.up('ArrowUp')
                        await until(lambda: me().get('y') == 2)
                        assert me()['x'] == 1, me()
                        await page.keyboard.press('ArrowDown')
                        await until(lambda: me().get('y') == 1)
                        # Every action remains reachable at the large-text setting, with real 44px targets.
                        await page.locator('#arena').evaluate('(canvas) => canvas.scrollIntoView({block:"start"})')
                        await asyncio.sleep(.15)
                        dimensions = await page.evaluate("""() => {
                          const canvas=document.getElementById('arena').getBoundingClientRect();
                          return {overflow:document.documentElement.scrollWidth>innerWidth,
                            canvas:{width:canvas.width,height:canvas.height},
                            buttons:[...document.querySelectorAll('[data-action]')].map(button=>{
                              const r=button.getBoundingClientRect();return {action:button.dataset.action,
                                x:r.x,y:r.y,width:r.width,height:r.height,hidden:button.hidden};})};
                        }""")
                        assert not dimensions['overflow'], (width, height, dimensions)
                        canvas = dimensions['canvas']
                        assert abs(canvas['width']/canvas['height'] - arena(state())[0]/arena(state())[1]) < .025, canvas
                        for box in dimensions['buttons']:
                            assert not box['hidden'] and min(box['width'], box['height']) >= 44, (width, height, box)
                            assert box['x'] >= 0 and box['x']+box['width'] <= width+1, (width, height, box)
                            assert box['y'] >= 0 and box['y']+box['height'] <= height+1, (width, height, box)
                        await page.screenshot(path=f'/tmp/poppop-experience-{width}x{height}.png', full_page=True)
                        evidence.append({'viewport': f'{width}x{height}', 'dpr': dpr, **dimensions})
                        # Modal keyboard events must never reach the authoritative game input path.
                        await page.locator('#arena').focus()
                        await page.keyboard.press('Escape')
                        before = len([m for m in inputs if m.get('type') == 'input'])
                        await page.evaluate("""() => {
                          document.dispatchEvent(new KeyboardEvent('keydown',{code:'ArrowUp',bubbles:true}));
                          document.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',bubbles:true}));
                        }""")
                        await asyncio.sleep(.25)
                        assert before == len([m for m in inputs if m.get('type') == 'input'])
                        await page.locator('#render-quality').select_option('low')
                        assert await page.locator('#arena').get_attribute('width') == '900'
                        await page.keyboard.press('Escape')
                        await page.wait_for_function("!document.getElementById('settings-dialog').open && document.activeElement.id==='arena'")
                        # Denied fullscreen must still produce a usable, reversible focus mode.
                        await page.evaluate("() => { Element.prototype.requestFullscreen=async()=>{throw new Error('Denied in smoke')}; }")
                        await page.locator('#fullscreen-toggle').click()
                        assert await page.locator('body').evaluate("body=>body.classList.contains('arena-focus')")
                        assert await page.locator('#focus-toggle').get_attribute('aria-pressed') == 'true'
                        await page.locator('#focus-toggle').click()
                        assert not await page.locator('body').evaluate("body=>body.classList.contains('arena-focus')")
                        # A real placed orb carries the selected skin through the server snapshot.
                        await page.locator('#arena').focus()
                        await page.keyboard.press('Space')
                        await until(lambda: any(orb.get('orbSkinId') == 'duck' for orb in state().get('orbs', [])))
                        await page.screenshot(path=f'/tmp/poppop-experience-orb-{width}.png', full_page=True)
                        print(f'PASS: {width}x{height} DPR{dpr}, 130% text, 7 touch targets, persisted loadout/settings, modal input, step movement, quality and fullscreen fallback', flush=True)
                        await context.close()
                    context = await browser.new_context()
                    page = await context.new_page()
                    await page.goto(base+'/about.html')
                    assert await page.title()
                    image_path = await page.locator('meta[property="og:image"]').get_attribute('content')
                    response = await page.request.get(base+image_path)
                    assert response.ok and response.headers['content-type'].startswith('image/png')
                    assert (await response.body())[:8] == b'\x89PNG\r\n\x1a\n'
                    await page.screenshot(path='/tmp/poppop-experience-about.png', full_page=True)
                    await context.close()
                    assert not errors, errors
                    Path('/tmp/poppop-experience-evidence.json').write_text(json.dumps(evidence, indent=2))
                    print('PASS: real about/social image route; no page errors', flush=True)
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
