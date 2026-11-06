"""Eight real Chromium participants: authenticated queue, recovery, ready/cancel and next match.

The provider is a strict local HTTP fixture with eight distinct verified IDs/ratings,
not a live Supabase service. Production clock and gameplay run unchanged. Normal
keyboard orb inputs end rounds; no browser or server game state is injected.
"""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
from threading import Event, Lock, Thread
from urllib.parse import parse_qs, urlsplit
import urllib.request
from playwright.async_api import async_playwright
from arena_smoke_helpers import assert_arena

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get('BENCHMARK85_ARTIFACT_DIR', '/tmp'))


# The fixture delegates rating policy to the production pure module. Structured
# stdin carries only its own verified profiles/result; no second Elo formula lives here.
ELO_COMMAND = r"""
import { readFileSync } from 'node:fs';
import { calculateRatingChanges, applyRatingDelta } from './src/rating.js';
const { mode, participants } = JSON.parse(readFileSync(0, 'utf8'));
const deltas = calculateRatingChanges(mode, participants);
const ratings = participants.map(player => ({ userId: player.userId, outcome: player.outcome,
  before: player.rating, delta: deltas.get(player.userId),
  after: applyRatingDelta(player.rating, deltas.get(player.userId)) }));
const teamMeans = Object.fromEntries(['blue', 'pink'].map(team => {
  const players = participants.filter(player => player.team === team);
  return [team, players.length ? players.reduce((sum, player) => sum + player.rating, 0) / players.length : null];
}));
process.stdout.write(JSON.stringify({ ratings, teamMeans }));
"""


def record_fixture_match(users, calls, lock, payload):
    """Atomically accept a local fixture result once, including concurrent retries."""
    with lock:
        calls['resultAttempts'].append(payload['p_match_id'])
        if any(record['p_match_id'] == payload['p_match_id'] for record in calls['results']):
            return False
        participants = [{'userId': player['user_id'], 'team': player.get('team'),
                         'rating': users[player['user_id']]['rating'], 'outcome': player['outcome']}
                        for player in payload['p_participants']]
        completed = subprocess.run(['node', '--input-type=module', '-e', ELO_COMMAND], cwd=ROOT/'Server',
                                   input=json.dumps({'mode': payload['p_mode'], 'participants': participants}),
                                   text=True, capture_output=True, check=True, timeout=5)
        update = json.loads(completed.stdout)
        for rating in update['ratings']:
            users[rating['userId']]['rating'] = rating['after']
        calls['eloUpdates'].append({'matchId': payload['p_match_id'], **update})
        calls['results'].append(payload)
        return True


async def until(predicate, timeout=12, label='state'):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f'Timed out waiting for {label}')
        await asyncio.sleep(.04)


async def cancellation_assignment_race(pw):
    """Delay actual inbound WebSocket frames; game state and browser commands stay real."""
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ, HOST='127.0.0.1', PORT=str(port), ALLOW_DEV_GUESTS='true',
               SUPABASE_URL='', SUPABASE_ANON_KEY='', SUPABASE_SERVICE_ROLE_KEY='', RUNTIME_DRAIN_MS='20')
    with tempfile.TemporaryFile() as log:
        server = subprocess.Popen(['node', 'src/index.js'], cwd=ROOT/'Server', env=env, stdout=log, stderr=log)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base+'/health', timeout=.3):
                        break
                except OSError:
                    await asyncio.sleep(.05)
            else:
                raise AssertionError('Cancellation fixture server failed to start')
            browser = await pw.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
            clients, errors = [], []
            delayed = {'hold': False, 'frames': [], 'route': None}
            async def route_socket(route):
                upstream = route.connect_to_server()
                delayed['route'] = route
                def receive(message):
                    if delayed['hold']:
                        delayed['frames'].append(message)
                    else:
                        route.send(message)
                upstream.on_message(receive)
            for i in range(8):
                page = await browser.new_page(viewport={'width': 1280, 'height': 900})
                client = {'page': page, 'messages': [], 'sent': []}
                def connect(ws, client=client):
                    ws.on('framereceived', lambda raw: client['messages'].append(json.loads(raw)))
                    ws.on('framesent', lambda raw: client['sent'].append(json.loads(raw)))
                page.on('websocket', connect)
                page.on('pageerror', lambda error: errors.append(str(error)))
                if i == 0:
                    await page.route_web_socket('**', route_socket)
                await page.goto(base)
                await page.locator('#rankedButton:not([disabled])').wait_for()
                await page.locator('#rankedButton').click()
                clients.append(client)
            def state(client):
                return next((m for m in reversed(client['messages']) if m.get('type') == 'state'), {})
            def own(client):
                return next(m['playerId'] for m in reversed(client['messages']) if m.get('type') == 'joined')
            await until(lambda: all(state(c).get('phase') == 'playing' for c in clients), label='race initial assignment')
            blue_ids = {p['id'] for p in state(clients[0])['players'] if p['team'] == 'blue'}
            for client in clients:
                if own(client) in blue_ids:
                    await client['page'].locator('#arena').focus()
                    await client['page'].keyboard.press('Space')
            await until(lambda: all(state(c).get('phase') == 'finished' for c in clients), timeout=15, label='race initial real finish')
            for client in clients[1:]:
                await client['page'].locator('#nextMatchButton').click()
                await client['page'].locator('#matchmakingPanel[data-status="searching"]').wait_for()
            first = clients[0]
            delayed['hold'] = True
            await first['page'].locator('#nextMatchButton').click()
            await until(lambda: any(json.loads(frame).get('type') == 'joined' for frame in delayed['frames']), label='server committed assignment before client cancellation')
            assignment = next(json.loads(frame) for frame in delayed['frames'] if json.loads(frame).get('type') == 'joined')
            await first['page'].locator('#queueCancelButton').click()
            assert '취소' in await first['page'].locator('#queueStatus').inner_text()
            frames = delayed['frames'][:]
            delayed['frames'].clear(); delayed['hold'] = False
            for frame in frames:
                delayed['route'].send(frame)
            await first['page'].locator('#rankedButton:not([disabled])').wait_for()
            await until(lambda: any(m.get('type') == 'leave' for m in first['sent']), label='cancelled assigned participant leaves')
            await until(lambda: all(state(c).get('roomId') == assignment['roomId'] and len(state(c).get('players', [])) == 7 for c in clients[1:]), label='no orphan eighth participant')
            assert not await first['page'].locator('#nextMatchButton').is_visible()
            assert not await first['page'].locator('#match-scoreboard').is_visible()
            assert await first['page'].locator('#arena').get_attribute('data-connection') == 'disconnected'
            await first['page'].locator('#rankedButton').click()
            await first['page'].locator('#matchmakingPanel[data-status="searching"]').wait_for()
            assert not errors, errors
            await browser.close()
            return {'inboundFramesDelayed': True, 'committedAssignmentCancelled': True,
                    'leaveObserved': True, 'remainingRoster': 7, 'newerSearchAllowed': True, 'pageErrors': errors}
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill(); server.wait()


async def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    lock = Lock()
    users, tokens, calls = {}, {}, {'verified': [], 'profiles': [], 'results': [], 'eloUpdates': [], 'resultAttempts': []}
    controls = {'fail_profile': None, 'hold_profile': None}
    profile_started, release_profile = Event(), Event()

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, payload, status=200):
            body = json.dumps(payload).encode() if status != 204 else b''
            self.send_response(status)
            for key, value in {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
                               'Access-Control-Allow-Headers': 'apikey,content-type,authorization',
                               'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Content-Length': str(len(body))}.items():
                self.send_header(key, value)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_OPTIONS(self):
            self.reply(None, 204)

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or '{}')
            if self.path == '/auth/v1/signup':
                with lock:
                    number = len(users) + 1
                    uid = f'00000000-0000-4000-8000-{number:012d}'
                    token = f'fixture-access-{number}'
                    users[uid] = {'id': uid, 'rating': 1250 + (number - 1) * 10, 'nickname': f'Ranked{number}'}
                    tokens[token] = uid
                self.reply({'access_token': token, 'refresh_token': f'fixture-refresh-{number}',
                            'expires_in': 3600, 'user': {'id': uid}})
            elif self.path.startswith('/rest/v1/profiles'):
                assert self.headers.get('Authorization') == 'Bearer fixture-service-key'
                assert payload['id'] in users and set(payload) == {'id', 'nickname'}
                with lock:
                    users[payload['id']]['nickname'] = payload['nickname']
                self.reply([])
            elif self.path == '/rest/v1/rpc/record_match':
                assert self.headers.get('Authorization') == 'Bearer fixture-service-key'
                record_fixture_match(users, calls, lock, payload)
                self.reply([])
            else:
                self.reply({'error': 'unexpected fixture route'}, 400)

        def do_GET(self):
            parts = urlsplit(self.path)
            if parts.path == '/auth/v1/user':
                token = self.headers.get('Authorization', '').removeprefix('Bearer ')
                uid = tokens.get(token)
                if not uid:
                    self.reply({}, 401)
                    return
                with lock:
                    calls['verified'].append(uid)
                self.reply({'id': uid, 'user_metadata': {}})
            elif parts.path == '/rest/v1/profiles':
                query = parse_qs(parts.query)
                if query.get('select') == ['id,rating']:
                    assert self.headers.get('Authorization') == 'Bearer fixture-service-key'
                    uid = query['id'][0].removeprefix('eq.')
                    with lock:
                        calls['profiles'].append(uid)
                    if controls['hold_profile'] == uid:
                        profile_started.set()
                        release_profile.wait(timeout=5)
                    if controls['fail_profile'] == uid:
                        self.reply({}, 503)
                    else:
                        with lock:
                            profiles = [{'id': uid, 'rating': users[uid]['rating']}] if uid in users else []
                        self.reply(profiles)
                else:
                    with lock:
                        profiles = [{'nickname': p['nickname'], 'rating': p['rating'], 'wins': 0, 'losses': 0, 'draws': 0, 'score': 0} for p in users.values()]
                    self.reply(profiles)
            else:
                self.reply({}, 404)

    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    thread = Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    evidence, errors = {}, []
    with tempfile.TemporaryDirectory(prefix='poppop-ranked85-') as storage, tempfile.TemporaryFile() as log:
        env = dict(os.environ, HOST='127.0.0.1', PORT=str(port), ALLOW_DEV_GUESTS='false',
                   SUPABASE_URL=f'http://127.0.0.1:{provider.server_port}', SUPABASE_ANON_KEY='fixture-public-key',
                   SUPABASE_SERVICE_ROLE_KEY='fixture-service-key', RESULT_OUTBOX_DIR=storage, RUNTIME_DRAIN_MS='20')
        server = subprocess.Popen(['node', 'src/index.js'], cwd=ROOT/'Server', env=env, stdout=log, stderr=log)
        browser = None
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base+'/health', timeout=.3):
                        break
                except OSError:
                    await asyncio.sleep(.05)
            else:
                raise AssertionError('Game server failed to start')
            async with async_playwright() as pw:
                browser = await pw.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
                clients = []
                for number in range(8):
                    context = await browser.new_context(viewport={'width': 390 if number == 0 else 1280, 'height': 844 if number == 0 else 900}, has_touch=True)
                    page = await context.new_page()
                    client = {'page': page, 'messages': [], 'sent': [], 'connections': 0}
                    def connect(ws, client=client):
                        client['connections'] += 1
                        ws.on('framereceived', lambda raw: client['messages'].append(json.loads(raw)))
                        ws.on('framesent', lambda raw: client['sent'].append(json.loads(raw)))
                    page.on('websocket', connect)
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    await page.goto(base)
                    await page.locator('#rankedButton:not([disabled])').wait_for()
                    await page.locator('#nickname').fill(f'Ranked{number+1}')
                    clients.append(client)
                def state(client):
                    return next((m for m in reversed(client['messages']) if m.get('type') == 'state'), {})
                def joined(client):
                    return [m for m in client['messages'] if m.get('type') == 'joined']
                first, page = clients[0], clients[0]['page']
                await page.locator('#settings-open').click()
                await page.locator('#text-scale').select_option('130')
                await page.keyboard.press('Escape')
                await page.locator('#rankedButton').click()
                await page.locator('#matchmakingPanel[data-status="searching"]').wait_for()
                assert await page.locator('#queueIdentity').inner_text() == '인증 계정 · 골드 1,250점'
                assert '±100점' in await page.locator('#queueRadius').inner_text()
                policy = await page.locator('#queuePolicyText').inner_text()
                assert '180초' in policy and '15초마다 50점' in policy and '±400점' in policy
                assert '검색 종료까지 최대' in await page.locator('#queueRemaining').inner_text()
                assert '다음 범위 확대까지' in await page.locator('#queueWiden').inner_text()
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                assert not await page.locator('#invite-button').is_enabled()
                await until(lambda: any(m.get('type') == 'queue_state' and m.get('elapsedMs', 0) >= 1000 for m in first['messages']), label='real queue elapsed time')
                await page.locator('#matchmakingPanel').screenshot(path=str(ARTIFACTS/'benchmark85-ranked-search-mobile130.png'))
                await until(lambda: any(m.get('type') == 'queue_state' and m.get('status') == 'searching' and m.get('elapsedMs', 0) >= 15000 and m.get('searchRadius') == 150 for m in first['messages']), timeout=18, label='real fifteen-second widening')
                await page.get_by_text('내 등급 기준 ±150점', exact=True).wait_for()
                remaining = int(re.search(r'([0-9]+)초', await page.locator('#queueRemaining').inner_text()).group(1))
                widening = int(re.search(r'([0-9]+)초', await page.locator('#queueWiden').inner_text()).group(1))
                assert 0 < remaining <= 165 and 1 <= widening <= 15
                await page.locator('#matchmakingPanel').screenshot(path=str(ARTIFACTS/'benchmark85-ranked-expanded-mobile130.png'))
                await page.locator('#queueCancelButton').click()
                assert await page.locator('#matchmakingPanel').get_attribute('data-status') == 'cancelled'
                assert await page.locator('#rankedButton').is_enabled()
                assert first['sent'][-2]['type'] == 'queue_cancel' or any(m['type'] == 'queue_cancel' for m in first['sent'])
                for client in clients:
                    await client['page'].locator('#rankedButton').click()
                    if client is not clients[-1]:
                        await client['page'].locator('#matchmakingPanel[data-status="searching"]').wait_for()
                await until(lambda: all(state(c).get('phase') == 'playing' for c in clients), label='eight-player assignment')
                initial = state(first)
                assert_arena(initial)
                room_id, match_id = initial['roomId'], initial['matchId']
                assert all(state(c)['roomId'] == room_id for c in clients)
                assert initial['matchmaking'] == {'source': 'supabase', 'requiredPlayers': 8}
                assert initial['ruleSet'] == 'classic' and initial['itemMode'] and not initial['series']
                assert len(initial['players']) == 8 and all(not p['isBot'] for p in initial['players'])
                by_name = {p['nickname']: 1250 + (i * 10) for i, p in enumerate(users.values())}
                sums = {team: sum(by_name[p['name']] for p in initial['players'] if p['team'] == team) for team in ['blue', 'pink']}
                assert sums['blue'] == sums['pink'] == 5140, sums
                assert not await page.locator('#invite-button').is_enabled() and await page.locator('#invite-url').input_value() == ''
                assert not await page.locator('#nextMatchButton').is_visible()
                old_player = joined(first)[-1]['playerId']; join_count = len(joined(first))
                await page.reload()
                await until(lambda: len(joined(first)) > join_count, label='ranked page reload recovery')
                await page.locator('#arena[data-connection="connected"]').wait_for()
                assert joined(first)[-1]['resumed'] is True and joined(first)[-1]['playerId'] == old_player
                assert_arena(state(first))
                assert state(first)['roomId'] == room_id
                assert await page.locator('#text-scale').input_value() == '130'
                assert not errors, errors
                await page.locator('.battle').screenshot(path=str(ARTIFACTS/'benchmark85-ranked-assigned-mobile130.png'))

                async def finish_round():
                    current = state(first)['matchId']
                    blue_ids = {p['id'] for p in state(first)['players'] if p['team'] == 'blue'}
                    for client in clients:
                        if joined(client)[-1]['playerId'] in blue_ids:
                            await client['page'].locator('#arena').focus()
                            await client['page'].keyboard.press('Space')
                    await until(lambda: all(state(c).get('phase') == 'finished' and state(c).get('matchId') == current for c in clients), timeout=15, label='normal orb/bubble round finish')
                await finish_round()
                await until(lambda: any(update['matchId'] == match_id for update in calls['eloUpdates']), label='first result applied through actual Elo module')
                first_elo = next(update for update in calls['eloUpdates'] if update['matchId'] == match_id)
                assert first_elo['teamMeans'] == {'blue': 1285, 'pink': 1285}
                assert {rating['delta'] for rating in first_elo['ratings']} == {-16, 16}
                for rating in first_elo['ratings']:
                    assert rating['delta'] == (16 if rating['outcome'] == 'win' else -16)
                    assert rating['after'] == rating['before'] + rating['delta']
                original_result = next(result for result in calls['results'] if result['p_match_id'] == match_id)
                ratings_before_retry = {uid: profile['rating'] for uid, profile in users.items()}
                module_calls_before_retry = len(calls['eloUpdates'])
                def replay_fixture_result():
                    request = urllib.request.Request(f'http://127.0.0.1:{provider.server_port}/rest/v1/rpc/record_match',
                        data=json.dumps(original_result).encode(), headers={'Authorization': 'Bearer fixture-service-key', 'Content-Type': 'application/json'})
                    with urllib.request.urlopen(request, timeout=5) as response:
                        assert response.status == 200
                        response.read()
                # Replay the immutable real result against the LOCAL fixture only.
                # This tests result idempotence without injecting a game outcome.
                await asyncio.to_thread(replay_fixture_result)
                assert ratings_before_retry == {uid: profile['rating'] for uid, profile in users.items()}
                assert len(calls['eloUpdates']) == module_calls_before_retry
                assert sum(result['p_match_id'] == match_id for result in calls['results']) == 1
                await page.locator('#replay-button').click()
                await until(lambda: old_player in state(first)['rematch']['readyPlayerIds'], label='ready vote')
                assert await page.locator('#replay-button').inner_text() == '준비 취소'
                await page.locator('#replay-button').click()
                await until(lambda: old_player not in state(first)['rematch']['readyPlayerIds'], label='ready cancellation')
                for client in clients:
                    await client['page'].locator('#replay-button').click()
                await until(lambda: all(state(c).get('phase') == 'playing' and state(c).get('matchId') != match_id for c in clients), label='same-room rematch')
                assert_arena(state(first))
                assert state(first)['roomId'] == room_id
                assert {p['id']: p['team'] for p in state(first)['players']} == {p['id']: p['team'] for p in initial['players']}
                await finish_round()
                await until(lambda: len(calls['results']) >= 2, label='fixture persisted results')
                await page.locator('#match-scoreboard').screenshot(path=str(ARTIFACTS/'benchmark85-ranked-results.png'))
                assert await page.locator('#download-result-button').is_enabled()
                assert await page.locator('#share-result-button').inner_text() == '내 결과 공유'
                failed_match = state(first)['matchId']
                first_uid = next(iter(users))
                controls['fail_profile'] = first_uid
                await page.locator('#nextMatchButton').click()
                await page.locator('#matchmakingPanel[data-status="cancelled"]').wait_for()
                assert state(first)['matchId'] == failed_match
                assert await page.locator('#nextMatchButton').is_enabled()
                assert '다시' in await page.locator('#queueStatus').inner_text()
                controls['fail_profile'] = None
                controls['hold_profile'] = first_uid
                await page.locator('#nextMatchButton').click()
                await until(profile_started.is_set, label='pending next-match profile')
                assert await page.locator('#matchmakingPanel').get_attribute('data-status') == 'authenticating'
                await page.locator('#queueCancelButton').click()
                await until(lambda: any(m.get('type') == 'queue_state' and m.get('status') == 'cancelled' and m.get('requestId') == next(m['requestId'] for m in reversed(first['sent']) if m['type'] == 'queue_cancel') for m in first['messages']), label='authoritative next cancellation')
                controls['hold_profile'] = None
                release_profile.set()
                await page.locator('#nextMatchButton:not([disabled])').wait_for()
                assert state(first)['matchId'] == failed_match
                await page.locator('#nextMatchButton').click()
                await page.locator('#matchmakingPanel[data-status="searching"]').wait_for()
                latest = next(m for m in reversed(first['messages']) if m.get('type') == 'queue_state' and m.get('status') == 'searching')
                assert latest['rating'] == users[first_uid]['rating']
                assert latest['rating'] != 1250, 'next match must read the saved Elo result, not the original fixture rating'
                assert len(calls['eloUpdates']) == len(calls['results']) == 2
                assert not await page.locator('#nextMatchButton').is_visible()
                assert not await page.locator('#match-scoreboard').is_visible()
                await until(lambda: len(state(clients[1])['players']) == 7, label='result room departure')
                assert not await clients[1]['page'].locator('#replay-button').is_enabled()
                await page.locator('#queueCancelButton').click()
                assert await page.locator('#rankedButton').is_enabled()
                await page.set_viewport_size({'width': 844, 'height': 390})
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                await page.screenshot(path=str(ARTIFACTS/'benchmark85-ranked-cancel-landscape.png'), full_page=True)
                for client in clients:
                    for message in client['sent']:
                        if message['type'] == 'queue_join':
                            assert set(message) <= {'type', 'requestId', 'accessToken', 'name', 'characterId', 'skinId', 'orbSkinId'}
                    for message in client['messages']:
                        if message['type'] == 'queue_state':
                            assert not ({'players', 'userId', 'accessToken', 'roomId'} & set(message))
                assert len(users) == 8 and len(set(calls['verified'])) == 8
                assert len(calls['verified']) >= 9, 'recovery must reverify the same account'
                assert not errors, errors
                evidence = {'provider': 'strict local HTTP fixture; not live Supabase', 'clock': 'unchanged production 100ms',
                            'participants': 8, 'initialRatings': list(range(1250, 1321, 10)), 'teamRatingSums': sums,
                            'ratingPolicy': {'implementation': 'Server/src/rating.js invoked via structured stdin once per accepted local-fixture result',
                                             'firstMatchTeamMeans': first_elo['teamMeans'],
                                             'firstMatchDeltas': [rating['delta'] for rating in first_elo['ratings']],
                                             'firstMatchBefore': [rating['before'] for rating in first_elo['ratings']],
                                             'firstMatchAfter': [rating['after'] for rating in first_elo['ratings']],
                                             'idempotentLocalHttpReplay': True, 'moduleInvocations': len(calls['eloUpdates']),
                                             'nextMatchInitialRating': 1250, 'nextMatchSavedRating': users[first_uid]['rating'],
                                             'nextMatchQueueRating': latest['rating']},
                            'queueSearchCancel': True, 'queuePolicyAndRealFifteenSecondWidening': True, 'reloadRecovery': True, 'readyCancel': True, 'sameRoomRematch': True,
                            'nextProfileFailureKeepsResult': True, 'nextAuthenticationCancelKeepsResult': True, 'nextMatchUsesLatestFixtureRating': True,
                            'missingParticipantBlocksRematch': True, 'mobileFontScale': 130, 'errors': errors,
                            'screenshots': ['benchmark85-ranked-search-mobile130.png', 'benchmark85-ranked-expanded-mobile130.png', 'benchmark85-ranked-assigned-mobile130.png', 'benchmark85-ranked-results.png', 'benchmark85-ranked-cancel-landscape.png']}
                await browser.close(); browser = None
                evidence['cancelAssignmentRace'] = await cancellation_assignment_race(pw)
                (ARTIFACTS/'benchmark85-matchmaking-browser.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2)+'\n')
                print(json.dumps(evidence, ensure_ascii=False), flush=True)
        except Exception:
            log.seek(0)
            print(log.read().decode()[-5000:], flush=True)
            raise
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill(); server.wait()
            provider.shutdown(); provider.server_close(); thread.join(timeout=2)


if __name__ == '__main__':
    asyncio.run(main())
