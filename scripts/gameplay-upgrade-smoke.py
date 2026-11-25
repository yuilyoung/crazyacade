"""Real UI/keyboard checks for five maps, wall hits, capture/rescue and 10s rAF.
No gameplay state, network input or simulation clock injection.
"""
import asyncio
import importlib.util
import json
from pathlib import Path
import shutil
import time
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('shell_smoke',ROOT/'scripts/game-shell-smoke.py')
shell=importlib.util.module_from_spec(spec);spec.loader.exec_module(shell)
OUT=Path('/tmp/crazyacade-upgrade/browser');OUT.mkdir(parents=True,exist_ok=True)

async def move(page,observed,key,x,y):
    await page.locator('#arena').focus()
    await page.keyboard.press(key)
    await shell.until(lambda:(observed.me().get('x'),observed.me().get('y'))==(x,y),f'move {x},{y}')

async def main():
    evidence=shell.Evidence(OUT)
    async with shell.server(True,evidence) as base, async_playwright() as pw:
        executable=shutil.which('chromium') or shutil.which('chromium-browser') or pw.chromium.executable_path
        browser=await pw.chromium.launch(executable_path=executable,headless=True,args=['--no-sandbox','--disable-background-timer-throttling','--disable-renderer-backgrounding'])
        try:
            context=await browser.new_context(viewport={'width':1280,'height':720})
            page=await context.new_page();observed=shell.PublicState(page)
            await page.goto(base);await shell.open_lobby(page)
            signatures=[]
            for map_id in ['garden','lagoon','candy','harbor','festival']:
                await page.locator('#screen-lobby .shell-lobby-menu [data-screen="maps"]').click()
                await page.locator(f'input[name="mapId"][value="{map_id}"]').check()
                assert await page.locator('#map-description').inner_text()
                await page.screenshot(path=str(OUT/f'{map_id}-selection.png'))
                await page.locator('#practice-button').click()
                await shell.until(lambda:observed.state.get('phase')=='playing' and observed.state.get('mapId')==map_id,'selected actual map')
                await shell.screen(page,'battle')
                signatures.append(tuple(sorted(observed.state['solid'])))
                await page.screenshot(path=str(OUT/f'{map_id}-battle.png'))
                await page.locator('#leave-button').click();await shell.screen(page,'lobby')
            assert len(set(signatures))==5
            await context.close()

            # Two genuine human inputs on one team, AI filling the other six seats.
            contexts=[];pages=[];players=[];room=f'upgrade-{time.time_ns()}'
            for index in range(2):
                ctx=await browser.new_context(viewport={'width':1280,'height':720});contexts.append(ctx)
                p=await ctx.new_page();o=shell.PublicState(p);pages.append(p);players.append(o)
                await p.goto(base);await shell.open_lobby(p);await p.locator('#quick-friends').click()
                await p.locator('#mode').select_option('team');await p.locator('#human-slots').select_option('2')
                await p.locator('#team-preference').select_option('blue');await p.locator('#room-id').fill(room)
                await p.locator('#join-button').click()
            for p,o in zip(pages,players):
                await shell.until(lambda:o.state.get('phase')=='playing','friend+AI game');await shell.screen(p,'battle')
            p,o=pages[0],players[0];rescuer,ro=pages[1],players[1]
            assert (o.me()['x'],o.me()['y'])==(1,1)
            assert (ro.me()['x'],ro.me()['y'])==(1,4)
            await move(rescuer,ro,'ArrowRight',2,4);await move(rescuer,ro,'ArrowDown',2,3);await move(rescuer,ro,'ArrowDown',2,2)
            await p.bring_to_front();await p.locator('#settings-open').click()
            await p.locator('#sound-toggle').click();await p.locator('#music-toggle').click()
            assert await p.locator('#sound-toggle').get_attribute('aria-pressed')=='true'
            # Observe the trusted close and the very next physical key in their event handlers.
            interaction=await p.evaluate_handle("""() => {
                const result={};
                document.querySelector('#settings-close').addEventListener('click', () => {
                    const dialog=document.querySelector('#settings-dialog');
                    result.closed=!dialog.open && !dialog.contains(document.querySelector('#play-settings-panel'));
                    result.returnFocus=document.activeElement.id;
                }, {once:true});
                window.addEventListener('keydown', event => {
                    result.keyTarget=event.target.id;
                    result.accepted=event.isTrusted && event.code==='ArrowLeft' && event.defaultPrevented;
                }, {once:true});
                return result;
            }""")
            previous_hits=o.me()['wallHits']
            await p.locator('#settings-close').click();await p.locator('#arena').focus()
            await p.keyboard.press('ArrowLeft')
            close_and_key=await interaction.json_value();await interaction.dispose()
            assert close_and_key=={'closed':True,'returnFocus':'settings-open','keyTarget':'arena','accepted':True},close_and_key
            await shell.until(lambda:o.me().get('wallHits',0)>previous_hits,'actual wall hit')
            await p.keyboard.press('Space');await shell.until(lambda:o.me().get('bubbleTicks',0)>0,'actual imprisonment')
            await p.wait_for_timeout(120);await p.screenshot(path=str(OUT/'capture.png'))
            # Wait for the real wave to expire, without waiting out the bubble.
            await shell.until(lambda:not o.state.get('waves'),'wave expiry')
            await move(rescuer,ro,'ArrowDown',2,1)
            await shell.until(lambda:o.me().get('bubbleTicks')==0 and ro.me().get('rescues',0)>0,'actual rescue')
            await p.wait_for_timeout(80);await p.screenshot(path=str(OUT/'escape.png'))
            assert o.me()['alive'];assert not o.errors+ro.errors,o.errors+ro.errors
            for ctx in contexts:await ctx.close()

            # One active page, default full effects, actual AI7 match and physical movement.
            ctx=await browser.new_context(viewport={'width':1280,'height':720});p=await ctx.new_page();o=shell.PublicState(p)
            await p.goto(base);await shell.open_lobby(p);await p.locator('#quick-friends').click();await p.locator('#practice-button').click()
            await shell.until(lambda:o.state.get('phase')=='playing','frame sample game')
            await p.locator('#arena').focus()
            async def inputs():
                for i in range(40):
                    await p.keyboard.press('ArrowRight' if i%2==0 else 'ArrowLeft');await asyncio.sleep(.25)
            measure=p.evaluate('''async()=>await new Promise(resolve=>{
              const intervals=[];let last=null,start=null;
              function sample(t){if(start===null)start=t;if(last!==null)intervals.push(t-last);last=t;
                if(t-start<10000)requestAnimationFrame(sample);else resolve({intervals,durationMs:t-start,userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight],effects:'full',sample:'one real AI7 match with keyboard movement'});}
              requestAnimationFrame(sample);
            })''')
            frames,_=await asyncio.gather(measure,inputs())
            assert not o.errors,o.errors
            (OUT/'frames.json').write_text(json.dumps(frames,indent=2))
            await p.screenshot(path=str(OUT/'frame-sample.png'))
            await ctx.close()
            print(json.dumps({'maps':5,'wallHit':True,'capture':True,'rescue':True,'audioEnabled':True,'frames':len(frames['intervals']),'durationMs':frames['durationMs']}))
        finally:await browser.close()

asyncio.run(main())
