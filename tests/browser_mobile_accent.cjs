// Real DOM, packs, engines, local-ai, mic controls and storage. Tiny cached model
// fixtures and deterministic runtime doubles prove which engines are invoked;
// this is not a measurement of real model memory or an iOS process-crash test.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
async function openDrill(page) {
 const section = page.locator('#accent-topics');
 if (!await section.evaluate(el => el.open)) await section.locator('summary').click();
 await page.click('#drill-start');
}
const app = path.resolve(__dirname, '../app'), origin = 'https://accent.test';
const correctionText = 'Yesterday I walked through a quiet park with my friends and watched the birds beside the river. We talked about our weekend plans and decided to visit the library together after lunch.';
const cpu = `export class Wllama {
 constructor(){window.diag.llmLoads++}setCompat(){}async loadModel(){}exit(){}
 async *createChatCompletion(){window.diag.generations++;yield {choices:[{delta:{content:JSON.stringify({text:${JSON.stringify(correctionText)},sentences:[],points:[],problems:[],drills:[]})},finish_reason:'stop'}]};}
}`;
const voice = `window.diag.voiceLoads++;export const configure=()=>{};export const onStatus=()=>{};
export const synthesize=async()=>{window.diag.voiceCalls++;return {pcm:new Float32Array(2400),sr:24000}};`;
const microphone = `window.ASoundMic={supported:true,RATE:16000,hasModel:()=>true,hasNative:()=>false,
 status:()=>({asr:'ready',mic:window.recording?'recording':'off'}),onStatus:()=>()=>{},configure(){},configureHelp(){},
 preload(){window.diag.asrPreloads++},cancel(){window.recording=false;window.cancels=(window.cancels||0)+1},
 async record(){window.recording=true},async stop(){window.recording=false;await window.heldTranscript;return {text:'zebra',audio:new Float32Array(16000)}}};`;

(async()=>{
 const catalog=JSON.parse(await fs.readFile(path.join(app,'packs.json'),'utf8'));
 catalog.packs=catalog.packs.filter(pack=>['llm-cpu','asr-tiny','voice'].includes(pack.id));
 for(const pack of catalog.packs){for(const file of pack.files)file.size=4;pack.size=pack.files.length*4;}
 const browser=await chromium.launch({headless:true,executablePath:process.env.ASOUND_BROWSER||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined)});
 const passed=[];
 async function fixture(profile){
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN',...(profile.ua?{userAgent:profile.ua}:{}),hasTouch:!!profile.mobile});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(({tablet,realMic})=>{
   window.diag={jsonCalls:0,llmLoads:0,generations:0,voiceLoads:0,voiceCalls:0,asrPreloads:0};
   if(tablet){Object.defineProperty(navigator,'maxTouchPoints',{value:5});Object.defineProperty(navigator,'platform',{value:'MacIntel'});}
   if(realMic){
    // Exercise the real voice-input and mic modules with observable device resources,
    // including delayed worklet setup and ASR. No actual microphone or model is used.
    window.hardware={tracks:[],contexts:[],nodes:[],holdWorklet:false};
    class Context{
     constructor(){this.state='running';this.closed=false;this.audioWorklet={addModule:()=>hardware.holdWorklet?new Promise(r=>hardware.releaseWorklet=r):Promise.resolve()};hardware.contexts.push(this)}
     createMediaStreamSource(){return{connect(){},disconnect(){}}}async resume(){this.state='running'}async close(){this.state='closed';this.closed=true}
    }
    class Worklet{constructor(){this.port={};hardware.nodes.push(this)}disconnect(){}}
    class RecognizerWorker{
     postMessage(m){
      if(m.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));
      if(m.type==='transcribe')Promise.resolve(window.heldTranscript).then(()=>this.onmessage({data:{type:'text',id:m.id,text:'zebra'}}));
     }terminate(){}
    }
    window.AudioContext=window.webkitAudioContext=Context;window.AudioWorkletNode=Worklet;window.Worker=RecognizerWorker;
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
     const track={stopped:false,stop(){this.stopped=true}};hardware.tracks.push(track);return{getTracks:()=>[track]};
    }});
   }
  },{tablet:profile.tablet,realMic:profile.realMic});
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
   const rel=url.pathname.slice(1)||'index.html';
   if(rel==='seed.html')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated fixture</title>'});
   if(rel==='version.json')return route.fulfill({status:404,body:'{}',contentType:'application/json'});
   if(rel==='packs.json')return route.fulfill({contentType:'application/json',body:JSON.stringify(catalog)});
   if(rel==='vendor/wllama/index.js')return route.fulfill({contentType:'text/javascript',body:cpu});
   if(rel==='kokoro/neural-tts.js')return route.fulfill({contentType:'text/javascript',body:voice});
   if(rel==='js/voice-input.js'&&!profile.realMic)return route.fulfill({contentType:'text/javascript',body:microphone});
   try{
    const file=rel==='js/accent.js'&&process.env.ASOUND_ACCENT_SOURCE?process.env.ASOUND_ACCENT_SOURCE:path.join(app,rel);
    const body=await fs.readFile(file);
    await route.fulfill({body,contentType:rel.endsWith('.js')?'text/javascript':rel.endsWith('.html')?'text/html':rel.endsWith('.css')?'text/css':rel.endsWith('.json')?'application/json':'application/octet-stream'});
   }catch{await route.fulfill({status:404,body:'{}',contentType:'application/json'});}
  });
  await page.goto(origin+'/seed.html');
  await page.evaluate(async data=>{
   localStorage.setItem('asound.prefs.v1',JSON.stringify({uiLang:'zh',helpLang:'zh',voiceEngine:'browser',source:'hf'}));
   const cache=await caches.open('asound-models-v1');
   for(const pack of data.packs)for(const f of pack.files)await cache.put('https://models.asound.invalid/'+(f.repo?`${f.repo}/${f.path}`:f.path),new Response(new Uint8Array(f.size)));
  },catalog);
  await page.goto(origin+'/?web&nogpu#accent');await page.locator('#check-start').waitFor();
  const configured=await page.evaluate(async()=>{
   await (await import('./js/engines.js')).enginesApplied;
   const packs=await import('./js/packs.js'),speech=await import('./js/speech.js');
   const sample=await claude.use('sample'),json=sample.json;sample.json=(...args)=>{diag.jsonCalls++;return json(...args)};
   return{active:packs.activePacks(),llm:ASoundAI.status().model,voice:speech.voiceCapabilities().browser,device:(await import('./js/device.js')).deviceInfo()};
  });
  assert.equal(configured.active.llm,'llm-cpu');assert.equal(configured.active.asr,'asr-tiny');assert.equal(configured.active.voice,'voice');
  assert.equal(configured.llm,'llm-cpu');assert.equal(configured.voice,true);assert.equal(configured.device.mobile,!!profile.mobile);
  async function frames(){await page.evaluate(()=>{if(window.hardware)for(let i=0;i<15;i++)hardware.nodes.at(-1).port.onmessage({data:new Float32Array(512).fill(.2)})});}
  async function record(){await page.locator('#accent .mic-btn').click();await page.waitForFunction(()=>ASoundMic.status().mic==='recording');await frames();await page.locator('#accent .mic-btn').click();await page.locator('#accent .score').waitFor();}
  async function idleModels(){assert.deepEqual(await page.evaluate(()=>diag),{jsonCalls:0,llmLoads:0,generations:0,voiceLoads:0,voiceCalls:0,asrPreloads:0});}
  return{context,page,errors,record,frames,idleModels};
 }
 try{
  const mobileProfiles=[
   {name:'iPhone Safari',mobile:true,ua:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'},
   {name:'iPhone Chrome',mobile:true,ua:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0.0.0 Mobile/15E148 Safari/604.1'},
   {name:'Android Chrome',mobile:true,ua:'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36'},
   {name:'iPad desktop user agent',mobile:true,tablet:true,ua:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'},
  ];
  for(const profile of mobileProfiles){
   const f=await fixture(profile),{page}=f;
   await page.evaluate(async()=>{(await import('./js/device.js')).setLayoutMode('desktop')});
   await page.click('#check-start');await page.locator('#accent .drill-text.para').waitFor();await f.idleModels();
   let previous=await page.locator('#accent .drill-text.para').innerText();
   assert.equal(await page.evaluate(async text=>(await import('./js/state.js')).PASSAGES.includes(text),previous),true);
   for(let i=0;i<4;i++){
    await page.locator('#accent .drill-nav button').last().click();
    const current=await page.locator('#accent .drill-text.para').innerText();assert.notEqual(current,previous);previous=current;
   }
   await f.record();assert.match(await page.locator('#accent').innerText(),/练一练没被识别出来的词/);
   assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('asound.checks.v1')).at(-1).score),0);
   assert.ok(await page.locator('#accent .row button.mini').count()>0,'local misspellings recommend an existing practice');
   await f.idleModels();
   await page.locator('#accent .row button.mini').first().click();await page.locator('#accent .drill-text:not(.para)').waitFor();
   assert.equal(await page.evaluate(async()=>{const drill=JSON.parse(localStorage.getItem('asound.drill.v1'));const {DRILL_BANK}=await import('./js/drill-bank.js');return drill.items.length===5&&drill.items.every(it=>DRILL_BANK[drill.drillId].includes(it.text));}),true);
   await f.record();assert.match(await page.locator('#accent').innerText(),/练一练没被识别出来的词/);
   assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('asound.drill.v1')).items[0].attempt.analysis.points),[]);
   await f.idleModels();
   await page.locator('#accent .sum-head .back').click();await openDrill(page);await page.locator('#accent .drill-text:not(.para)').waitFor();
   assert.equal(await page.locator('#accent .speak').count(),2);assert.equal(await page.locator('#accent .mic-btn').count(),1);
   await f.idleModels();assert.deepEqual(f.errors,[]);await f.context.close();
   passed.push(`${profile.name}: installed LLM/ASR/voice; roll/new passage/drill/missed-word results use zero LLM or voice initialization, even in desktop layout`);
  }
  {
   const f=await fixture({...mobileProfiles[2],realMic:true}),{page}=f;
   const off=async(where)=>{
    assert.equal(await page.evaluate(()=>ASoundMic.status().mic),'off',`${where} must stop the microphone`);
    assert.equal(await page.evaluate(()=>hardware.tracks.every(track=>track.stopped)),true,`${where} must release device tracks`);
   };
   async function startRecording(scope='#accent'){await page.locator(`${scope} .mic-btn`).first().click();await page.waitForFunction(()=>ASoundMic.status().mic==='recording');}
   await page.click('#check-start');await page.locator('#accent .drill-text.para').waitFor();
   await startRecording();await page.locator('#accent .drill-nav button').last().click();await off('New paragraph');
   await startRecording();await page.locator('#accent .drill-nav button').first().click();await off('Again');
   await startRecording();await page.locator('#accent .sum-head .back').click();await off('Back home');
   await openDrill(page);await page.locator('#accent .drill-text:not(.para)').waitFor();
   await startRecording();await page.locator('#accent .drill-nav button').last().click();await off('Next');
   await startRecording();await page.locator('#accent .drill-nav button').first().click();await off('Prev');
   await startRecording();await page.click('#tab-talk');await off('Switching to Talk');
   await page.click('#tab-accent');await page.locator('#accent .mic-btn:not(.rec)').waitFor();
   await startRecording();await page.locator('#accent .sum-head .back').click();await off('Change drill');
   await openDrill(page);await page.locator('#accent .drill-text:not(.para)').waitFor();
   await f.record();await off('Completed take');await page.click('#tab-talk');await off('Leaving after a completed take');
   await page.click('#tab-accent');await page.locator('#accent .drill-nav button').last().click();await page.locator('#accent .score').waitFor({state:'detached'});
   const repaint=()=>page.evaluate(async()=>(await import('./js/accent.js')).renderAccent()); // what a language change or closing Settings does
   await startRecording();await repaint();await off('Repainting while recording');
   await startRecording();await page.locator('#accent .mic-btn').click();await page.locator('#accent .mic-btn:not(.busy):not(.rec)').waitFor();
   await off('Completed silent take');await page.locator('#accent .drill-nav button').last().click();await off('Next after silence');
   await page.locator('#accent .drill-nav button').first().click();
   await page.evaluate(()=>{window.heldTranscript=new Promise(resolve=>{window.releaseTranscript=resolve})});
   await startRecording();await f.frames();await page.locator('#accent .mic-btn').click();await page.locator('#accent .mic-btn.busy').waitFor();await off('Transcribing a completed take');
   await repaint();await page.evaluate(()=>{window.heldTranscript=null;window.releaseTranscript()});
   await page.locator('#accent .score').waitFor();
   assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('asound.drill.v1')).items[1].attempt.heard),'zebra','a take being transcribed survives a repaint');
   await page.evaluate(()=>hardware.holdWorklet=true);await page.locator('#accent .mic-btn').click();
   await page.waitForFunction(()=>typeof hardware.releaseWorklet==='function');
   await page.click('#settings-open');await page.click('#settings-close');await page.waitForFunction(()=>document.getElementById('settings').hidden);
   await off('Settings close during capture setup');
   await page.evaluate(async()=>{hardware.holdWorklet=false;hardware.releaseWorklet();await new Promise(resolve=>setTimeout(resolve,0))});
   await off('Late capture setup after repaint');assert.equal(await page.locator('#accent .mic-btn.rec, #accent .mic-btn.busy').count(),0);
   await page.click('#tab-talk');await page.goBack();await page.waitForFunction(()=>!document.getElementById('view-accent').hidden);
   await startRecording();await page.goForward();await page.waitForFunction(()=>!document.getElementById('view-talk-home').hidden);await off('Browser Forward');
   await page.click('#tab-me');await page.locator('#me-voice > summary').click();await startRecording('#me');
   await page.locator('#me-voice > summary').click();await off('Collapsing voice matching');
   await page.locator('#me-voice > summary').click();await startRecording('#me');
   await page.evaluate(async()=>(await import('./js/accent.js')).cleanupAccent());
   assert.equal(await page.evaluate(()=>ASoundMic.status().mic),'recording','old accent cleanup must not cancel the Me microphone');
   await page.click('#tab-accent');await off('Leaving Me');
   assert.deepEqual(f.errors,[]);await f.context.close();
   passed.push('real mic lifecycle: silent/completed takes release device tracks; screen changes and browser Forward cancel capture; Settings repaint cancels pending setup but preserves transcription; stale accent cleanup keeps the newer Me recording');
  }
  {
   const f=await fixture({name:'desktop',mobile:false}),{page}=f;
   await page.evaluate(async()=>{(await import('./js/device.js')).setLayoutMode('phone')});
   await page.click('#check-start');await page.locator('#accent .drill-text.para').waitFor();
   await f.record();await page.waitForFunction(()=>diag.jsonCalls===2);
   await page.locator('#accent .sum-head .back').click();await openDrill(page);await page.waitForFunction(()=>diag.jsonCalls===3);
   await f.record();await page.waitForFunction(()=>diag.jsonCalls===4);
   assert.equal(await page.evaluate(()=>diag.llmLoads),1);assert.deepEqual(f.errors,[]);await f.context.close();
   passed.push('desktop keeps all four existing generation paths; phone layout does not change device capability');
  }
  console.log(JSON.stringify({passed},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
