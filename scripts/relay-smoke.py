"""Real eight-browser relay objectives, invitation roundtrip and same-room rematch."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import urllib.parse
import urllib.request
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]

async def until(predicate,timeout=10):
    end=asyncio.get_running_loop().time()+timeout
    while not predicate():
        if asyncio.get_running_loop().time()>end:raise AssertionError('Timed out waiting for relay state')
        await asyncio.sleep(.025)

async def main():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
    env=dict(os.environ,PORT=str(port),HOST='127.0.0.1',ALLOW_DEV_GUESTS='true',SUPABASE_URL='',SUPABASE_ANON_KEY='',SUPABASE_SERVICE_ROLE_KEY='')
    with tempfile.TemporaryFile() as log:
        server=subprocess.Popen(['node','src/index.js'],cwd=ROOT/'Server',env=env,stdout=log,stderr=log)
        try:
            base=f'http://127.0.0.1:{port}'
            for _ in range(80):
                try:
                    with urllib.request.urlopen(base+'/health',timeout=1) as response:
                        if response.status==200:break
                except OSError:await asyncio.sleep(.05)
            else:raise AssertionError('Server failed to start')
            async with async_playwright() as pw:
                browser=await pw.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox'])
                clients=[];errors=[]
                try:
                    async def new_client(viewport=None,mobile=False):
                        context=await browser.new_context(viewport=viewport or {'width':1440,'height':1000},is_mobile=mobile,has_touch=mobile)
                        page=await context.new_page();client={'page':page,'messages':[]}
                        page.on('pageerror',lambda e:errors.append(str(e)))
                        page.on('websocket',lambda ws:ws.on('framereceived',lambda frame:client['messages'].append(json.loads(frame))))
                        clients.append(client);return client
                    first=await new_client();page=first['page']
                    await page.add_init_script("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('clipboard denied')}}})")
                    await page.add_init_script("Object.defineProperty(crypto,'randomUUID',{configurable:true,value:undefined})")
                    await page.goto(base+'/?access_token=do-not-export#private-fragment')
                    await page.locator('#rule-set').wait_for(timeout=5000)
                    await page.locator('#mode').select_option('team')
                    await page.locator('#rule-set').select_option('relay')
                    await page.locator('input[name="mapId"][value="lagoon"]').check()
                    await page.locator('#item-mode').uncheck()
                    await page.locator('#invite-button').click()
                    invite=await page.locator('#invite-url').input_value()
                    url=urllib.parse.urlparse(invite);query=urllib.parse.parse_qs(url.query)
                    assert url.scheme+'://'+url.netloc==base and not url.fragment
                    assert set(query)=={'room','mode','map','items','rules'},query
                    assert query['mode']==['team'] and query['map']==['lagoon'] and query['items']==['0'] and query['rules']==['relay']
                    assert query['room'][0] and 'do-not-export' not in invite
                    assert await page.locator('#invite-url').is_visible()
                    assert await page.locator('#invite-status').inner_text()
                    await page.locator('#nickname').fill('Courier')
                    await page.locator('#join-button').click()
                    for i in range(1,8):
                        client=await new_client();other=client['page'];await other.goto(invite)
                        assert await other.locator('#rule-set').input_value()=='relay'
                        assert await other.locator('#mode').input_value()=='team'
                        assert not await other.locator('#item-mode').is_checked()
                        assert await other.locator('input[name="mapId"][value="lagoon"]').is_checked()
                        await other.locator('#nickname').fill(f'Friend{i}')
                        await other.locator('#join-button').click()
                    def state(i=0):return next((m for m in reversed(clients[i]['messages']) if m.get('type')=='state'),{})
                    def identity(i):return next((m['playerId'] for m in clients[i]['messages'] if m.get('type')=='joined'),None)
                    def player(i):return next((p for p in state()['players'] if p['id']==identity(i)),{})
                    await until(lambda:state().get('phase')=='playing')
                    assert state()['ruleSet']=='relay' and state()['ranked'] is False and state()['relay']['scores']=={'blue':0,'pink':0}
                    assert len(state()['players'])==8 and not any(p['isBot'] for p in state()['players'])
                    initial_match=state()['matchId'];initial_ids={p['id'] for p in state()['players']};initial_round=state()['round']
                    async def move(i,key,x,y):
                        await clients[i]['page'].locator('#arena').focus();await clients[i]['page'].keyboard.press(key)
                        await until(lambda:player(i).get('x')==x and player(i).get('y')==y)
                    # Bring a rescuer below the central lane; no production/test state injection.
                    await move(2,'ArrowRight',2,3);await move(2,'ArrowRight',3,3);await move(2,'ArrowUp',3,4)
                    for y in [2,3,4,5]:await move(0,'ArrowUp',1,y)
                    for x in [2,3,4,5,6]:await move(0,'ArrowRight',x,5)
                    await until(lambda:state()['relay']['carrierId']==identity(0))
                    await page.screenshot(path='/tmp/poppop-relay-carry.png',full_page=True)
                    await page.keyboard.press('Space')
                    await until(lambda:player(0).get('bubbleTicks',0)>0,timeout=4)
                    assert state()['relay']['carrierId'] is None and state()['relay']['star']=={'x':6,'y':5}
                    await until(lambda:not state()['waves'])
                    await move(2,'ArrowUp',3,5);await move(2,'ArrowRight',4,5);await move(2,'ArrowRight',5,5)
                    await until(lambda:player(0)['bubbleTicks']==0 and player(2)['rescues']==1)
                    await until(lambda:state()['relay']['carrierId']==identity(0))
                    for capture in range(1,4):
                        for x in [5,4,3,2,1]:await move(0,'ArrowLeft',x,5)
                        await until(lambda:state()['relay']['scores']['blue']==capture)
                        assert player(0)['deliveries']==capture
                        await page.locator('[data-step="delivery"][data-complete="true"]').wait_for()
                        if capture<3:
                            for x in [2,3,4,5,6]:await move(0,'ArrowRight',x,5)
                            await until(lambda:state()['relay']['carrierId']==identity(0),timeout=7)
                    await until(lambda:state()['phase']=='finished')
                    assert state()['result']['winnerTeam']=='blue' and state()['result']['reason']=='relay_goal'
                    assert state()['result']['relayScores']=={'blue':3,'pink':0}
                    assert next(p for p in state()['result']['scoreboard'] if p['id']==identity(0))['deliveries']==3
                    board=await(await page.request.get(base+'/api/leaderboard')).json();assert board['entries']==[],'relay must not change demo rankings'
                    await page.locator('#result-saving[data-status="unranked"]').wait_for()
                    await page.screenshot(path='/tmp/poppop-relay-result.png',full_page=True)
                    await page.locator('#replay-button').click()
                    await until(lambda:identity(0) in state()['rematch']['readyPlayerIds'])
                    assert state()['phase']=='finished' and await page.locator('#replay-button').is_disabled()
                    for client in clients[1:8]:await client['page'].locator('#replay-button').click()
                    await until(lambda:state()['phase']=='playing' and state()['matchId']!=initial_match)
                    assert state()['round']==initial_round+1 and {p['id'] for p in state()['players']}==initial_ids
                    assert all(p['score']==0 and p['deliveries']==0 and p['rescues']==0 for p in state()['players'])
                    assert state()['relay']['scores']=={'blue':0,'pink':0}
                    assert await page.locator('[data-step="delivery"]').get_attribute('data-complete')=='false'
                    assert len([m for m in first['messages'] if m.get('type')=='joined'])==1,'rematch keeps socket/player identity'
                    print('PASS: real invite fallback and settings roundtrip, 8-human relay pickup/drop/rescue/3 captures, no ranking writes, same-room all-ready rematch',flush=True)
                    mobile=await new_client({'width':390,'height':844},True);mobile_page=mobile['page'];await mobile_page.goto(base)
                    await mobile_page.locator('#rule-set').select_option('relay')
                    await mobile_page.locator('#practice-button').tap()
                    def mobile_state():return next((m for m in reversed(mobile['messages']) if m.get('type')=='state'),{})
                    await until(lambda:mobile_state().get('phase')=='playing')
                    assert mobile_state()['ruleSet']=='relay' and mobile_state()['practice']
                    assert await mobile_page.locator('#invite-button').is_disabled()
                    assert await mobile_page.locator('#relay-status').is_visible()
                    assert await mobile_page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                    for selector in ['[data-action="down"]','[data-action="place_orb"]']:
                        box=await mobile_page.locator(selector).bounding_box()
                        assert box and min(box['width'],box['height'])>=44 and box['y']+box['height']<=844,(selector,box)
                    await until(lambda:any(m.get('relay',{}).get('carrierId') for m in mobile['messages'] if m.get('type')=='state' and m.get('relay')),timeout=45)
                    await mobile_page.screenshot(path='/tmp/poppop-relay-mobile.png',full_page=True)
                    assert not errors,errors
                    print('PASS: mobile relay practice with active courier bots, objective UI, visible touch controls and no page errors',flush=True)
                finally:await browser.close()
        finally:
            server.terminate()
            try:server.wait(timeout=5)
            except subprocess.TimeoutExpired:server.kill();server.wait()

if __name__=='__main__':asyncio.run(main())
