"""Focused real-input acceptance for the bounded game scene shell.

Run: python scripts/game-shell-smoke.py --output /tmp/game-shell-evidence
Requires Python Playwright, Chromium and installed Server dependencies. Starts
isolated localhost servers with guests disabled (practice/auth gate) and enabled
(two-human duel). Observes public WebSocket messages only: never changes game
state, simulation clocks, client stores, or server gameplay. Screenshots and
measurements are retained even on failure. --ready-only checks initial mounting.
"""
import argparse
import asyncio
from collections import deque
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import traceback
import urllib.request

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
VIEWPORTS = [(1440, 900, False), (1280, 720, False), (390, 844, True), (844, 390, True)]
MEASURE = r"""() => {
 const rect = e => {if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,clientWidth:e.clientWidth,clientHeight:e.clientHeight,scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight,scrollTop:e.scrollTop,display:s.display,overflowX:s.overflowX,overflowY:s.overflowY};};
 const shell=document.querySelector('#game-shell'),canvas=document.querySelector('#arena');
 let clipping=[], visible=canvas ? {...rect(canvas)} : null;
 if(canvas && visible.width && visible.height) for(let e=canvas.parentElement;e;e=e.parentElement){
   const s=getComputedStyle(e),r=e.getBoundingClientRect();
   if(s.overflowX!=='visible' || s.overflowY!=='visible'){
     const box={selector:e.id?'#'+e.id:e.className,left:r.left+e.clientLeft,top:r.top+e.clientTop,right:r.left+e.clientLeft+e.clientWidth,bottom:r.top+e.clientTop+e.clientHeight,overflowX:s.overflowX,overflowY:s.overflowY};clipping.push(box);
     if(s.overflowX!=='visible'){visible.x=Math.max(visible.x,box.left);visible.right=Math.min(visible.right,box.right);}
     if(s.overflowY!=='visible'){visible.y=Math.max(visible.y,box.top);visible.bottom=Math.min(visible.bottom,box.bottom);}
   }
 }
 if(visible){visible.width=Math.max(0,visible.right-visible.x);visible.height=Math.max(0,visible.bottom-visible.y);}
 const controls={};for(const e of document.querySelectorAll('#settings-open,#fullscreen-toggle,#leave-button,.touch-controls [data-action]')){const r=rect(e);if(r.width&&r.height){const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);controls[e.id||e.dataset.action]={...r,hit:!!hit&&(e===hit||e.contains(hit))};}}
 const scene=shell?.dataset.screen;
 let saved={};try{saved=JSON.parse(localStorage.getItem('popPop:playPreferences')||'{}');}catch{}
 return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},scene,scrollX,scrollY,document:rect(document.documentElement),body:rect(document.body),shell:rect(shell),header:rect(document.querySelector('.shell-header')),activeScene:rect(document.querySelector('#screen-'+scene)),content:rect(document.querySelector('#screen-'+scene+'>.shell-scene-content')),battle:rect(document.querySelector('.battle')),slot:rect(document.querySelector('.shell-arena-slot')),wrapper:rect(document.querySelector('.arena-wrap')),canvas:rect(canvas),visibleCanvas:visible,clipping,buffer:canvas?[canvas.width,canvas.height]:null,controls,fullscreen:document.fullscreenElement?.id||null,settingsOpen:!!document.querySelector('#settings-dialog')?.open,dialog:rect(document.querySelector('#settings-dialog')),bodyFocused:document.body.classList.contains('arena-focus'),savedFocus:saved.focus??false,focusPressed:document.querySelector('#focus-toggle')?.getAttribute('aria-pressed')};
}"""


async def until(predicate, label, timeout=8):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError(f'Timed out: {label}')
        await asyncio.sleep(.025)


class PublicState:
    def __init__(self, page):
        self.messages = deque(maxlen=240)
        self.state = {}
        self.player_id = None
        self.errors = []
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.on('websocket', lambda ws: ws.on('framereceived', self.receive))

    def receive(self, frame):
        try:
            message = json.loads(frame)
        except (TypeError, ValueError):
            return
        self.messages.append(message)
        if message.get('type') == 'joined':
            self.player_id = message.get('playerId')
        if message.get('type') == 'state':
            self.state = message

    def me(self):
        return next((p for p in self.state.get('players', []) if p['id'] == self.player_id), {})


class Evidence:
    def __init__(self, directory):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)
        self.measurements = {}
        self.results = []

    async def capture(self, page, name):
        data = await page.evaluate(MEASURE)
        self.measurements[name] = data
        (self.directory / 'measurements.json').write_text(json.dumps(self.measurements, ensure_ascii=False, indent=2))
        await page.screenshot(path=str(self.directory / f'{name}.png'))
        return data

    def result(self, name, status, **details):
        value = {'scenario': name, 'status': status, **details}
        self.results.append(value)
        (self.directory / 'results.json').write_text(json.dumps(self.results, ensure_ascii=False, indent=2))
        print(json.dumps(value, ensure_ascii=False), flush=True)


@asynccontextmanager
async def server(guests, evidence):
    # The server is isolated from any configured production auth/storage service.
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    name = 'dev-guests' if guests else 'production-guests-off'
    with tempfile.TemporaryDirectory(prefix='poppop-shell-results-') as storage:
        env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', ALLOW_DEV_GUESTS=str(guests).lower(),
                   SUPABASE_URL='', SUPABASE_ANON_KEY='', SUPABASE_SERVICE_ROLE_KEY='', RESULT_OUTBOX_DIR=storage)
        with (evidence.directory / f'{name}-server.log').open('w+') as log:
            process = subprocess.Popen(['node', 'src/index.js'], cwd=ROOT / 'Server', env=env, stdout=log, stderr=log)
            base = f'http://127.0.0.1:{port}'
            try:
                for _ in range(100):
                    if process.poll() is not None:
                        log.seek(0)
                        raise AssertionError(f'{name} server stopped: {log.read()}')
                    try:
                        with urllib.request.urlopen(base + '/health', timeout=.3) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        await asyncio.sleep(.05)
                else:
                    raise AssertionError(f'{name} server did not become healthy')
                yield base
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)


async def screen(page, name):
    await page.wait_for_function('(name)=>document.querySelector("#game-shell")?.dataset.screen===name', arg=name, timeout=8000)
    await page.locator(f'#screen-{name}').wait_for(state='visible')


async def open_lobby(page):
    await screen(page, 'title')
    await page.locator('#screen-title .shell-title-actions [data-screen="lobby"]').click()
    await screen(page, 'lobby')


def assert_document(data):
    width, height = data['viewport']['width'], data['viewport']['height']
    assert abs(data['scrollX']) <= 1 and abs(data['scrollY']) <= 1, f'document scrolled: {data["scrollX"]}, {data["scrollY"]}'
    assert data['document']['scrollWidth'] <= width + 1, f'document horizontal overflow: {data["document"]}'
    assert data['document']['scrollHeight'] <= height + 1, f'document vertical overflow: {data["document"]}'
    assert abs(data['shell']['height'] - height) <= 1, f'shell height differs from viewport: {data["shell"]}'


def assert_board(data, controls=True):
    assert_document(data)
    canvas, visible = data['canvas'], data['visibleCanvas']
    assert canvas['width'] > 100 and canvas['height'] > 100, f'board collapsed: {canvas}'
    assert visible['width'] >= canvas['width'] - 2 and visible['height'] >= canvas['height'] - 2, f'board clipped: canvas={canvas}, visible={visible}, ancestors={data["clipping"]}'
    assert canvas['x'] >= -1 and canvas['y'] >= -1 and canvas['right'] <= data['viewport']['width'] + 1 and canvas['bottom'] <= data['viewport']['height'] + 1, f'board outside viewport: {canvas}'
    if controls:
        for name, rect in data['controls'].items():
            assert rect['x'] >= -1 and rect['y'] >= -1 and rect['right'] <= data['viewport']['width'] + 1 and rect['bottom'] <= data['viewport']['height'] + 1, f'{name} outside viewport: {rect}'
            assert rect['hit'], f'{name} is covered or clipped: {rect}'


async def capture_layout(page, evidence, name, battle=False):
    data = await evidence.capture(page, name)
    (assert_board if battle else assert_document)(data)
    return data


async def check_internal_scroll(page, evidence, name):
    before = await page.evaluate(MEASURE)
    content = page.locator(f'#screen-{before["scene"]}>.shell-scene-content')
    if before['content']['scrollHeight'] > before['content']['clientHeight'] + 5:
        box = await content.bounding_box()
        await page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        await page.mouse.wheel(0, 600)
        await page.wait_for_timeout(150)
        after = await evidence.capture(page, name)
        assert_document(after)
        assert after['content']['scrollTop'] > before['content']['scrollTop'], 'overflowing scene content did not scroll'
        assert after['header']['y'] == before['header']['y'], 'header moved with scene scroll'
        return True
    return False


async def settings_round_trip(page, evidence, name, fullscreen=False):
    await page.locator('#settings-open').click()
    await page.wait_for_function('document.querySelector("#settings-dialog").open')
    await page.locator('#text-scale').select_option('130')
    await page.locator('#effect-level').select_option('minimal')
    data = await evidence.capture(page, name + '-settings')
    assert_document(data)
    assert data['dialog']['width'] > 100 and data['dialog']['bottom'] <= data['viewport']['height'] + 1
    if fullscreen:
        assert data['fullscreen'] == 'game-shell'
        assert await page.locator('#settings-dialog').evaluate('(dialog)=>document.fullscreenElement.contains(dialog)'), 'settings is outside fullscreen subtree'
    await page.locator('#settings-close').click()
    await page.wait_for_function('!document.querySelector("#settings-dialog").open')
    await capture_layout(page, evidence, name + '-large-text-minimal', battle=True)
    await page.locator('#settings-open').click()
    await page.locator('#text-scale').select_option('100')
    await page.locator('#effect-level').select_option('full')
    await page.locator('#settings-close').click()


async def native_escape(page):
    # Headless Chromium needs the platform key code to dispatch the browser's
    # native fullscreen accelerator. This is actual keyboard input, not a DOM
    # event, script call to exitFullscreen(), or a change to application state.
    session = await page.context.new_cdp_session(page)
    try:
        key = {'key': 'Escape', 'code': 'Escape', 'windowsVirtualKeyCode': 27, 'nativeVirtualKeyCode': 27}
        await session.send('Input.dispatchKeyEvent', {'type': 'rawKeyDown', **key})
        await session.send('Input.dispatchKeyEvent', {'type': 'keyUp', **key})
    finally:
        await session.detach()


async def practice_case(browser, base, evidence, width, height, mobile):
    label = f'{width}x{height}'
    context = await browser.new_context(viewport={'width': width, 'height': height}, screen={'width': width, 'height': height},
                                        has_touch=mobile, is_mobile=mobile, device_scale_factor=1)
    page = await context.new_page()
    page.set_default_timeout(6000)
    observed = PublicState(page)
    try:
        await page.goto(base, wait_until='domcontentloaded')
        await capture_layout(page, evidence, label + '-title')
        await open_lobby(page)
        await capture_layout(page, evidence, label + '-lobby')
        await page.locator('#screen-lobby .shell-lobby-menu [data-screen="loadout"]').click()
        await screen(page, 'loadout')
        await page.locator('input[name="characterId"][value="bibi"]').check()
        await page.locator('input[name="skinId"][value="mint"]').check()
        await page.locator('#orb-skin').select_option('duck')
        await capture_layout(page, evidence, label + '-loadout')
        await page.locator('#screen-loadout .shell-scene-actions [data-screen="maps"]').click()
        await screen(page, 'maps')
        await page.locator('input[name="mapId"][value="lagoon"]').check()
        await page.locator('input[name="mapId"][value="garden"]').check()
        await capture_layout(page, evidence, label + '-maps')
        internal_scroll = await check_internal_scroll(page, evidence, label + '-maps-scrolled')
        await page.locator('#practice-button').click()
        await until(lambda: observed.state.get('phase') == 'playing', 'practice playing')
        await screen(page, 'battle')
        state = observed.state
        assert state['practice'] is True and state['arena'] == {'width': 15, 'height': 13}, state
        assert len(state['players']) == 8 and sum(bool(p.get('isBot')) for p in state['players']) == 7
        assert observed.me()['characterId'] == 'bibi' and observed.me()['skinId'] == 'mint' and observed.me()['orbSkinId'] == 'duck'
        await capture_layout(page, evidence, label + '-battle', battle=True)
        # Authoritative movement and a bomb are caused by genuine keyboard input.
        initial = observed.me().copy()
        await page.locator('#arena').focus()
        await page.keyboard.press('ArrowRight')
        await until(lambda: observed.me().get('x') == initial['x'] + 1, 'actual player movement')
        bombs = observed.me()['bombsPlaced']
        await page.keyboard.press('Space')
        await until(lambda: observed.me().get('bombsPlaced', 0) > bombs, 'actual bomb placement')
        # Leave the new bomb's blast via the clear spawn corridor before UI checks.
        await page.keyboard.press('ArrowRight')
        await until(lambda: observed.me().get('x') == initial['x'] + 2, 'escape along spawn corridor')
        await page.keyboard.press('ArrowUp')
        await until(lambda: observed.me().get('y') == initial['y'] + 1, 'turn out of blast')
        before = await page.evaluate(MEASURE)
        await page.mouse.move(width / 2, height / 2)
        await page.mouse.wheel(0, 900)
        await page.wait_for_timeout(150)
        after = await capture_layout(page, evidence, label + '-battle-wheel', battle=True)
        assert abs(after['canvas']['y'] - before['canvas']['y']) <= 1, 'wheel moved battle board'
        await page.locator('#fullscreen-toggle').click()
        await page.wait_for_function('document.fullscreenElement?.id === "game-shell"')
        await capture_layout(page, evidence, label + '-fullscreen', battle=True)
        await settings_round_trip(page, evidence, label + '-fullscreen', fullscreen=True)
        # Use the browser Escape key, never evaluate exitFullscreen() or edit state.
        await native_escape(page)
        await page.wait_for_function('document.fullscreenElement === null', timeout=3000)
        exited = await capture_layout(page, evidence, label + '-native-escape', battle=True)
        assert not exited['bodyFocused'] and not exited['savedFocus'] and exited['focusPressed'] == 'false', 'native fullscreen exit leaves stale focus state'
        await settings_round_trip(page, evidence, label + '-windowed')
        assert not (await page.evaluate(MEASURE))['bodyFocused'], 'unrelated settings reapplied stale focus mode'
        await page.locator('#fullscreen-toggle').click()
        await page.wait_for_function('document.fullscreenElement?.id === "game-shell"')
        await page.locator('#fullscreen-toggle').click()
        await page.wait_for_function('document.fullscreenElement === null')
        await capture_layout(page, evidence, label + '-toggle-exit', battle=True)
        assert not observed.errors, observed.errors
        await page.locator('#leave-button').click()
        await screen(page, 'lobby')
        await page.locator('#screen-lobby .shell-lobby-menu [data-screen="ranking"]').click()
        await screen(page, 'ranking')
        await capture_layout(page, evidence, label + '-ranking')
        evidence.result(label, 'passed', actualMovement=True, actualBomb=True, players=8, arena=[15, 13], internalSceneScroll=internal_scroll, nativeEscape=True, errors=observed.errors)
    except Exception as error:
        await evidence.capture(page, label + '-FAILURE')
        evidence.result(label, 'failed', error=str(error), pageErrors=observed.errors, traceback=traceback.format_exc())
        raise
    finally:
        await context.close()


async def auth_gate_case(browser, base, evidence):
    context = await browser.new_context(viewport={'width': 1280, 'height': 720})
    page = await context.new_page()
    observed = PublicState(page)
    try:
        await page.goto(base, wait_until='domcontentloaded')
        await open_lobby(page)
        await page.locator('#quick-friends').click()
        await screen(page, 'maps')
        await page.locator('#join-button').click()
        await screen(page, 'login')
        await capture_layout(page, evidence, 'guest-off-online-auth-gate')
        assert not observed.state, 'guest-off online entry unexpectedly joined a room'
        assert await page.locator('#member-form').is_visible()
        assert await page.locator('#member-submit').is_disabled(), 'unconfigured auth must explain unavailability'
        await page.locator('#member-back').click()
        await screen(page, 'lobby')
        assert not observed.errors, observed.errors
        evidence.result('production-guest-off-auth-gate', 'passed', roomJoined=False, loginFormVisible=True, unavailableServiceExplained=True)
    finally:
        await context.close()


async def duel_case(browser, base, evidence):
    contexts, pages, observations = [], [], []
    room = f'shell-duel-{time.time_ns()}'
    try:
        for index in range(2):
            context = await browser.new_context(viewport={'width': 1280, 'height': 720})
            contexts.append(context)
            page = await context.new_page()
            pages.append(page)
            observed = PublicState(page)
            observations.append(observed)
            await page.goto(base, wait_until='domcontentloaded')
            await open_lobby(page)
            await page.locator('#quick-friends').click()
            await screen(page, 'maps')
            await page.locator('#mode').select_option('duel')
            await page.locator('#room-id').fill(room)
            await page.locator('#item-mode').uncheck()
            await page.locator('#join-button').click()
            if index == 0:
                await screen(page, 'waiting')
                await until(lambda: observed.state.get('phase') == 'waiting', 'one-human waiting room')
                assert len(observed.state['players']) == 1
                await capture_layout(page, evidence, 'duel-one-human-waiting')
        for page, observed in zip(pages, observations):
            await until(lambda: observed.state.get('phase') == 'playing', 'two-human duel playing')
            await screen(page, 'battle')
            assert len(observed.state['players']) == 2 and not any(p.get('isBot') for p in observed.state['players'])
        await capture_layout(pages[0], evidence, 'duel-battle', battle=True)
        await pages[0].bring_to_front()
        await pages[0].locator('#arena').focus()
        await pages[0].keyboard.press('Space')
        await until(lambda: observations[0].me().get('bombsPlaced') == 1, 'duel self-bomb')
        # Real fuse and bubble expiry: deliberately stay on the authoritative bomb.
        await until(lambda: observations[0].state.get('phase') == 'finished', 'duel result after real self-elimination', timeout=9)
        for page in pages:
            await screen(page, 'results')
        await capture_layout(pages[0], evidence, 'duel-results')
        assert await pages[0].locator('#scoreboard-rows .score-row').count() == 2
        old_round = observations[0].state['round']
        await pages[0].locator('#replay-button').click()
        await pages[1].locator('#replay-button').click()
        for page, observed in zip(pages, observations):
            await until(lambda: observed.state.get('phase') == 'playing' and observed.state.get('round', 0) > old_round, 'both humans ready for rematch')
            await screen(page, 'battle')
        await capture_layout(pages[0], evidence, 'duel-rematch', battle=True)
        assert not any(item.errors for item in observations), [item.errors for item in observations]
        evidence.result('two-human-waiting-battle-result-rematch', 'passed', humanPlayers=2, bots=0, realBombElimination=True, round=observations[0].state['round'])
    except Exception as error:
        for index, page in enumerate(pages):
            await evidence.capture(page, f'duel-player-{index}-FAILURE')
        evidence.result('two-human-waiting-battle-result-rematch', 'failed', error=str(error), pageErrors=[o.errors for o in observations], traceback=traceback.format_exc())
        raise
    finally:
        for context in contexts:
            await context.close()


async def eight_human_case(browser, base, evidence):
    contexts, pages, observations = [], [], []
    room = f'shell-team-{time.time_ns()}'
    try:
        for index in range(8):
            context = await browser.new_context(viewport={'width': 1280, 'height': 720})
            contexts.append(context)
            page = await context.new_page()
            pages.append(page)
            observed = PublicState(page)
            observations.append(observed)
            await page.goto(base, wait_until='domcontentloaded')
            await open_lobby(page)
            await page.locator('#quick-friends').click()
            await screen(page, 'maps')
            await page.locator('#mode').select_option('team')
            await page.locator('#human-slots').select_option('8')
            await page.locator('#room-id').fill(room)
            await page.locator('#join-button').click()
            if index < 7:
                await screen(page, 'waiting')
                await until(lambda: len(observed.state.get('players', [])) == index + 1, f'{index + 1} humans waiting')
        for page, observed in zip(pages, observations):
            await until(lambda: observed.state.get('phase') == 'playing', 'eight humans playing')
            await screen(page, 'battle')
            state = observed.state
            assert state['arena'] == {'width': 15, 'height': 13}
            assert len(state['players']) == 8 and not any(p.get('isBot') for p in state['players'])
            assert sum(p['team'] == 'blue' for p in state['players']) == 4
            assert sum(p['team'] == 'pink' for p in state['players']) == 4
        assert len({item.player_id for item in observations}) == 8
        page, observed = pages[0], observations[0]
        await page.bring_to_front()
        initial = observed.me().copy()
        await page.locator('#arena').focus()
        await page.keyboard.press('ArrowRight')
        await until(lambda: observed.me().get('x') == initial['x'] + 1, 'human team movement')
        await page.keyboard.press('Space')
        await until(lambda: observed.me().get('bombsPlaced', 0) == 1, 'human team bomb input')
        await capture_layout(page, evidence, 'eight-human-4v4-battle', battle=True)
        assert not any(item.errors for item in observations), [item.errors for item in observations]
        evidence.result('eight-human-4v4-waiting-battle-input', 'passed', humanPlayers=8, blue=4, pink=4, bots=0, actualMovement=True, actualBomb=True)
    except Exception as error:
        if pages:
            await evidence.capture(pages[0], 'eight-human-FAILURE')
        evidence.result('eight-human-4v4-waiting-battle-input', 'failed', error=str(error), pageErrors=[o.errors for o in observations], traceback=traceback.format_exc())
        raise
    finally:
        for context in contexts:
            await context.close()


async def settings_and_training_case(browser, base, evidence):
    context = await browser.new_context(viewport={'width': 1280, 'height': 720})
    page = await context.new_page()
    observed = PublicState(page)
    try:
        await page.goto(base, wait_until='domcontentloaded')
        await open_lobby(page)
        await page.locator('#settings-open').click()
        await page.locator('#render-quality').select_option('high')
        await page.locator('#text-scale').select_option('115')
        await page.locator('[data-binding="bomb"]').click()
        await page.keyboard.press('b')
        await page.locator('#motion-toggle').click()
        await page.locator('#music-toggle').click()
        await page.locator('#sound-toggle').click()
        for selector in ['#motion-toggle', '#music-toggle', '#sound-toggle']:
            assert await page.locator(selector).get_attribute('aria-pressed') == 'true', selector
        await evidence.capture(page, 'settings-rebind-resolution-motion-audio')
        await page.locator('#settings-close').click()
        await page.locator('#quick-practice').click()
        await until(lambda: observed.state.get('phase') == 'playing', 'practice with rebound bomb key')
        await screen(page, 'battle')
        data = await capture_layout(page, evidence, 'settings-high-quality-practice', battle=True)
        assert data['buffer'] == [1800, 1560], data['buffer']
        await page.locator('#arena').focus()
        tick = observed.state['tick']
        await page.keyboard.press('Space')
        await until(lambda: observed.state.get('tick', 0) >= tick + 2, 'old bomb key observation')
        assert observed.me()['bombsPlaced'] == 0, 'old Space binding remained active'
        await page.keyboard.press('b')
        await until(lambda: observed.me().get('bombsPlaced') == 1, 'rebound B key places actual bomb')
        await page.locator('#leave-button').click()
        await screen(page, 'lobby')
        await page.reload(wait_until='domcontentloaded')
        await screen(page, 'title')
        await page.locator('#settings-open').click()
        assert await page.locator('#render-quality').input_value() == 'high'
        assert await page.locator('#text-scale').input_value() == '115'
        assert (await page.locator('[data-binding="bomb"]').inner_text()).strip() == 'B'
        assert await page.locator('#motion-toggle').get_attribute('aria-pressed') == 'true', 'reduced motion did not persist'
        # Audio remains opt-in for each page visit; only stored play preferences
        # and reduced motion are expected to survive a full reload.
        for selector in ['#music-toggle', '#sound-toggle']:
            assert await page.locator(selector).get_attribute('aria-pressed') == 'false', f'{selector} unexpectedly autoplayed on reload'
        await evidence.capture(page, 'settings-persisted-after-reload')
        # Audio checks assert control availability and opt-in behavior, not output quality.
        await page.locator('#settings-close').click()
        await open_lobby(page)
        await page.locator('#quick-training').click()
        await until(lambda: (observed.state.get('training') or {}).get('status') == 'ready', 'classic training ready')
        await screen(page, 'battle')
        await capture_layout(page, evidence, 'classic-training-ready', battle=True)
        await page.locator('#training-ready-button').click()
        await until(lambda: (observed.state.get('training') or {}).get('status') == 'active', 'classic training active')
        await capture_layout(page, evidence, 'classic-training-active', battle=True)
        await page.locator('#leave-button').click()
        await screen(page, 'lobby')
        await page.locator('#quick-friends').click()
        await screen(page, 'maps')
        await page.locator('#harmony-training-button').click()
        await until(lambda: (observed.state.get('training') or {}).get('mode') == 'harmony' and observed.state['training'].get('status') == 'ready', 'harmony training ready')
        await screen(page, 'battle')
        await capture_layout(page, evidence, 'harmony-training-ready', battle=True)
        await page.locator('#training-ready-button').click()
        await until(lambda: (observed.state.get('training') or {}).get('status') == 'active', 'harmony training active')
        await capture_layout(page, evidence, 'harmony-training-active', battle=True)
        assert not observed.errors, observed.errors
        evidence.result('settings-persistence-rebind-and-two-training-modes', 'passed', qualityBuffer=[1800, 1560], reboundBombInput=True, oldBindingInactive=True, reducedMotionPersisted=True, audioControlsAccessible=True, audioRemainsOptIn=True, classicTraining='ready→active', harmonyTraining='ready→active')
    except Exception as error:
        await evidence.capture(page, 'settings-training-FAILURE')
        evidence.result('settings-persistence-rebind-and-two-training-modes', 'failed', error=str(error), pageErrors=observed.errors, traceback=traceback.format_exc())
        raise
    finally:
        await context.close()


async def training_completion_case(browser, base, evidence):
    """Finish real lessons twice to exercise both replay and the AI handoff."""
    context = await browser.new_context(viewport={'width': 1280, 'height': 720})
    page = await context.new_page()
    observed = PublicState(page)

    async def stage(name):
        await until(lambda: (observed.state.get('training') or {}).get('stage') == name, f'training stage {name}')

    async def ready(name):
        await stage(name)
        await until(lambda: (observed.state.get('training') or {}).get('status') == 'ready', f'{name} ready')
        await page.locator('#training-ready-button').click()
        await until(lambda: (observed.state.get('training') or {}).get('status') == 'active', f'{name} active')
        await page.locator('#arena').focus()

    async def move(key, x, y):
        await page.locator('#arena').focus()
        await page.keyboard.press(key)
        await until(lambda: observed.me().get('x') == x and observed.me().get('y') == y, f'training move to {x},{y}')

    async def bomb_lesson(name):
        # Same legal input route as the original playability acceptance: lay a
        # real bomb, walk around its blast, then collect the dropped item.
        await ready(name)
        await page.keyboard.press('Space')
        await until(lambda: len(observed.state.get('orbs', [])) > 0, f'{name} real bomb')
        await move('ArrowUp', 1, 2)
        await move('ArrowUp', 1, 3)
        await move('ArrowRight', 2, 3)
        if name == 'escape':
            await stage('item')
            return
        await until(lambda: any(item.get('type') == 'wave' for item in observed.state.get('items', [])), 'real crate drops wave item')
        await until(lambda: not observed.state.get('waves'), 'real blast expires')
        await move('ArrowLeft', 1, 3)
        await move('ArrowDown', 1, 2)
        await move('ArrowDown', 1, 1)
        await move('ArrowRight', 2, 1)
        await page.keyboard.press('ArrowRight')
        await stage('rescue')

    async def finish_lessons(label):
        await bomb_lesson('escape')
        await bomb_lesson('item')
        await ready('rescue')
        await page.keyboard.press('ArrowRight')
        await stage('dart')
        await ready('dart')
        await page.keyboard.press('f')
        await until(lambda: observed.state.get('phase') == 'finished', 'all four actual lessons finished')
        assert observed.state['result']['reason'] == 'training_complete'
        assert observed.state['training']['completed'] == 4
        assert observed.me()['rescues'] >= 2 and observed.me()['itemsCollected'] >= 1
        await screen(page, 'results')
        assert await page.locator('#match-scoreboard').is_visible(), 'completed training must expose its scoreboard'
        assert await page.locator('#scoreboard-rows .score-row').count() == 8
        assert '완료' in await page.locator('#shell-result-title').inner_text(), 'completed training achievement is absent'
        assert (await page.locator('#shell-result-copy').inner_text()).strip(), 'completed training summary is empty'
        assert str(observed.me()['rescues']) in await page.locator('#rescue-recognition').inner_text()
        own_row = page.locator('#scoreboard-rows .score-row').filter(has_text='(나)')
        assert await own_row.count() == 1
        assert f'{observed.me()["score"]:,}점' in await own_row.inner_text()
        for selector in ['#replay-button', '#training-practice-button', '#training-friends-button']:
            assert await page.locator(selector).is_visible(), f'{selector} inaccessible after training completion'
        await capture_layout(page, evidence, label + '-results-achievement')
        await page.locator('#training-next-actions').scroll_into_view_if_needed()
        await capture_layout(page, evidence, label + '-results-actions')

    try:
        await page.goto(base, wait_until='domcontentloaded')
        await open_lobby(page)
        await page.locator('#quick-training').click()
        await finish_lessons('training-first-completion')
        room = observed.state['roomId']
        await page.locator('#replay-button').click()
        await until(lambda: observed.state.get('phase') == 'playing' and observed.state.get('roomId') != room, 'training replay creates fresh room')
        await screen(page, 'battle')
        assert observed.state['training']['stage'] == 'escape'
        assert observed.state['training']['completed'] == 0
        assert observed.state['training']['status'] == 'ready'
        await capture_layout(page, evidence, 'training-replay-fresh-ready', battle=True)
        await finish_lessons('training-second-completion')
        room = observed.state['roomId']
        await page.locator('#training-practice-button').click()
        await until(lambda: observed.state.get('phase') == 'playing' and observed.state.get('roomId') != room, 'completed training continues to AI practice')
        await screen(page, 'battle')
        assert observed.state['practice'] is True and observed.state['training'] is None
        assert observed.state['arena'] == {'width': 15, 'height': 13}
        assert len(observed.state['players']) == 8
        await capture_layout(page, evidence, 'training-continue-ai-practice', battle=True)
        assert not observed.errors, observed.errors
        evidence.result('four-lesson-training-results-replay-and-ai-handoff', 'passed', actualCompletions=2, lessonsPerCompletion=4, scoreboardVisible=True, achievementVisible=True, replayFreshReady=True, continuationButtonsVisible=True, aiPracticeHandoff=True)
    except Exception as error:
        await evidence.capture(page, 'training-completion-FAILURE')
        evidence.result('four-lesson-training-results-replay-and-ai-handoff', 'failed', error=str(error), pageErrors=observed.errors, traceback=traceback.format_exc())
        raise
    finally:
        await context.close()


async def main(args):
    evidence = Evidence(Path(args.output).resolve())
    assert (ROOT / 'Server/public/shell.css').exists(), 'shell.css is not ready'
    failures = []
    async with server(False, evidence) as production:
        async with async_playwright() as playwright:
            executable = args.chromium or shutil.which('chromium') or shutil.which('chromium-browser') or playwright.chromium.executable_path
            browser = await playwright.chromium.launch(executable_path=executable, headless=True, args=['--no-sandbox'])
            try:
                if args.ready_only:
                    page = await browser.new_page(viewport={'width': 1280, 'height': 720})
                    observed = PublicState(page)
                    await page.goto(production, wait_until='domcontentloaded')
                    try:
                        await screen(page, 'title')
                        await capture_layout(page, evidence, 'browser-ready-title')
                        assert not observed.errors, observed.errors
                        await open_lobby(page)
                        await capture_layout(page, evidence, 'browser-ready-lobby')
                        evidence.result('browser-ready', 'passed', pageErrors=observed.errors)
                    except Exception as error:
                        await evidence.capture(page, 'browser-ready-FAILURE')
                        evidence.result('browser-ready', 'failed', error=str(error), pageErrors=observed.errors)
                        raise
                    return
                for width, height, mobile in VIEWPORTS if args.scenario in ['all', 'views'] else []:
                    if args.viewport and args.viewport != f'{width}x{height}':
                        continue
                    try:
                        await practice_case(browser, production, evidence, width, height, mobile)
                    except Exception as error:
                        failures.append(str(error))
                if args.scenario in ['all', 'auth']:
                    try:
                        await auth_gate_case(browser, production, evidence)
                    except Exception as error:
                        evidence.result('production-guest-off-auth-gate', 'failed', error=str(error), traceback=traceback.format_exc())
                        failures.append(str(error))
                if args.scenario in ['all', 'settings'] and not args.viewport:
                    try:
                        await settings_and_training_case(browser, production, evidence)
                    except Exception as error:
                        failures.append(str(error))
                if args.scenario in ['all', 'training'] and not args.viewport:
                    try:
                        await training_completion_case(browser, production, evidence)
                    except Exception as error:
                        failures.append(str(error))
                if not args.skip_duel and args.scenario in ['all', 'duel', 'team']:
                    async with server(True, evidence) as guests:
                        if args.scenario in ['all', 'duel']:
                            try:
                                await duel_case(browser, guests, evidence)
                            except Exception as error:
                                failures.append(str(error))
                        if args.scenario in ['all', 'team'] and not args.viewport:
                            try:
                                await eight_human_case(browser, guests, evidence)
                            except Exception as error:
                                failures.append(str(error))
            finally:
                await browser.close()
    assert not failures, f'{len(failures)} scenario(s) failed; see {evidence.directory / "results.json"}'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='/tmp/poppop-game-shell')
    parser.add_argument('--chromium')
    parser.add_argument('--ready-only', action='store_true')
    parser.add_argument('--scenario', choices=['all', 'views', 'settings', 'training', 'auth', 'duel', 'team'], default='all')
    parser.add_argument('--viewport', choices=[f'{w}x{h}' for w, h, _ in VIEWPORTS])
    parser.add_argument('--skip-duel', action='store_true')
    asyncio.run(main(parser.parse_args()))
