"""Real Chromium member flow against the real Node server and a local Supabase fixture.

Run: python scripts/member-account-smoke.py [--artifacts /tmp/poppop-member-account]
Requires Python Playwright, Chromium and installed Server dependencies.
This verifies HTTP protocol integration, not a live Supabase project or email delivery.
Only the recovery regression injects a deliberate first-/api/config HTTP 503;
all subsequent configuration, auth, storage and game requests use real servers.
No browser clock overrides, fake game state, or session storage edits are used.
"""
import argparse
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
from threading import Event, Lock, Thread
import time
from urllib.parse import parse_qs, urlparse
import urllib.request

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
USER_ID = '11111111-1111-4111-8111-111111111111'
EMAIL = 'member@example.test'
PASSWORD = 'FixturePassword123!'
PUBLIC_KEY = 'fixture-public-anon-key'
SERVICE_KEY = 'fixture-server-only-service-key'
PRIVATE_DETAIL = 'fixture-private-provider-detail'


class SupabaseFixture:
    def __init__(self):
        self.lock = Lock()
        self.user = None
        self.confirmed = False
        self.profile = None
        self.access = {}
        self.refresh = {}
        self.token_count = 0
        self.calls = []
        self.violations = []
        self.history = []
        self.payments = []
        self.history_available = True
        self.payments_available = True
        self.higher_ranked = 0
        self.logout_pending = Event()
        self.logout_release = Event()
        self.logout_release.set()

    def session(self, lifetime=3600):
        self.token_count += 1
        access = f'fixture-access-{self.token_count}'
        refresh = f'fixture-refresh-{self.token_count}'
        self.access[access] = USER_ID
        self.refresh[refresh] = USER_ID
        return {'access_token': access, 'refresh_token': refresh, 'token_type': 'bearer',
                'expires_in': lifetime, 'expires_at': int(time.time()) + lifetime, 'user': dict(self.user)}

    def seed_history(self):
        with self.lock:
            self.profile.update(rating=1280, wins=7, losses=2, draws=1, score=720)
            self.higher_ranked = 4
            self.history = [{'user_id': USER_ID, 'match_id': '22222222-2222-4222-8222-222222222222',
                             'team': 'blue', 'outcome': 'win', 'score': 80,
                             'matches': {'id': '22222222-2222-4222-8222-222222222222', 'mode': 'team',
                                         'played_at': '2026-11-07T10:00:00Z'}}]
            self.payments = [
                {'id': '33333333-3333-4333-8333-333333333333', 'user_id': USER_ID,
                 'description': 'Fixture Star Pack', 'amount_minor': 450, 'currency': 'USD', 'status': 'paid',
                 'created_at': '2026-11-07T09:00:00Z'},
                {'id': '44444444-4444-4444-8444-444444444444', 'user_id': USER_ID,
                 'description': 'Fixture Bubble Pack', 'amount_minor': 1000, 'currency': 'KRW', 'status': 'refunded',
                 'created_at': '2026-11-06T09:00:00Z'}]

    def count(self, action):
        with self.lock:
            return sum(call.get('action') == action for call in self.calls)

    def handler(self):
        fixture = self

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, data=None, status=200, extra=None):
                body = json.dumps(data).encode() if status != 204 else b''
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Headers', 'apikey,content-type,authorization')
                self.send_header('Access-Control-Allow-Methods', 'GET,HEAD,POST,PATCH,OPTIONS')
                self.send_header('Content-Length', str(len(body)))
                for name, value in (extra or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(body)

            def do_OPTIONS(self):
                self.reply(status=204)

            def dispatch(self):
                if self.command == 'POST' and urlparse(self.path).path == '/auth/v1/logout':
                    # Block only this fixture response, never other provider requests.
                    fixture.logout_pending.set()
                    if not fixture.logout_release.wait(timeout=15):
                        with fixture.lock:
                            fixture.violations.append('Delayed logout response was never released')
                        self.reply({'error': PRIVATE_DETAIL}, 504)
                        return
                with fixture.lock:
                    try:
                        self.route()
                    except Exception as error:
                        fixture.violations.append(str(error))
                        self.reply({'error': PRIVATE_DETAIL}, 500)

            do_GET = dispatch
            do_HEAD = dispatch
            do_POST = dispatch
            do_PATCH = dispatch

            def route(self):
                parsed = urlparse(self.path)
                query = parse_qs(parsed.query)
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or '{}')
                method, endpoint = self.command, parsed.path
                authorization = self.headers.get('Authorization', '')
                token = authorization.removeprefix('Bearer ')
                call = {'method': method, 'path': endpoint}
                fixture.calls.append(call)
                if endpoint.startswith('/auth/v1/'):
                    assert self.headers.get('apikey') in (PUBLIC_KEY, SERVICE_KEY), 'Auth API key missing'
                    if endpoint == '/auth/v1/signup' and method == 'POST':
                        call['action'] = 'signup'
                        assert body == {'email': EMAIL, 'password': PASSWORD, 'data': {'nickname': 'SignupName'}}, 'Signup payload mismatch'
                        fixture.user = {'id': USER_ID, 'email': EMAIL, 'is_anonymous': False,
                                        'user_metadata': body['data'], 'identities': [{'provider': 'email'}]}
                        # Raw GoTrue HTTP response: confirmations return User,
                        # unlike the supabase-js wrapper's {user, session} shape.
                        self.reply(fixture.user)
                    elif endpoint == '/auth/v1/token' and query.get('grant_type') == ['password']:
                        call['action'] = 'password'
                        if body.get('email') != EMAIL or body.get('password') != PASSWORD or not fixture.confirmed:
                            self.reply({'error': 'invalid_grant', 'message': PRIVATE_DETAIL}, 400)
                        else:
                            # Natural time passage crosses the client's proactive refresh window.
                            self.reply(fixture.session(lifetime=63))
                    elif endpoint == '/auth/v1/token' and query.get('grant_type') == ['refresh_token']:
                        call['action'] = 'refresh'
                        assert fixture.refresh.pop(body.get('refresh_token'), None) == USER_ID, 'Refresh reused or changed identity'
                        self.reply(fixture.session())
                    elif endpoint == '/auth/v1/user' and method == 'GET':
                        call['action'] = 'verify'
                        call['user_id'] = fixture.access.get(token)
                        if fixture.access.get(token) != USER_ID:
                            self.reply({'error': 'invalid_token'}, 401)
                        else:
                            self.reply(fixture.user)
                    elif endpoint == '/auth/v1/logout' and method == 'POST':
                        call['action'] = 'logout'
                        assert query.get('scope') == ['local'], 'Logout must target this local session'
                        fixture.access.pop(token, None)
                        self.reply(status=204)
                    else:
                        raise AssertionError(f'Unexpected auth endpoint: {method} {self.path}')
                    return

                assert endpoint.startswith('/rest/v1/'), f'Unexpected endpoint: {endpoint}'
                if endpoint == '/rest/v1/profiles' and method == 'GET' and 'id' not in query:
                    # Public leaderboard uses only the anon key and public profile fields.
                    assert self.headers.get('apikey') == PUBLIC_KEY, 'Leaderboard did not use public key'
                    self.reply([fixture.profile] if fixture.profile else [])
                    return
                assert self.headers.get('apikey') == SERVICE_KEY and token == SERVICE_KEY, 'Server storage credentials missing'
                if endpoint == '/rest/v1/profiles':
                    if method == 'POST':
                        call['action'] = 'profile_init'
                        assert self.headers.get('Prefer') == 'resolution=ignore-duplicates', 'Join may overwrite edited nickname'
                        assert body == {'id': USER_ID, 'nickname': 'SignupName'}, 'Profile initialization changed identity or awarded stats'
                        if fixture.profile is None:
                            fixture.profile = {'id': USER_ID, 'nickname': body['nickname'], 'rating': 1000,
                                               'wins': 0, 'losses': 0, 'draws': 0, 'score': 0,
                                               'created_at': '2026-11-07T00:00:00Z', 'updated_at': '2026-11-07T00:00:00Z'}
                        self.reply(status=201)
                    elif method == 'HEAD':
                        call['action'] = 'rank'
                        assert 'or' in query and self.headers.get('Prefer') == 'count=exact', 'Rank lacks exact count'
                        self.reply([], extra={'Content-Range': f'0-0/{fixture.higher_ranked}'})
                    elif method == 'GET':
                        call['action'] = 'profile_read'
                        assert query.get('id') == [f'eq.{USER_ID}'], 'Profile not isolated to verified member'
                        self.reply([fixture.profile] if fixture.profile else [])
                    elif method == 'PATCH':
                        call['action'] = 'profile_edit'
                        assert query.get('id') == [f'eq.{USER_ID}'], 'Profile PATCH used wrong member'
                        assert body == {'nickname': '새닉네임'}, 'Profile PATCH changed unexpected fields'
                        fixture.profile.update(body)
                        fixture.profile['updated_at'] = '2026-11-07T12:00:00Z'
                        self.reply([fixture.profile])
                    else:
                        raise AssertionError(f'Unexpected profile method: {method}')
                elif endpoint == '/rest/v1/match_participants' and method == 'GET':
                    call['action'] = 'history'
                    assert query.get('user_id') == [f'eq.{USER_ID}'] and query.get('limit') == ['20'], 'History isolation or bound missing'
                    self.reply(fixture.history if fixture.history_available else {'error': PRIVATE_DETAIL}, 200 if fixture.history_available else 503)
                elif endpoint == '/rest/v1/payment_records' and method == 'GET':
                    call['action'] = 'payments'
                    assert query.get('user_id') == [f'eq.{USER_ID}'] and query.get('limit') == ['20'], 'Payment isolation or bound missing'
                    assert 'provider' not in query.get('select', [''])[0], 'Provider payment references requested'
                    self.reply(fixture.payments if fixture.payments_available else {'error': PRIVATE_DETAIL}, 200 if fixture.payments_available else 503)
                else:
                    raise AssertionError(f'Unexpected storage endpoint: {method} {self.path}')

        return Provider


async def wait_until(predicate, label, timeout=12):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError(f'Timed out: {label}')
        await asyncio.sleep(.025)


async def main(artifacts, race='all'):
    artifacts.mkdir(parents=True, exist_ok=True)
    fixture = SupabaseFixture()
    provider = ThreadingHTTPServer(('127.0.0.1', 0), fixture.handler())
    provider_thread = Thread(target=provider.serve_forever, daemon=True)
    provider_thread.start()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    provider_url = f'http://127.0.0.1:{provider.server_port}'
    member_key = f'popPopMember:{provider_url}'
    errors, unexpected_console, browser_requests, messages = [], [], [], []
    checkpoints = []
    injected_faults = []
    config_fault_urls = set()
    recovery_config_statuses = []
    report = {'kind': 'local_supabase_protocol_fixture', 'liveSupabase': False, 'passed': False}
    page = None

    def checkpoint(message):
        checkpoints.append(message)
        print('PASS: ' + message, flush=True)

    def watch(page):
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: browser_requests.append({'url': request.url, 'headers': request.headers}))
        page.on('response', lambda response: recovery_config_statuses.append(response.status) if response.url in config_fault_urls else None)
        def console(message):
            if message.type != 'error':
                return
            url = message.location.get('url', '')
            expected = (url.startswith(provider_url + '/auth/v1/token') and '400' in message.text
                        or url in config_fault_urls and '503' in message.text)
            if not expected:
                unexpected_console.append({'text': message.text, 'url': message.location.get('url', '')})
        page.on('console', console)
        def frame(value):
            if isinstance(value, str):
                messages.append(json.loads(value))
        page.on('websocket', lambda ws: ws.on('framereceived', frame))

    async def open_profile(target):
        await target.locator('.shell-nav [data-account="profile"]').click()
        await expect(target.locator('#screen-profile')).to_be_visible()
        await expect(target.locator('#member-records')).to_be_visible()

    try:
        with tempfile.TemporaryDirectory(prefix='poppop-member-outbox-') as outbox, (artifacts / 'server.log').open('w+') as log:
            env = dict(os.environ, HOST='127.0.0.1', PORT=str(port), ALLOW_DEV_GUESTS='false',
                       SUPABASE_URL=provider_url, SUPABASE_ANON_KEY=PUBLIC_KEY,
                       SUPABASE_SERVICE_ROLE_KEY=SERVICE_KEY, RESULT_OUTBOX_DIR=outbox)
            server = subprocess.Popen(['node', 'src/index.js'], cwd=ROOT / 'Server', env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        with urllib.request.urlopen(base + '/health', timeout=1) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        await asyncio.sleep(.05)
                else:
                    raise AssertionError('Game server failed to start; see server.log')
                with urllib.request.urlopen(base + '/api/config', timeout=2) as response:
                    config = json.load(response)
                assert config == {'allowDevGuests': False, 'supabaseUrl': provider_url, 'supabaseAnonKey': PUBLIC_KEY}
                assert SERVICE_KEY not in json.dumps(config)
                async with async_playwright() as pw:
                    browser = await pw.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
                    context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
                    await context.tracing.start(screenshots=True, snapshots=True, sources=True)
                    try:
                        page = await context.new_page()
                        watch(page)
                        await page.goto(base)
                        await page.locator('#screen-title [data-account="login"]').click()
                        await expect(page.locator('#screen-login')).to_be_visible()
                        await expect(page.locator('#member-submit')).to_be_enabled()
                        await page.locator('#member-signup-tab').click()
                        await page.locator('#member-name').fill('SignupName')
                        await page.locator('#member-email').fill(EMAIL)
                        await page.locator('#member-password').fill(PASSWORD)
                        await page.locator('#member-submit').click()
                        await expect(page.locator('#member-message')).to_contain_text('가입 확인 메일')
                        assert await page.evaluate('(key) => localStorage.getItem(key)', member_key) is None
                        assert fixture.count('signup') == 1
                        await page.screenshot(path=str(artifacts / '01-email-confirmation.png'), full_page=True)
                        checkpoint('Signup uses email/password/nickname and shows confirmation without creating a browser session')

                        # Email delivery is out of scope; the local provider marks this fixture account verified.
                        with fixture.lock:
                            fixture.confirmed = True
                        await page.locator('#member-password').fill('wrong-password')
                        await page.locator('#member-submit').click()
                        await expect(page.locator('#member-message.error')).to_contain_text('이메일과 비밀번호')
                        assert PRIVATE_DETAIL not in await page.locator('body').inner_text()
                        assert await page.evaluate('(key) => localStorage.getItem(key)', member_key) is None
                        await page.locator('#member-password').fill(PASSWORD)
                        await page.locator('#member-submit').click()
                        await expect(page.locator('#screen-profile')).to_be_visible()
                        await expect(page.locator('#member-records')).to_be_visible()
                        await expect(page.locator('#profile-nickname')).to_have_value('SignupName')
                        await expect(page.locator('#member-identity')).to_have_text(EMAIL)
                        await expect(page.locator('#member-stats')).to_contain_text('0승 0패 0무')
                        await expect(page.locator('#member-history-note')).to_contain_text('아직 저장된 경기 기록이 없습니다')
                        await expect(page.locator('#member-payment-note')).to_contain_text('결제 내역이 없습니다')
                        assert fixture.count('profile_init') == 1
                        await page.screenshot(path=str(artifacts / '02-first-account-empty.png'), full_page=True)
                        checkpoint('Wrong credentials fail safely; verified login initializes an empty member profile through the actual server')

                        saved = json.loads(await page.evaluate('(key) => localStorage.getItem(key)', member_key))
                        assert saved['user']['id'] == USER_ID and PASSWORD not in json.dumps(saved)
                        fixture.seed_history()
                        await wait_until(lambda: saved['expires_at'] <= time.time() + 59, 'natural token refresh window', timeout=8)
                        replacement = await context.new_page()
                        watch(replacement)
                        await replacement.goto(base)
                        await wait_until(lambda: fixture.count('refresh') == 1, 'persisted refresh-token exchange')
                        page = replacement
                        await open_profile(page)
                        renewed = json.loads(await page.evaluate('(key) => localStorage.getItem(key)', member_key))
                        assert renewed['access_token'] != saved['access_token'] and renewed['user']['id'] == USER_ID
                        assert fixture.count('signup') == 1 and fixture.count('password') == 2
                        for old in list(context.pages):
                            if old != page:
                                await old.close()
                        await expect(page.locator('#member-stats')).to_contain_text('Gold · 1280')
                        await expect(page.locator('#member-stats')).to_contain_text('5위')
                        await expect(page.locator('#member-stats')).to_contain_text('7승 2패 1무')
                        await expect(page.locator('#member-stats')).to_contain_text('720')
                        await expect(page.locator('#member-history tr')).to_have_count(1)
                        await expect(page.locator('#member-history')).to_contain_text('승리')
                        await expect(page.locator('#member-history')).to_contain_text('80')
                        await expect(page.locator('#member-payments tr')).to_have_count(2)
                        await expect(page.locator('#member-payments')).to_contain_text('Fixture Star Pack')
                        await expect(page.locator('#member-payments')).to_contain_text('4.50')
                        await expect(page.locator('#member-payments')).to_contain_text('1,000')
                        await page.screenshot(path=str(artifacts / '03-account-history.png'), full_page=True)
                        await page.locator('#member-payments').scroll_into_view_if_needed()
                        await page.screenshot(path=str(artifacts / '03b-payment-history.png'), full_page=True)
                        checkpoint('A new page restores the same member, refreshes a real token, and shows stored rank/stats/matches/payment metadata')

                        with fixture.lock:
                            fixture.history_available = fixture.payments_available = False
                        await page.locator('#member-retry').click()
                        await expect(page.locator('#member-history-note')).to_contain_text('불러오지 못했습니다')
                        await expect(page.locator('#member-payment-note')).to_contain_text('불러올 수 없습니다')
                        await expect(page.locator('#member-history tr')).to_have_count(0)
                        await expect(page.locator('#member-payments tr')).to_have_count(0)
                        assert PRIVATE_DETAIL not in await page.locator('body').inner_text()
                        await page.screenshot(path=str(artifacts / '04-history-unavailable.png'), full_page=True)
                        with fixture.lock:
                            fixture.history_available = fixture.payments_available = True
                        await page.locator('#member-retry').click()
                        await expect(page.locator('#member-history tr')).to_have_count(1)
                        checkpoint('History outages show unavailable messages rather than empty-history messages and recover on retry')

                        await page.locator('#profile-nickname').fill('새닉네임')
                        await page.locator('#profile-form button[type="submit"]').click()
                        await expect(page.locator('#member-profile-message')).to_have_text('닉네임을 저장했습니다.')
                        assert fixture.count('profile_edit') == 1 and fixture.profile['nickname'] == '새닉네임'
                        await page.reload()
                        await expect(page.locator('#shell-member-name')).to_have_text('새닉네임')
                        await open_profile(page)
                        await expect(page.locator('#profile-nickname')).to_have_value('새닉네임')
                        await page.locator('.shell-header [data-screen="maps"]').click()
                        await page.locator('#room-id').fill('member-browser-proof')
                        await page.locator('#mode').select_option('team')
                        await page.locator('#human-slots').select_option('8')
                        verifications_before_join = fixture.count('verify')
                        await page.locator('#join-button').click()
                        await expect(page.locator('#screen-waiting')).to_be_visible()
                        await wait_until(lambda: any(message.get('type') == 'joined' for message in messages), 'verified online join')
                        joined = next(message for message in messages if message.get('type') == 'joined')
                        assert joined['roomId'] == 'member-browser-proof'
                        assert fixture.count('verify') > verifications_before_join, 'Online join did not verify its bearer token'
                        await wait_until(lambda: any(message.get('type') == 'state' and any(player.get('id') == joined['playerId'] for player in message.get('players', [])) for message in messages), 'joined player state')
                        player_state = next(player for message in reversed(messages) if message.get('type') == 'state' for player in message.get('players', []) if player.get('id') == joined['playerId'])
                        assert player_state['name'] == '새닉네임', f'Online player nickname reverted: {player_state["name"]}'
                        assert fixture.profile['nickname'] == '새닉네임', 'Online join restored old signup nickname'
                        assert fixture.profile['rating'] == 1280 and fixture.profile['score'] == 720
                        assert fixture.count('profile_init') == 2, 'Online join must pass the real profile boundary'
                        await page.screenshot(path=str(artifacts / '05-authenticated-online-waiting.png'), full_page=True)
                        if race in ('all', 'recovery'):
                            frame_offset = len(messages)
                            async def fail_initial_config(route):
                                config_fault_urls.add(route.request.url)
                                injected_faults.append('One intentional HTTP 503 on the first /api/config after online reload')
                                await route.fulfill(status=503, content_type='application/json', body='{"error":"fixture_config_outage"}')
                            await page.route('**/api/config', fail_initial_config, times=1)
                            await page.reload()
                            await wait_until(lambda: any(message.get('type') == 'joined' and message.get('resumed') is True for message in messages[frame_offset:]),
                                             'same authenticated member resumes after initial configuration failure', timeout=10)
                            resumed = next(message for message in messages[frame_offset:] if message.get('type') == 'joined' and message.get('resumed') is True)
                            assert resumed['playerId'] == joined['playerId'] and resumed['roomId'] == joined['roomId'], 'Recovery changed the authoritative participant'
                            assert len(injected_faults) == 1, 'Configuration fault must occur exactly once'
                            assert recovery_config_statuses[:2] == [503, 200], 'Recovery must obtain configuration from the real server after the one injected failure'
                            assert fixture.count('profile_init') == 2, 'Resume must not create or overwrite a profile'
                            await expect(page.locator('#screen-waiting')).to_be_visible()
                            await expect(page.locator('#arena')).to_have_attribute('data-connection', 'connected')
                            await page.screenshot(path=str(artifacts / '05b-recovered-config-fault.png'), full_page=True)
                            checkpoint('A real online participant resumes unchanged after one injected configuration failure and a successful server retry')
                        await page.locator('#screen-waiting [data-leave]').click()
                        await expect(page.locator('#screen-lobby')).to_be_visible()
                        await open_profile(page)
                        await expect(page.locator('#profile-nickname')).to_have_value('새닉네임')
                        checkpoint('Nickname PATCH survives page reload and verified WebSocket join without changing saved ratings or score')

                        if race in ('all', 'logout'):
                            fixture.logout_pending.clear()
                            fixture.logout_release.clear()
                            injected_faults.append('Provider logout response delayed until a new real AI match is playing')
                            async with page.expect_response(lambda response: response.url.startswith(provider_url + '/auth/v1/logout')) as logout_response:
                                await page.locator('#member-signout').click()
                                await wait_until(fixture.logout_pending.is_set, 'provider receives pending logout')
                                assert await page.evaluate('(key) => localStorage.getItem(key)', member_key) is None
                                await page.locator('.shell-nav [data-screen="lobby"]').click()
                                await page.locator('#quick-practice').click()
                                await expect(page.locator('#screen-battle')).to_be_visible()
                                await expect(page.locator('#arena')).to_have_attribute('data-phase', 'playing')
                                fixture.logout_release.set()
                            assert (await logout_response.value).status == 204
                            await expect(page.locator('#member-signout')).to_be_enabled()
                            await expect(page.locator('#game-shell')).to_have_attribute('data-screen', 'battle', timeout=1500)
                            await expect(page.locator('#screen-battle')).to_be_visible()
                            await expect(page.locator('#arena')).to_have_attribute('data-phase', 'playing')
                            await page.screenshot(path=str(artifacts / '07-late-logout-keeps-battle.png'), full_page=True)
                            checkpoint('A delayed logout completion preserves the newly started real AI match and its battle screen')
                            await page.locator('#leave-button').click()
                        else:
                            await page.locator('#member-signout').click()
                        await expect(page.locator('#screen-lobby')).to_be_visible()
                        await expect(page.locator('#shell-member-name')).to_have_text('게스트')
                        assert await page.evaluate('(key) => localStorage.getItem(key)', member_key) is None
                        assert fixture.count('logout') == 1
                        joined_count = sum(message.get('type') == 'joined' for message in messages)
                        await page.locator('#quick-friends').click()
                        await expect(page.locator('#screen-maps')).to_be_visible()
                        await page.locator('#join-button').click()
                        await expect(page.locator('#screen-login')).to_be_visible()
                        await expect(page.locator('#status')).to_contain_text('로그인하면 사람 대전')
                        assert sum(message.get('type') == 'joined' for message in messages) == joined_count
                        await page.screenshot(path=str(artifacts / '06-signed-out-online-gate.png'), full_page=True)
                        await page.reload()
                        await page.locator('.shell-nav [data-account="profile"]').click()
                        await expect(page.locator('#screen-login')).to_be_visible()
                        assert await page.evaluate('(key) => localStorage.getItem(key)', member_key) is None
                        assert fixture.count('signup') == 1 and fixture.count('password') == 2 and fixture.count('refresh') == 1
                        checkpoint('Logout clears persistent credentials and online play returns to the member gate after reload')

                        assert not errors, errors
                        assert not unexpected_console, unexpected_console
                        assert not fixture.violations, fixture.violations
                        assert SERVICE_KEY not in json.dumps(browser_requests), 'Service role key reached a browser request'
                        assert all(call.get('user_id') == USER_ID for call in fixture.calls if call.get('action') == 'verify')
                        checkpoint('No uncaught browser errors, unexpected console errors, identity drift, or browser service-role exposure')
                        report.update(passed=True, checkpoints=checkpoints, browserErrors=errors,
                                      injectedFaults=injected_faults,
                                      recoveryConfigStatuses=recovery_config_statuses,
                                      unexpectedConsoleErrors=unexpected_console, fixtureViolations=fixture.violations,
                                      counts={name: fixture.count(name) for name in ['signup', 'password', 'refresh', 'verify', 'profile_init', 'profile_edit', 'history', 'payments', 'logout']})
                    except Exception as error:
                        report.update(error=str(error), checkpoints=checkpoints, browserErrors=errors,
                                      injectedFaults=injected_faults,
                                      recoveryConfigStatuses=recovery_config_statuses,
                                      unexpectedConsoleErrors=unexpected_console, fixtureViolations=fixture.violations)
                        if page and not page.is_closed():
                            await page.screenshot(path=str(artifacts / 'failure.png'), full_page=True)
                        raise
                    finally:
                        await context.tracing.stop(path=str(artifacts / 'browser-trace.zip'))
                        await browser.close()
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
    finally:
        fixture.logout_release.set()
        provider.shutdown()
        provider.server_close()
        provider_thread.join(timeout=2)
        (artifacts / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        if report['passed']:
            (artifacts / 'failure.png').unlink(missing_ok=True)
    print(f'Artifacts: {artifacts}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', type=Path, default=Path('/tmp/poppop-member-account'))
    parser.add_argument('--race', choices=['all', 'recovery', 'logout'], default='all', help='Choose the recovery race, logout race, or both (default)')
    args = parser.parse_args()
    asyncio.run(main(args.artifacts, args.race))
