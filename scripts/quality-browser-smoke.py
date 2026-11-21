"""Exercise the skin shop, keyboard input, reload recovery and ranked queue rejection in real browsers.

Run: python3 scripts/quality-browser-smoke.py --browser all
Requires Python Playwright, installed browser engines, and Server dependencies.
Starts isolated guest servers for two-player duels and a capacity-limited queue.
Only public protocol messages are observed; game state and clocks are unchanged.
Evidence is retained on both success and failure. Missing engines fail the gate.
"""
import argparse
import asyncio
import importlib.util
import json
from pathlib import Path
import shutil
import traceback
import time

from playwright.async_api import async_playwright


SPEC = importlib.util.spec_from_file_location('quality_game_shell', Path(__file__).with_name('game-shell-smoke.py'))
shell = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(shell)
ENGINES = ('chromium', 'firefox', 'webkit')


async def portrait_pixels(canvas):
    """Compare actual canvas artwork within one browser, without platform-specific golden images."""
    return await canvas.evaluate("""canvas => {
        const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        const pixels = new Uint32Array(image.data.buffer);
        if (!pixels.some(pixel => pixel !== pixels[0])) throw new Error('Blank portrait canvas');
        return canvas.toDataURL();
    }""")


async def cat_shop_to_practice(browser, base, evidence):
    page = await browser.new_page(viewport={'width': 1280, 'height': 800}, reduced_motion='reduce')
    page.set_default_timeout(8000)
    observed = shell.PublicState(page)
    try:
        await page.goto(base)
        await shell.open_lobby(page)
        shop_entry = page.locator('#screen-lobby button[data-screen="shop"]')
        assert await shop_entry.is_visible(), 'Missing item shop entry on the lobby screen'
        await shop_entry.click()
        await shell.screen(page, 'shop')
        preview, equip = page.locator('#shop-preview'), page.locator('#shop-equip')
        assert await preview.is_visible(), 'The shop portrait is hidden'
        selected = page.locator('#join-form input[name="skinId"]:checked')
        classic = page.locator('[data-shop-skin="classic"]')
        await classic.click()
        assert await selected.input_value() == 'classic' and await equip.is_disabled()
        portraits = {await portrait_pixels(preview)}
        thumbnails = {await portrait_pixels(classic.locator('canvas'))}
        loadouts = {await portrait_pixels(page.locator('#appearance-preview'))}
        previous = 'classic'
        for skin_id, name in [('tabby', '치즈태비'), ('tuxedo', '턱시도 고양이'), ('cat', '삼색 고양이')]:
            card = page.locator(f'[data-shop-skin="{skin_id}"]')
            await card.click()
            assert await card.get_attribute('aria-pressed') == 'true', f'{name} is not selected for preview'
            assert await page.locator('#shop-name').text_content() == name
            assert await selected.input_value() == previous and await equip.is_enabled(), f'Preview equipped {name}'
            portrait = await portrait_pixels(preview)
            canvas = card.locator('canvas')
            assert await canvas.is_visible(), f'Missing shop thumbnail for {name}'
            thumbnail = await portrait_pixels(canvas)
            assert portrait not in portraits and thumbnail not in thumbnails, f'Duplicate shop artwork for {name}'
            portraits.add(portrait)
            thumbnails.add(thumbnail)

            await equip.click()
            assert await selected.input_value() == skin_id, f'Join form did not equip {name}'
            assert await equip.is_disabled() and await card.get_attribute('data-equipped') == 'true'
            loadout = await portrait_pixels(page.locator('#appearance-preview'))
            assert loadout not in loadouts, f'Loadout portrait did not change to {name}'
            loadouts.add(loadout)
            previous = skin_id

        await page.set_viewport_size({'width': 390, 'height': 844})
        wave_item = page.locator('#shop-practice-items input[name="practiceItemId"][value="wave"]')
        assert await wave_item.count() == 1, 'Missing wave starter item in the shop'
        await page.get_by_role('button', name='연습 아이템', exact=False).click()
        assert await page.locator('#shop-practice-items fieldset').evaluate('node => node === document.activeElement')
        await wave_item.check()
        await shell.capture_layout(page, evidence, 'cat-shop-phone-equipment')
        await classic.click()
        assert await selected.input_value() == 'cat' and await equip.is_enabled()
        await page.reload()
        await shell.open_lobby(page)
        assert await selected.input_value() == 'cat', 'Reload lost the equipped calico after previewing classic'
        await shop_entry.click()
        await shell.screen(page, 'shop')
        assert await wave_item.is_checked(), 'Reload lost the wave starter item'
        await shell.capture_layout(page, evidence, 'cat-shop-phone')
        await page.set_viewport_size({'width': 1280, 'height': 800})
        await shell.capture_layout(page, evidence, 'cat-shop-desktop')
        await page.locator('[data-shop-skin="cat"]').click()
        assert await equip.is_disabled(), 'Reload lost the shop equipped state'
        await page.locator('#screen-shop button[data-screen="lobby"]').click()
        await shell.screen(page, 'lobby')
        await page.locator('#quick-practice').click()
        await shell.until(lambda: observed.state.get('practice') and observed.state.get('phase') == 'playing'
                          and observed.me(), 'practice state for the shop player')
        await shell.screen(page, 'battle')
        first_state = next(message for message in observed.messages if message.get('type') == 'state')
        player = next(player for player in first_state['players'] if player['id'] == observed.player_id)
        assert player['skinId'] == 'cat', 'Server did not use the equipped calico'
        assert player['range'] == 4, 'The wave starter item did not increase the initial practice range'
        assert not observed.errors, observed.errors
        evidence.result('cat-shop-to-practice', 'passed', equipped=['tabby', 'tuxedo', 'cat'],
                        practiceSkin=player['skinId'], startingRange=player['range'])
    except Exception as error:
        evidence.result('cat-shop-to-practice', 'failed', error=str(error), traceback=traceback.format_exc())
        await evidence.capture(page, 'cat-shop-FAILURE')
        raise
    finally:
        await page.close()


async def practice_after_full_queue(browser, base, evidence):
    """A rejected ranked search releases the connection slot needed to start practice."""
    pages = []

    async def start_ranked_search():
        page = await browser.new_page()
        pages.append(page)
        page.set_default_timeout(8000)
        observed = shell.PublicState(page)
        await page.goto(base)
        await shell.open_lobby(page)
        await page.locator('#quick-friends').click()
        await page.locator('#rankedButton').click()
        return page, observed

    try:
        _, waiting = await start_ranked_search()
        await shell.until(lambda: any(m.get('status') == 'searching' for m in waiting.messages), 'first ranked ticket')
        page, observed = await start_ranked_search()
        await shell.until(lambda: any(m.get('code') == 'queue_full' for m in observed.messages), 'full ranked queue')
        await shell.screen(page, 'lobby')
        await page.locator('#quick-practice').click()
        await shell.until(lambda: observed.state.get('practice') and observed.state.get('phase') == 'playing',
                          'practice after ranked queue rejection')
        await shell.screen(page, 'battle')
        assert not observed.errors, observed.errors
        evidence.result('practice-after-full-queue', 'passed')
    except Exception as error:
        evidence.result('practice-after-full-queue', 'failed', error=str(error))
        raise
    finally:
        for page in pages:
            await page.close()


async def exercise(browser, base, evidence):
    contexts, pages, observations = [], [], []
    room = f'quality-browser-{time.time_ns()}'
    try:
        for index in range(2):
            context = await browser.new_context(viewport={'width': 1280, 'height': 720})
            contexts.append(context)
            page = await context.new_page()
            pages.append(page)
            page.set_default_timeout(8000)
            observed = shell.PublicState(page)
            observations.append(observed)
            await page.goto(base, wait_until='domcontentloaded')
            await shell.capture_layout(page, evidence, f'player-{index}-title')
            await shell.open_lobby(page)
            await page.locator('#quick-friends').click()
            await shell.screen(page, 'maps')
            await page.locator('#mode').select_option('duel')
            await page.locator('#room-id').fill(room)
            await page.locator('input[name="mapId"][value="lagoon"]').check()
            await page.locator('#item-mode').uncheck()
            await page.locator('#join-button').click()
            if index == 0:
                await shell.screen(page, 'waiting')
        for page, observed in zip(pages, observations):
            await shell.until(lambda: observed.state.get('phase') == 'playing', 'two-human browser match')
            await shell.screen(page, 'battle')
            assert len(observed.state['players']) == 2 and not any(p.get('isBot') for p in observed.state['players'])

        page, observed = pages[0], observations[0]
        identity, match = observed.player_id, observed.state['matchId']

        async def move(key, x, y):
            await page.locator('#arena').focus()
            await page.keyboard.press(key)
            await shell.until(lambda: (observed.me().get('x'), observed.me().get('y')) == (x, y), f'keyboard {key} to {x},{y}')

        async def bomb(count):
            await page.locator('#arena').focus()
            await page.keyboard.press('Space')
            await shell.until(lambda: observed.me().get('bombsPlaced') == count, 'keyboard bomb placement')

        await page.bring_to_front()
        await bomb(1)
        for key, x, y in [('ArrowUp', 1, 2), ('ArrowUp', 1, 3), ('ArrowRight', 2, 3)]:
            await move(key, x, y)
        await shell.until(lambda: not observed.state.get('orbs') and not observed.state.get('waves'), 'natural bomb fuse and wave expiry')
        assert observed.me()['alive'] and not observed.me()['bubbleTicks']
        await shell.capture_layout(page, evidence, 'input-before-reload', battle=True)
        previous = {key: observed.me()[key] for key in ('id', 'x', 'y', 'bombsPlaced')}
        previous_joins = sum(m.get('type') == 'joined' for m in observed.messages)

        await page.reload(wait_until='domcontentloaded')
        await shell.until(lambda: sum(m.get('type') == 'joined' for m in observed.messages) > previous_joins, 'real reload resume message')
        joined = next(m for m in reversed(observed.messages) if m.get('type') == 'joined')
        assert joined.get('resumed') is True and joined['playerId'] == identity, 'reload must resume the same participant'
        await page.locator('#arena[data-connection="connected"]').wait_for()
        await shell.screen(page, 'battle')
        await shell.until(lambda: observed.state.get('matchId') == match and observed.me().get('connected') is True, 'resumed match state')
        assert all(observed.me()[key] == value for key, value in previous.items()), 'reload lost authoritative progress'
        assert len(observed.state['players']) == 2, 'reload duplicated a player'
        await shell.capture_layout(page, evidence, 'resumed-after-reload', battle=True)

        await move('ArrowRight', 3, 3)
        await bomb(2)
        for key, x, y in [('ArrowLeft', 2, 3), ('ArrowLeft', 1, 3), ('ArrowDown', 1, 2)]:
            await move(key, x, y)
        await shell.until(lambda: not observed.state.get('orbs') and not observed.state.get('waves'), 'post-reload natural bomb fuse')
        assert observed.me()['alive'] and not observed.me()['bubbleTicks']
        assert observed.player_id == identity and observed.state['matchId'] == match
        await shell.capture_layout(page, evidence, 'input-after-reload', battle=True)
        assert not any(o.errors for o in observations), [o.errors for o in observations]
        evidence.result('two-human-reload-input', 'passed', humanPlayers=2, bots=0,
                        resumedSamePlayer=True, preservedMatchAndProgress=True,
                        keyboardMovementBeforeAndAfter=True, keyboardBombBeforeAndAfter=True,
                        pageErrors=[o.errors for o in observations])
    except Exception as error:
        for index, page in enumerate(pages):
            try:
                await evidence.capture(page, f'player-{index}-FAILURE')
            except Exception:
                pass  # Retain the original failure if a closed page cannot be captured.
        evidence.result('two-human-reload-input', 'failed', error=str(error),
                        pageErrors=[o.errors for o in observations], traceback=traceback.format_exc())
        raise
    finally:
        for context in contexts:
            await context.close()


async def main(args):
    directory = Path(args.output)
    directory.mkdir(parents=True, exist_ok=True)
    engines = ENGINES if args.browser == 'all' else (args.browser,)
    results = []
    service_evidence = shell.Evidence(directory)
    queue_evidence = shell.Evidence(directory / 'bounded-queue')
    queue_limits = {'RUNTIME_MAX_CONNECTIONS': '2', 'RUNTIME_MAX_QUEUED_PLAYERS': '1'}
    async with (
        shell.server(True, service_evidence) as base,
        shell.server(True, queue_evidence, runtime_limits=queue_limits) as queue_base,
        async_playwright() as pw,
    ):
        for engine in engines:
            evidence = shell.Evidence(directory / engine)
            browser = None
            try:
                options = {}
                if engine == 'chromium':
                    executable = args.chromium or shutil.which('chromium')
                    if executable:
                        options['executable_path'] = executable
                    options['args'] = ['--no-sandbox']
                browser = await getattr(pw, engine).launch(**options)
                version = browser.version
                await cat_shop_to_practice(browser, base, evidence)
                await exercise(browser, base, evidence)
                await practice_after_full_queue(browser, queue_base, evidence)
                results.append({'browser': engine, 'version': version, 'status': 'passed'})
            except Exception as error:
                if not evidence.results:
                    evidence.result('browser-launch', 'failed', error=str(error), traceback=traceback.format_exc())
                results.append({'browser': engine, 'status': 'failed', 'error': str(error)})
            finally:
                if browser is not None:
                    await browser.close()
                (directory / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results, indent=2), flush=True)
    return 1 if any(result['status'] != 'passed' for result in results) else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', choices=('all', *ENGINES), default='all')
    parser.add_argument('--output', default='/tmp/crazyacade-quality-browsers')
    parser.add_argument('--chromium', help='Optional Chromium executable path')
    raise SystemExit(asyncio.run(main(parser.parse_args())))
