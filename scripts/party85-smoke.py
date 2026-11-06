"""Eight Chromium players finish a three-map party with actual keys and UI readiness.

Public WebSocket frames are observed only. No game state injection, fabricated
counters, direct socket sends, game clock overrides, or shortened rounds.
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import urllib.parse
import urllib.request
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get('PARTY85_ARTIFACTS', '/tmp/poppop-party85'))
DIRECTIONS = [('ArrowUp', 0, 1), ('ArrowRight', 1, 0), ('ArrowDown', 0, -1), ('ArrowLeft', -1, 0)]


async def until(predicate, label, timeout=10):
    end = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > end:
            raise AssertionError(f'Timed out: {label}')
        await asyncio.sleep(.025)


async def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', ALLOW_DEV_GUESTS='true',
               SUPABASE_URL='', SUPABASE_ANON_KEY='', SUPABASE_SERVICE_ROLE_KEY='')
    with (ARTIFACTS / 'server.log').open('w') as log:
        server = subprocess.Popen(['node', 'src/index.js'], cwd=ROOT / 'Server', env=env, stdout=log, stderr=log)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base + '/health', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    await asyncio.sleep(.05)
            else:
                raise AssertionError('Server did not start')
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
                clients, errors, milestones, mobile_control_layouts = [], [], [], []
                try:
                    async def new_client(mobile=False):
                        context = await browser.new_context(viewport={'width': 1440, 'height': 1100},
                                                            is_mobile=mobile, has_touch=mobile, accept_downloads=True)
                        page = await context.new_page()
                        client = {'page': page, 'messages': []}
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.on('websocket', lambda ws: ws.on('framereceived', lambda frame: client['messages'].append(json.loads(frame))))
                        clients.append(client)
                        return page

                    def state(i=0):
                        return next((message for message in reversed(clients[i]['messages']) if message.get('type') == 'state'), {})

                    def identity(i):
                        return next((message['playerId'] for message in clients[i]['messages'] if message.get('type') == 'joined'), None)

                    def player(i):
                        return next((entry for entry in state().get('players', []) if entry['id'] == identity(i)), {})

                    def roster():
                        fields = ['id', 'team', 'characterId', 'skinId', 'orbSkinId']
                        return [{field: entry[field] for field in fields} for entry in state()['players']]

                    def record(label):
                        current = state()
                        milestones.append({'label': label, 'tick': current['tick'], 'mapId': current['mapId'],
                                           'series': current['series'], 'relay': current['relay'],
                                           'contributions': [{field: entry.get(field) for field in ['name', 'team', 'rescues', 'passes', 'deliveries']}
                                                             for entry in current['players']]})
                        print(f'PASS: {label} ({current["mapId"]}, tick {current["tick"]})', flush=True)

                    async def key(i, value):
                        await clients[i]['page'].locator('#arena').focus()
                        await clients[i]['page'].keyboard.press(value)

                    async def walk(i, x, y):
                        for _ in range(150):
                            current = player(i)
                            if (current['x'], current['y']) == (x, y):
                                return
                            assert state()['phase'] == 'playing', 'round ended while following real movement'
                            blocked = set(state()['solid'] + state()['soft']) | {f'{orb["x"]},{orb["y"]}' for orb in state()['orbs']}
                            queue, seen, action = [(current['x'], current['y'], None)], {(current['x'], current['y'])}, None
                            for qx, qy, first in queue:
                                if action:
                                    break
                                for direction, dx, dy in DIRECTIONS:
                                    nx, ny = qx + dx, qy + dy
                                    if not (0 < nx < 12 and 0 < ny < 10) or (nx, ny) in seen or f'{nx},{ny}' in blocked:
                                        continue
                                    seen.add((nx, ny))
                                    chosen = first or (direction, current['x'] + dx, current['y'] + dy)
                                    queue.append((nx, ny, chosen))
                                    if (nx, ny) == (x, y):
                                        action = chosen
                                        break
                            assert action, f'No route for player {i} to {x},{y}'
                            await key(i, action[0])
                            try:
                                await until(lambda: (player(i).get('x'), player(i).get('y')) == action[1:], 'physical movement', timeout=.8)
                            except AssertionError:
                                # A harbor gate may close after the public snapshot. Re-route
                                # from the next authoritative state using another physical key.
                                assert not player(i).get('bubbleTicks') and player(i).get('alive'), 'movement blocked by combat'
                        raise AssertionError('Too many route steps')

                    async def pass_to(i, target):
                        await until(lambda: state()['relay']['passCooldownTicks'] == 0, 'pass cooldown')
                        # Each browser renders its own socket frame. The captain's
                        # observed cooldown may reach zero before this passer's UI.
                        await clients[i]['page'].wait_for_function("!document.querySelector('#pass-button').disabled", timeout=3000)
                        assert not await clients[i]['page'].locator('#pass-button').is_disabled()
                        await key(i, 'g')
                        await until(lambda: state()['relay']['carrierId'] == identity(target), f'physical pass {i} to {target}')

                    async def capture_control_layout(label):
                        # Read viewport-relative rectangles before any screenshot or
                        # scrolling. Full-page images cannot prove viewport fit.
                        layout = await page.evaluate("""label => {
                            const bounds = element => {
                                const rect = element.getBoundingClientRect();
                                return {x: rect.x, y: rect.y, width: rect.width,
                                    height: rect.height, right: rect.right, bottom: rect.bottom,
                                    visible: element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})};
                            };
                            return {label, width: innerWidth, height: innerHeight,
                                scrollX, scrollY, documentWidth: document.documentElement.scrollWidth,
                                announcement: bounds(document.querySelector('#partyGoalAnnouncement')),
                                arena: bounds(document.querySelector('#arena')),
                                controls: Object.fromEntries(
                                    ['up', 'down', 'left', 'right', 'place_orb', 'use_dart', 'pass_star']
                                        .map(action => [action, bounds(document.querySelector(`[data-action="${action}"]`))]))};
                        }""", label)
                        mobile_control_layouts.append(layout)
                        (ARTIFACTS / 'mobile-control-bounds.json').write_text(json.dumps(mobile_control_layouts, indent=2))
                        print(f'LAYOUT: {json.dumps(layout)}', flush=True)
                        return layout

                    def assert_controls_fit(layout):
                        assert layout['documentWidth'] <= layout['width'], layout
                        for element in ['announcement', 'arena']:
                            bounds = layout[element]
                            assert (bounds['visible'] and bounds['x'] >= 0 and bounds['y'] >= 0
                                    and bounds['right'] <= layout['width'] and bounds['bottom'] <= layout['height']), (
                                        f"{layout['label']}: {element} outside viewport", bounds)
                        for action, bounds in layout['controls'].items():
                            assert bounds['visible'] and bounds['width'] >= 44 and bounds['height'] >= 44, (layout['label'], action, bounds)
                            assert (bounds['x'] >= 0 and bounds['y'] >= 0
                                    and bounds['right'] <= layout['width'] and bounds['bottom'] <= layout['height']), (
                                        f"{layout['label']}: {action} outside {layout['width']}x{layout['height']} viewport",
                                        {'scrollX': layout['scrollX'], 'scrollY': layout['scrollY'], 'bounds': bounds})

                    page = await new_client(mobile=True)
                    await page.goto(base)
                    await page.locator('#mode').select_option('team')
                    await page.locator('#human-slots').select_option('8')
                    await page.locator('#rule-set').select_option('relay')
                    await page.locator('#seriesModeSelect').select_option('party3')
                    await page.locator('input[name="mapId"][value="festival"]').check()
                    await page.locator('input[name="characterId"][value="bibi"]').check()
                    await page.locator('input[name="skinId"][value="mint"]').check()
                    await page.locator('#orb-skin').select_option('star')
                    await page.locator('#item-mode').uncheck()
                    await page.locator('#nickname').fill('PartyCaptain')
                    await page.locator('#invite-button').click()
                    invite = await page.locator('#invite-url').input_value()
                    query = urllib.parse.parse_qs(urllib.parse.urlparse(invite).query)
                    assert query['series'] == ['party3'] and query['map'] == ['festival'] and query['rules'] == ['relay'], query
                    await page.screenshot(path=str(ARTIFACTS / 'party-lobby.png'), full_page=True)
                    await page.locator('#join-button').click()
                    for i in range(1, 8):
                        other = await new_client()
                        await other.goto(invite)
                        assert await other.locator('#seriesModeSelect').input_value() == 'party3'
                        await other.locator('#nickname').fill(f'PartyFriend{i}')
                        await other.locator('#join-button').click()
                    await until(lambda: state().get('phase') == 'playing', 'eight humans start')
                    assert len(state()['players']) == 8 and not any(entry['isBot'] for entry in state()['players'])
                    assert state()['ranked'] is False and state()['series']['mapCycle'] == ['festival', 'harbor', 'garden']
                    original_roster, series_id = roster(), state()['series']['id']
                    assert '3라운드 파티' in await page.locator('#match-kind').inner_text()
                    record('invited eight humans enter the selected non-ranked party')

                    for round_number, map_id in enumerate(['festival', 'harbor', 'garden'], start=1):
                        await until(lambda: state().get('phase') == 'playing' and state()['series']['round'] == round_number, 'next party round')
                        assert state()['mapId'] == map_id and roster() == original_roster
                        assert state()['series']['id'] == series_id
                        assert all(entry['rescues'] == 0 and entry['passes'] == 0 and entry['deliveries'] == 0 for entry in state()['players'])
                        assert await page.locator('#seriesHud').get_attribute('data-round') == str(round_number)
                        await page.screenshot(path=str(ARTIFACTS / f'round-{round_number}-{map_id}.png'), full_page=True)
                        if round_number == 1:
                            # Two real bombs trap the same teammate twice; each actual
                            # rescue increments the server counter through movement.
                            await walk(2, 2, 5)
                            await walk(0, 4, 4)
                            for rescue_count in [1, 2]:
                                await key(2, 'Space')
                                await until(lambda: player(2)['bubbleTicks'] > 0, 'teammate trapped by real orb', timeout=4)
                                await until(lambda: not state()['waves'], 'blast waves expire')
                                await walk(0, 4, 5)
                                await walk(0, 3, 5)
                                await until(lambda: player(0)['rescues'] == rescue_count and player(2)['bubbleTicks'] == 0, 'actual rescue credited')
                                if rescue_count == 1:
                                    await walk(0, 4, 4)
                            assert state()['series']['mission']['progress'] == {'blue': 2, 'pink': 0}
                            record('two actual rescues complete the first cooperation goal')
                            await page.screenshot(path=str(ARTIFACTS / 'rescue-bonus.png'), full_page=True)
                        if round_number == 3:
                            await page.locator('#settings-open').click()
                            await page.locator('#text-scale').select_option('130')
                            await page.locator('#settings-close').click()
                            await page.set_viewport_size({'width': 390, 'height': 844})
                            assert await page.locator('body').get_attribute('data-font-scale') == '130'
                            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'party mobile overflow'
                            await walk(0, 6, 5)
                            await until(lambda: state()['relay']['carrierId'] == identity(0), 'center star pickup')
                            await walk(2, 4, 5)
                            await walk(0, 5, 5)  # Face left toward teammate.
                            await pass_to(0, 2)
                            await walk(2, 3, 5)
                            await walk(2, 4, 5)  # Face right toward captain.
                            await pass_to(2, 0)
                            await pass_to(0, 2)
                            assert state()['series']['mission']['progress'] == {'blue': 3, 'pink': 0}
                            await page.locator('#partyGoalAnnouncement').wait_for(state='visible')
                            announcement = await page.locator('#partyGoalAnnouncement').inner_text()
                            assert '달성' in announcement and '+1' in announcement, announcement
                            assert await page.locator('#partyGoalAnnouncement').get_attribute('role') == 'status'
                            portrait_layout = await capture_control_layout('goal-mobile-130')
                            await page.screenshot(path=str(ARTIFACTS / 'goal-mobile-130-viewport.png'))
                            await page.screenshot(path=str(ARTIFACTS / 'goal-mobile-130.png'), full_page=True)
                            await page.set_viewport_size({'width': 844, 'height': 390})
                            landscape_layout = await capture_control_layout('goal-landscape-130')
                            await page.screenshot(path=str(ARTIFACTS / 'goal-landscape-130-viewport.png'))
                            await page.screenshot(path=str(ARTIFACTS / 'goal-landscape-130.png'), full_page=True)
                            assert_controls_fit(portrait_layout)
                            assert_controls_fit(landscape_layout)
                            await page.set_viewport_size({'width': 1440, 'height': 1100})
                            record('three successful physical passes complete the final cooperation goal')
                            await page.screenshot(path=str(ARTIFACTS / 'pass-bonus.png'), full_page=True)
                            courier = 2
                        else:
                            courier = 0
                            await walk(courier, 6, 5)
                            await until(lambda: state()['relay']['carrierId'] == identity(courier), 'center star pickup')
                        for delivery in [1, 2, 3]:
                            await walk(courier, 1, 5)
                            await until(lambda: state()['relay']['scores']['blue'] == delivery, f'actual relay delivery {delivery}')
                            if delivery < 3:
                                await walk(courier, 6, 5)
                                await until(lambda: state()['relay']['carrierId'] == identity(courier), 'normal star respawn', timeout=7)
                        await until(lambda: state()['phase'] == 'finished', 'three deliveries finish the round')
                        assert state()['result']['reason'] == 'relay_goal'
                        assert state()['result']['relayScores'] == {'blue': 3, 'pink': 0}
                        assert state()['series']['history'][-1]['points'] == {'blue': 3 if round_number != 2 else 2, 'pink': 0}
                        assert await page.locator('#seriesHistory li').count() == round_number
                        await page.locator('#result-saving[data-status="unranked"]').wait_for()
                        next_step = await page.locator('#seriesGoalNextStep').inner_text()
                        assert '기록' in next_step and '준비 버튼' in next_step, next_step
                        assert '전달하세요' not in next_step and '살아남' not in next_step, next_step
                        assert ('다음 라운드' if round_number < 3 else '새 3라운드 파티') in next_step, next_step
                        record(f'round {round_number} finishes with authoritative points and visible history')
                        await page.screenshot(path=str(ARTIFACTS / f'round-{round_number}-result.png'), full_page=True)
                        if round_number < 3:
                            await page.locator('#replay-button').click()
                            await until(lambda: identity(0) in state()['rematch']['readyPlayerIds'], 'captain ready')
                            assert '준비 취소' in await page.locator('#replay-button').inner_text()
                            await page.locator('#replay-button').click()
                            await until(lambda: identity(0) not in state()['rematch']['readyPlayerIds'], 'captain cancels readiness')
                            assert state()['phase'] == 'finished'
                            for client in clients:
                                await client['page'].locator('#replay-button').click()

                    complete = state()['series']
                    assert complete['complete'] is True and complete['points'] == {'blue': 8, 'pink': 0}
                    assert complete['outcome'] == {'winnerTeam': 'blue'} and len(complete['history']) == 3
                    assert len({entry['matchId'] for entry in complete['history']}) == 3
                    own = next(entry for entry in complete['contributions'] if entry['playerId'] == identity(0))
                    assert {field: own[field] for field in ['score', 'rescues', 'passes', 'deliveries', 'bombsPlaced', 'itemsCollected', 'interceptions']} == {
                        'score': 1600, 'rescues': 2, 'passes': 2, 'deliveries': 6, 'bombsPlaced': 0, 'itemsCollected': 0, 'interceptions': 0}
                    assert [next(entry for entry in row['contributions'] if entry['playerId'] == identity(0))['rescues']
                            for row in complete['history']] == [2, 0, 0]
                    assert next(entry for entry in state()['result']['scoreboard'] if entry['id'] == identity(0))['rescues'] == 0
                    personal_text = await page.locator('#partyOwnTotals').inner_text()
                    for value in ['1600', '구출 2회', '패스 2회', '전달 6회']:
                        assert value in personal_text, personal_text
                    assert await page.locator('#partyOwnRounds li').count() == 3
                    assert '구출 2회' in await page.locator('#partyOwnRounds li').first.inner_text()
                    assert '구출 0회' in await page.locator('#partyOwnRounds li').last.inner_text()
                    assert '8' in await page.locator('#seriesResultTitle').inner_text()
                    assert '새 3라운드 파티 준비' in await page.locator('#replay-button').inner_text()
                    await page.screenshot(path=str(ARTIFACTS / 'party-complete.png'), full_page=True)
                    # Read-only projection of an observed public frame; it does not
                    # inject state into the running game or send any socket command.
                    card = await page.evaluate("""async ({snapshot, playerId}) => {
                        const {createResultCardData} = await import('/share.js');
                        return createResultCardData(snapshot, playerId);
                    }""", {'snapshot': state(), 'playerId': identity(0)})
                    assert card['party'] is True and card['score'] == 1600 and card['rescues'] == 2
                    assert card['passes'] == 2 and card['deliveries'] == 6 and card['outcome'] == 'victory'
                    async with page.expect_download() as download_info:
                        await page.locator('#download-result-button').click()
                    download = await download_info.value
                    assert not await download.failure()
                    destination = ARTIFACTS / 'my-party-result.png'
                    await download.save_as(destination)
                    data = destination.read_bytes()
                    assert data[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II', data[16:24]) == (1200, 630)
                    record('final personal history and downloaded card retain first-round rescues and all three-round contributions')
                    for client in clients:
                        await client['page'].locator('#replay-button').click()
                    await until(lambda: state()['series']['id'] != series_id, 'explicit agreement starts a fresh party')
                    assert state()['series']['round'] == 1 and state()['mapId'] == 'festival'
                    assert state()['series']['points'] == {'blue': 0, 'pink': 0} and not state()['series']['history']
                    assert not state()['series']['contributions']
                    assert not await page.locator('#partyOwnTotals').is_visible()
                    assert roster() == original_roster
                    assert all(sum(message.get('type') == 'joined' for message in client['messages']) == 1 for client in clients)
                    leaderboard = await (await page.request.get(base + '/api/leaderboard')).json()
                    assert leaderboard['entries'] == [] and not errors, errors
                    record('explicit new-party agreement preserves all sockets and cosmetics and resets totals')
                    await page.screenshot(path=str(ARTIFACTS / 'fresh-party.png'), full_page=True)
                    (ARTIFACTS / 'milestones.json').write_text(json.dumps({'milestones': milestones,
                        'completedSeries': complete, 'ownPartyCard': card, 'downloadedCard': str(destination),
                        'mobileControlLayouts': mobile_control_layouts,
                        'pageErrors': errors, 'realTimeGameplay': True}, ensure_ascii=False, indent=2))
                    print(f'PASS: three real rounds, two actual cooperation goals, 8:0 aggregate, whole-party own card and mobile130% goal caption; evidence: {ARTIFACTS}', flush=True)
                except Exception:
                    if clients:
                        await clients[0]['page'].screenshot(path=str(ARTIFACTS / 'failure.png'), full_page=True)
                        (ARTIFACTS / 'failure-state.json').write_text(json.dumps({'state': state(), 'pageErrors': errors,
                            'milestones': milestones, 'mobileControlLayouts': mobile_control_layouts}, ensure_ascii=False, indent=2))
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
