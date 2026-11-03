"""Actual browser recovery with denied sessionStorage and a local auth provider fixture."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
from threading import Thread
import urllib.request
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]


async def until(predicate, timeout=10):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError('Timed out waiting for authenticated recovery')
        await asyncio.sleep(.025)


async def main():
    calls = {'signup': 0, 'verification': [], 'profiles': []}
    user_id = '11111111-1111-4111-8111-111111111111'

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, payload, status=200):
            body = json.dumps(payload).encode() if status != 204 else b''
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Headers', 'apikey,content-type,authorization')
            self.send_header('Access-Control-Allow-Methods', 'POST,GET,OPTIONS')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.reply(None, 204)

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or '{}')
            if self.path == '/auth/v1/signup':
                calls['signup'] += 1
                self.reply({'access_token': f'fixture-access-{calls["signup"]}', 'refresh_token': 'fixture-refresh',
                            'expires_in': 3600, 'user': {'id': user_id}})
            elif self.path.startswith('/rest/v1/profiles'):
                calls['profiles'].append(payload)
                self.reply([])
            else:
                self.reply({'error': 'unexpected fixture request'}, 400)

        def do_GET(self):
            if self.path == '/auth/v1/user':
                authorization = self.headers.get('Authorization')
                calls['verification'].append(authorization)
                if authorization == 'Bearer fixture-access-1':
                    self.reply({'id': user_id, 'user_metadata': {}})
                else:
                    # A second anonymous signup cannot resume the original participant.
                    self.reply({'id': '22222222-2222-4222-8222-222222222222', 'user_metadata': {}})
            elif self.path.startswith('/rest/v1/profiles'):
                self.reply([])
            else:
                self.reply({'error': 'unexpected fixture request'}, 400)

    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    provider_thread = Thread(target=provider.serve_forever, daemon=True)
    provider_thread.start()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ, HOST='127.0.0.1', PORT=str(port), ALLOW_DEV_GUESTS='false',
               SUPABASE_URL=f'http://127.0.0.1:{provider.server_port}', SUPABASE_ANON_KEY='fixture-public-key',
               SUPABASE_SERVICE_ROLE_KEY='fixture-server-only-key')
    try:
        with tempfile.TemporaryDirectory(prefix='poppop-auth-results-') as storage, tempfile.TemporaryFile() as log:
            env['RESULT_OUTBOX_DIR'] = storage
            server = subprocess.Popen(['node', 'src/index.js'], cwd=ROOT / 'Server', env=env, stdout=log, stderr=log)
            try:
                base = f'http://127.0.0.1:{port}'
                for _ in range(80):
                    try:
                        with urllib.request.urlopen(base + '/health', timeout=1) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        await asyncio.sleep(.05)
                else:
                    raise AssertionError('Game server failed to start')
                async with async_playwright() as pw:
                    browser = await pw.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
                    try:
                        page = await browser.new_page(viewport={'width': 1280, 'height': 1000})
                        messages, errors = [], []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.on('websocket', lambda ws: ws.on('framereceived', lambda frame: messages.append(json.loads(frame))))
                        await page.add_init_script("""
                          Object.defineProperty(window, 'sessionStorage', { configurable: true, get() {
                            throw new DOMException('Storage denied for this test', 'SecurityError');
                          }});
                          const NativeSocket = WebSocket;
                          window.__testSockets = [];
                          window.WebSocket = class extends NativeSocket {
                            constructor(...args) { super(...args); window.__testSockets.push(this); }
                          };
                        """)
                        await page.goto(base)
                        await page.locator('#room-id').fill('authenticated-recovery')
                        await page.locator('#join-button').click()
                        joins = lambda: [message for message in messages if message.get('type') == 'joined']
                        await until(lambda: len(joins()) == 1)
                        await page.locator('#arena[data-connection="connected"]').wait_for()
                        original = joins()[0]
                        await page.evaluate('window.__testSockets.at(-1).close()')
                        await page.locator('#arena[data-connection="reconnecting"]').wait_for()
                        await until(lambda: len(joins()) == 2)
                        await page.locator('#arena[data-connection="connected"]').wait_for()
                        assert joins()[-1]['resumed'] is True and joins()[-1]['playerId'] == original['playerId']
                        assert joins()[-1]['roomId'] == original['roomId']
                        assert calls['signup'] == 1, 'denied storage must not create another anonymous user'
                        assert calls['verification'] == ['Bearer fixture-access-1'] * 2
                        assert len(calls['profiles']) == 1, 'resume must not rewrite profile'
                        assert calls['profiles'][0]['id'] == user_id
                        assert not errors, errors
                        await page.screenshot(path='/tmp/poppop-reconnect-auth.png', full_page=True)
                        await page.locator('#leave-button').click()
                        await page.locator('#arena[data-connection="disconnected"]').wait_for()
                        print('PASS: actual authenticated browser recovery with denied storage preserves user/player, one signup, two JWT verifications, one profile write', flush=True)
                    finally:
                        await browser.close()
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
    finally:
        provider.shutdown()
        provider.server_close()
        provider_thread.join(timeout=2)


if __name__ == '__main__':
    asyncio.run(main())
