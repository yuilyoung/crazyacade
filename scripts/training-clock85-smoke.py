"""Observe training reading/play clocks in Chromium using real server time and UI input."""
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
from arena_smoke_helpers import assert_arena

ROOT = Path(__file__).resolve().parents[1]


async def until(predicate, label, timeout=12):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError(f'Timed out: {label}')
        await asyncio.sleep(.025)


async def verify(page, base, mode, errors):
    messages = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def observe(ws):
        ws.on('framereceived', lambda frame: messages.append(json.loads(frame)) if isinstance(frame, str) else None)
    page.on('websocket', observe)
    def state():
        return next((message for message in reversed(messages) if message.get('type') == 'state'), {})
    def me():
        player_id = next((message['playerId'] for message in reversed(messages) if message.get('type') == 'joined'), None)
        return next((player for player in state().get('players', []) if player['id'] == player_id), {})
    await page.goto(base)
    await page.locator('#harmony-training-button' if mode == 'harmony' else '#training-button').click()
    await until(lambda: state().get('training', {}).get('status') == 'ready', f'{mode} ready')
    first = state()
    assert_arena(first, (13, 11))
    assert first['remaining'] == 1800 and first['remainingSeconds'] == 180
    await until(lambda: state().get('tick', 0) >= first['tick'] + 20, f'{mode} two seconds of reading')
    reading = state()
    assert reading['training']['status'] == 'ready'
    assert reading['remaining'] == 1800 and reading['remainingSeconds'] == 180
    assert await page.locator('#timer').inner_text() == '03:00'
    assert reading['training']['readingIdleRemainingSeconds'] < first['training']['readingIdleRemainingSeconds']
    ready_screenshot = f'/tmp/poppop85-training-clock-{mode}-ready.png'
    await page.screenshot(path=ready_screenshot, full_page=True)
    await page.locator('#training-ready-button').click()
    await until(lambda: state().get('training', {}).get('status') == 'active', f'{mode} active')
    active = state()
    before = (me()['x'], me()['y'])
    await page.locator('#arena').focus()
    await page.keyboard.press('ArrowLeft' if mode == 'harmony' else 'ArrowUp')
    await until(lambda: (me().get('x'), me().get('y')) != before, f'{mode} actual keyboard movement')
    await until(lambda: state().get('tick', 0) >= active['tick'] + 20, f'{mode} two seconds of active play')
    played = state()
    assert played['training']['status'] == 'active'
    assert played['remaining'] < active['remaining'] <= 1800
    assert played['remainingSeconds'] <= 178
    assert played['training']['readingIdleRemainingSeconds'] is None
    assert await page.locator('#timer').inner_text() != '03:00'
    active_screenshot = f'/tmp/poppop85-training-clock-{mode}-active.png'
    await page.screenshot(path=active_screenshot, full_page=True)
    record = {
        'mode': mode, 'readingEngineTicks': reading['tick'] - first['tick'],
        'readingRemainingBefore': first['remaining'], 'readingRemainingAfter': reading['remaining'],
        'readingTimer': '03:00', 'activeEngineTicks': played['tick'] - active['tick'],
        'activeRemainingBefore': active['remaining'], 'activeRemainingAfter': played['remaining'],
        'activeRemainingSeconds': played['remainingSeconds'], 'keyboardMovementObserved': True,
        'screenshots': [ready_screenshot, active_screenshot]
    }
    await page.locator('#leave-button').click()
    await page.close()
    return record


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
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base+'/health', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    await asyncio.sleep(.05)
            else:
                raise AssertionError('Server did not start')
            errors, records = [], []
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
                try:
                    for mode in ['classic', 'harmony']:
                        page = await browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
                        records.append(await verify(page, base, mode, errors))
                finally:
                    await browser.close()
            assert not errors, errors
            report = json.dumps({'result': 'pass', 'realServerTickMs': 100, 'timerOverrides': False,
                                 'cases': records, 'pageErrors': errors}, ensure_ascii=False, indent=2)
            Path('/tmp/poppop85-training-clock.json').write_text(report + '\n')
            Path('/tmp/poppop85-training-clock.log').write_text(report + '\n')
            print(report)
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == '__main__':
    asyncio.run(main())
