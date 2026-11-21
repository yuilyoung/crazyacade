"""Exercise keyboard input, reload recovery and ranked queue rejection in real browsers.

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
