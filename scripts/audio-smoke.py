"""Real Web Audio controls and offline audition. Writes original music preview WAV."""
import asyncio
import base64
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import urllib.request
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parents[1]

async def main():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0)); port=listener.getsockname()[1]
    env=dict(os.environ,PORT=str(port),HOST='127.0.0.1',ALLOW_DEV_GUESTS='false',SUPABASE_URL='',SUPABASE_ANON_KEY='',SUPABASE_SERVICE_ROLE_KEY='')
    with tempfile.TemporaryDirectory(prefix='poppop-audio-results-') as storage, tempfile.TemporaryFile() as log:
        env['RESULT_OUTBOX_DIR']=storage
        server=subprocess.Popen(['node','src/index.js'],cwd=ROOT/'Server',env=env,stdout=log,stderr=log)
        try:
            base=f'http://127.0.0.1:{port}'
            for _ in range(80):
                try:
                    with urllib.request.urlopen(base+'/health',timeout=1) as r:
                        if r.status==200: break
                except OSError: await asyncio.sleep(.05)
            else: raise AssertionError('Server did not start')
            async with async_playwright() as pw:
                browser=await pw.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox'])
                try:
                    page=await browser.new_page(viewport={'width':1440,'height':1000})
                    errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
                    await page.add_init_script('''
                      window.__audioStarts=0; window.__audioContexts=0; window.__contexts=[];
                      const Native=window.AudioContext;
                      window.AudioContext=class extends Native {
                        constructor(...args){super(...args);window.__audioContexts++;window.__contexts.push(this);}
                        createOscillator(){const n=super.createOscillator(),start=n.start;n.start=function(...a){window.__audioStarts++;return start.apply(this,a)};return n;}
                      };
                    ''')
                    await page.goto(base)
                    await page.locator('#music-toggle').wait_for(timeout=5000)
                    assert await page.evaluate('__audioContexts')==0,'must not create audio context before a gesture'
                    assert await page.locator('#music-toggle').get_attribute('aria-pressed')=='false'
                    await page.locator('#music-toggle').click()
                    await page.locator('#music-toggle[aria-pressed="true"]').wait_for()
                    await page.wait_for_function('__audioStarts > 0')
                    assert await page.locator('#sound-toggle').get_attribute('aria-pressed')=='false'
                    assert await page.evaluate('__audioContexts')==1
                    await page.locator('#volume-toggle').click()
                    await page.locator('#music-volume').fill('20')
                    assert await page.locator('#music-volume').input_value()=='20'
                    await page.locator('#effects-volume').fill('45')
                    await page.locator('#volume-toggle').click()
                    await page.locator('#sound-toggle').click()
                    await page.locator('#sound-toggle[aria-pressed="true"]').wait_for()
                    await page.locator('#sound-toggle').click()
                    assert await page.locator('#music-toggle').get_attribute('aria-pressed')=='true','channels must be independent'
                    before=await page.evaluate('__audioStarts')
                    await page.wait_for_function('__audioStarts > '+str(before),timeout=4000)
                    await page.locator('#music-toggle').click()
                    assert await page.locator('#music-toggle').get_attribute('aria-pressed')=='false'
                    muted=await page.evaluate('__audioStarts')
                    await asyncio.sleep(2.5)
                    assert await page.evaluate('__audioStarts')==muted,'muted music must stop scheduling'
                    await page.locator('#music-toggle').click()
                    await page.locator('#music-toggle[aria-pressed="true"]').wait_for()
                    await page.evaluate('window.__contexts[0].suspend()')
                    paused=await page.evaluate('__audioStarts')
                    await asyncio.sleep(2.5)
                    assert await page.evaluate('__audioStarts')==paused,'browser audio interruption must stop scheduling'
                    await page.evaluate('window.__contexts[0].resume()')
                    await page.wait_for_function('__audioStarts > '+str(paused),timeout=4000)
                    await page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))")
                    hidden=await page.evaluate('__audioStarts')
                    await asyncio.sleep(2.5)
                    assert await page.evaluate('__audioStarts')==hidden,'hidden tab must stop music scheduling'
                    await page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))")
                    await page.wait_for_function('__audioStarts > '+str(hidden),timeout=4000)
                    await page.locator('#practice-button').click()
                    await page.locator('#arena[data-phase="playing"]').wait_for()
                    await page.screenshot(path='/tmp/poppop-audio-controls.png',full_page=True)
                    await page.reload()
                    assert await page.locator('#music-toggle').get_attribute('aria-pressed')=='false'
                    assert await page.locator('#sound-toggle').get_attribute('aria-pressed')=='false'
                    assert await page.evaluate('__audioContexts')==0,'reload must not autoplay'
                    audition=await page.evaluate('''async()=>{
                      const {scheduleMusicBar,scheduleEffect,musicBarDuration}=await import('/audio.js');
                      const bars=8, rate=44100, barSeconds=musicBarDuration('battle');
                      const seconds=bars*barSeconds+1.5;
                      const ctx=new OfflineAudioContext(2,Math.ceil(seconds*rate),rate);
                      const music=ctx.createGain();music.gain.value=.35;music.connect(ctx.destination);
                      const effects=ctx.createGain();effects.gain.value=.6;effects.connect(ctx.destination);
                      for(let bar=0;bar<bars;bar++)scheduleMusicBar(ctx,music,.05+bar*barSeconds,bar,'battle');
                      ['bomb','wave','item','rescue','victory'].forEach((kind,i)=>scheduleEffect(ctx,effects,kind,1.5+i*2.6));
                      const rendered=await ctx.startRendering();
                      let peak=0,power=0; const left=rendered.getChannelData(0),right=rendered.getChannelData(1);
                      for(let i=0;i<left.length;i++){if(!Number.isFinite(left[i])||!Number.isFinite(right[i]))throw Error('nonfinite audio');peak=Math.max(peak,Math.abs(left[i]),Math.abs(right[i]));power+=left[i]*left[i];}
                      const buffer=new ArrayBuffer(44+left.length*4),view=new DataView(buffer);
                      const text=(offset,value)=>[...value].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
                      text(0,'RIFF');view.setUint32(4,buffer.byteLength-8,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,2,true);view.setUint32(24,rate,true);view.setUint32(28,rate*4,true);view.setUint16(32,4,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,left.length*4,true);
                      for(let i=0;i<left.length;i++){view.setInt16(44+i*4,Math.max(-1,Math.min(1,left[i]))*32767,true);view.setInt16(46+i*4,Math.max(-1,Math.min(1,right[i]))*32767,true);}
                      const bytes=new Uint8Array(buffer);let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));
                      return{seconds,barSeconds,peak,rms:Math.sqrt(power/left.length),wav:btoa(raw)};
                    }''')
                    assert .005<audition['peak']<.98,audition['peak']
                    assert audition['rms']>.001,audition['rms']
                    Path('/tmp/poppop-audio-preview.wav').write_bytes(base64.b64decode(audition.pop('wav')))
                    profiles=await page.evaluate('''async()=>{
                      const {createAudioDirector}=await import('/audio.js');
                      const rate=44100, seconds=2, onsetMs=10, highBandHz=4000;
                      // One real offline context compares both production signal
                      // paths simultaneously: bright/soft dry, then their >4kHz bands.
                      const ctx=new OfflineAudioContext(4,rate*seconds,rate);
                      const merger=ctx.createChannelMerger(4);merger.connect(ctx.destination);
                      const destinations=[0,1].map(index=>{
                        const output=ctx.createGain();output.channelCount=1;output.channelCountMode='explicit';
                        output.connect(merger,0,index);
                        const high=ctx.createBiquadFilter();high.type='highpass';
                        high.frequency.value=highBandHz;high.Q.value=.707;
                        output.connect(high);high.connect(merger,0,index+2);return output;
                      });
                      // The adapter supplies actual offline Web Audio nodes to
                      // createAudioDirector, including its profile gains/filters.
                      // It never constructs or resumes a live audio device.
                      class OfflineDevice {
                        constructor(){this.destination=destinations.shift();this.sampleRate=rate;}
                        get state(){return 'running'} get currentTime(){return ctx.currentTime}
                        createGain(){return ctx.createGain()} createOscillator(){return ctx.createOscillator()}
                        createBufferSource(){return ctx.createBufferSource()} createBiquadFilter(){return ctx.createBiquadFilter()}
                        createBuffer(...args){return ctx.createBuffer(...args)} async close(){} async resume(){}
                      }
                      const Native=window.AudioContext,directors=[];
                      const rms=samples=>{
                        let power=0;
                        for(const sample of samples){if(!Number.isFinite(sample))throw Error('nonfinite profile audio');power+=sample*sample;}
                        return Math.sqrt(power/samples.length);
                      };
                      try{
                        window.AudioContext=OfflineDevice;
                        for(const profile of ['bright','soft']){
                          const director=createAudioDirector();directors.push(director);
                          director.setProfile(profile);await director.setEffectsEnabled(true);
                          director.playEffect('wave');director.playEffect('rescue');
                        }
                        const rendered=await ctx.startRendering();
                        const measures=index=>{
                          const dry=rendered.getChannelData(index),high=rendered.getChannelData(index+2);
                          return{rms:rms(dry),onsetRms:rms(dry.subarray(0,rate*onsetMs/1000)),highBandRms:rms(high)};
                        };
                        const bright=measures(0),soft=measures(1);
                        return{sampleRate:rate,seconds,onsetMs,highBandHz,events:['wave','rescue'],bright,soft,
                          ratios:{rms:soft.rms/bright.rms,onset:soft.onsetRms/bright.onsetRms,highBand:soft.highBandRms/bright.highBandRms,
                            normalizedOnset:(soft.onsetRms/soft.rms)/(bright.onsetRms/bright.rms),
                            normalizedHighBand:(soft.highBandRms/soft.rms)/(bright.highBandRms/bright.rms)}};
                      }finally{
                        for(const director of directors)director.dispose();window.AudioContext=Native;
                      }
                    }''')
                    profile_path=Path('/tmp/poppop-audio-profile.json')
                    profile_path.write_text(json.dumps(profiles,indent=2)+'\n')
                    for profile in ['bright','soft']:
                        assert profiles[profile]['rms']>.0001,profiles
                        assert profiles[profile]['onsetRms']>.0001,profiles
                        assert profiles[profile]['highBandRms']>.000001,profiles
                    # Normalize by total RMS so reducing volume alone cannot pass
                    # as softened attacks/filtering. Broad bounds tolerate DSP
                    # differences rather than requiring sample-exact ratios.
                    assert 0<profiles['ratios']['rms']<1,profiles
                    assert 0<profiles['ratios']['normalizedOnset']<.8,profiles
                    assert 0<profiles['ratios']['normalizedHighBand']<.8,profiles
                    assert await page.evaluate('__audioContexts')==0,'offline comparison must not create a live audio context'
                    assert not errors,errors
                    print('PASS: real Web Audio lazy unlock, independent music/effects/volumes, mute, audio interruption recovery, hidden-tab pause, reload autoplay prevention; '+json.dumps(audition),flush=True)
                    print('PASS: bright/soft production profiles have nonzero offline output with reduced onset/high-frequency RMS; '+json.dumps(profiles)+'; artifact='+str(profile_path),flush=True)
                finally: await browser.close()
        finally:
            server.terminate()
            try:server.wait(timeout=5)
            except subprocess.TimeoutExpired:server.kill();server.wait()

if __name__=='__main__':asyncio.run(main())
