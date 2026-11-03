"""Authenticated Chromium result retry/success/failure with a local provider."""
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


async def until(predicate, timeout=12):
    end = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > end:
            raise AssertionError('Timed out waiting for result storage')
        await asyncio.sleep(.025)


async def main():
    calls = {'signups': 0, 'leaderboards': 0, 'results': [], 'applied': set(), 'reject': False}

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, body, status=200):
            data = json.dumps(body).encode() if status != 204 else b''
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Headers', 'apikey,content-type,authorization')
            self.send_header('Access-Control-Allow-Methods', 'POST,GET,OPTIONS')
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.reply(None, 204)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or '{}')
            if self.path == '/auth/v1/signup':
                calls['signups'] += 1
                n = calls['signups']
                self.reply({'access_token': f'fixture-access-{n}', 'refresh_token': f'fixture-refresh-{n}',
                            'expires_in': 3600, 'user': {'id': f'00000000-0000-4000-8000-{n:012d}'}})
            elif self.path.startswith('/rest/v1/profiles'):
                self.reply([])
            elif self.path == '/rest/v1/rpc/record_match':
                calls['results'].append(body)
                if calls['reject']:
                    self.reply({'message': 'private-provider-detail'}, 400)
                elif len(calls['results']) == 1:
                    self.reply({'message': 'private-provider-detail'}, 503)
                else:
                    calls['applied'].add(body['p_match_id'])
                    if len(calls['results']) == 2:
                        # Simulate committed RPC whose HTTP acknowledgement was lost.
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                    else:
                        self.reply(None)
            else:
                self.reply({'error': 'unexpected request'}, 400)

        def do_GET(self):
            if self.path == '/auth/v1/user':
                n = int(self.headers['Authorization'].rsplit('-', 1)[-1])
                self.reply({'id': f'00000000-0000-4000-8000-{n:012d}', 'user_metadata': {}})
            elif self.path.startswith('/rest/v1/profiles'):
                calls['leaderboards'] += 1
                self.reply([{'nickname': 'StoredPlayer', 'rating': 1025, 'wins': len(calls['applied']), 'score': 200, 'losses': 0, 'draws': 0}])
            else:
                self.reply({'error': 'unexpected request'}, 400)

    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    thread = Thread(target=provider.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix='poppop-result-browser-') as directory, tempfile.TemporaryFile() as log:
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            env = dict(os.environ, HOST='127.0.0.1', PORT=str(port), ALLOW_DEV_GUESTS='false',
                       SUPABASE_URL=f'http://127.0.0.1:{provider.server_port}', SUPABASE_ANON_KEY='fixture-public',
                       SUPABASE_SERVICE_ROLE_KEY='fixture-server-secret', RESULT_OUTBOX_DIR=directory)
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
                    clients, errors = [], []
                    try:
                        for n in range(2):
                            context = await browser.new_context(viewport={'width': 1280, 'height': 1000})
                            await context.add_init_script('''
                                const NativeSocket = WebSocket; window.__testSockets = [];
                                window.WebSocket = class extends NativeSocket {
                                    constructor(...args) { super(...args); window.__testSockets.push(this); }
                                };
                            ''')
                            page = await context.new_page()
                            client = {'page': page, 'messages': []}
                            page.on('pageerror', lambda e: errors.append(str(e)))
                            page.on('websocket', lambda ws, c=client: ws.on('framereceived', lambda raw: c['messages'].append(json.loads(raw))))
                            clients.append(client)
                            await page.goto(base)
                            await page.locator('#mode').select_option('duel')
                            await page.locator('#room-id').fill('result-browser')
                            await page.locator('#nickname').fill(f'Store{n}')
                            await page.locator('#join-button').click()

                        def state(c=clients[0]):
                            return next((m for m in reversed(c['messages']) if m.get('type') == 'state'), {})

                        await until(lambda: state().get('phase') == 'playing' and calls['leaderboards'] == 2)
                        page = clients[0]['page']
                        baseline_reads = calls['leaderboards']
                        await page.locator('#arena').focus()
                        await page.keyboard.press('Space')
                        await page.locator('#result-saving[data-status="retrying"]').wait_for(timeout=12000)
                        assert calls['leaderboards'] == baseline_reads, 'retrying cannot refresh as if saved'
                        first_match = state()['matchId']
                        records = list(Path(directory).glob('*.json'))
                        assert records, 'pending result must be on disk before another HTTP attempt'
                        secrets = ['fixture-server-secret', 'fixture-access-', 'private-provider-detail']
                        secrets += [m['resumeToken'] for c in clients for m in c['messages'] if m.get('type') == 'joined']
                        stored = ''.join(p.read_text() for p in records)
                        assert not any(secret in stored for secret in secrets)
                        await page.screenshot(path='/tmp/poppop-storage-retrying.png', full_page=True)
                        await page.locator('#result-saving[data-status="saved"]').wait_for(timeout=15000)
                        await until(lambda: calls['leaderboards'] == baseline_reads + 2)
                        assert len(calls['results']) == 3 and all(body == calls['results'][0] for body in calls['results'])
                        assert calls['applied'] == {first_match}
                        await until(lambda: not list(Path(directory).glob('*.json')))
                        health = await (await page.request.get(base + '/health/storage')).json()
                        assert health['status'] == 'ok' and health['failed'] == 0
                        await page.screenshot(path='/tmp/poppop-storage-saved.png', full_page=True)
                        await page.evaluate('window.__testSockets.at(-1).close()')
                        await page.locator('#arena[data-connection="reconnecting"]').wait_for()
                        await page.locator('#arena[data-connection="connected"]').wait_for()
                        await page.locator('#result-saving[data-status="saved"]').wait_for()
                        await asyncio.sleep(.25)
                        assert calls['leaderboards'] == baseline_reads + 2, 'same-match resume cannot trigger another auto-refresh'
                        print('PASS: authenticated browser retry→saved, durable private payload, identical replay after lost acknowledgement, one ranking refresh per player/match', flush=True)

                        calls['reject'] = True
                        for c in clients:
                            await c['page'].locator('#replay-button').click()
                        await until(lambda: state().get('phase') == 'playing' and state()['matchId'] != first_match)
                        assert await page.locator('#result-saving').is_hidden()
                        await page.locator('#arena').focus()
                        await page.keyboard.press('Space')
                        await page.locator('#result-saving[data-status="failed"]').wait_for(timeout=12000)
                        await asyncio.sleep(1.2)
                        assert len(calls['results']) == 4 and calls['leaderboards'] == baseline_reads + 2
                        response = await page.request.get(base + '/health/storage')
                        health = await response.json()
                        assert response.status == 503 and health['failed'] == 1
                        assert list(Path(directory).glob('*.json')), 'permanent rejection must retain result for operator recovery'
                        assert not any(secret in json.dumps(health) for secret in secrets)
                        assert 'private-provider-detail' not in await page.locator('body').inner_text()
                        assert await page.locator('#replay-button').is_enabled()
                        await page.screenshot(path='/tmp/poppop-storage-failed.png', full_page=True)
                        log.seek(0)
                        log_text = log.read().decode()
                        assert not any(secret in log_text for secret in secrets)
                        assert not errors, errors
                        print('PASS: permanent rejection is visible, retained/degraded, no retry storm or false ranking success; rematch remains available', flush=True)
                    finally:
                        await browser.close()
            finally:
                server.terminate()
                try:
                    server.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
    finally:
        provider.shutdown()
        provider.server_close()
        thread.join(timeout=2)


if __name__ == '__main__':
    asyncio.run(main())
