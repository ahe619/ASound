// The real retell UI and device detector, with observable engine stubs and no downloaded models.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const app = path.resolve(__dirname, '../app');
const story = {title:'The Lost Umbrella', points:['the bus','the blue umbrella','a funny message','the lost and found','a coffee for the driver'],
 story:'On Monday morning, Mia took the bus to work. It was raining hard, so she carried her big blue umbrella. She was reading a funny message from her sister and almost missed her stop. She jumped off the bus just in time, but the umbrella stayed on the seat. All day she felt bad about it. After work, she went back to the bus station and asked at the lost and found. A kind driver had found it and kept it safe. Mia thanked him and bought him a coffee.'};
const speech = `export const VOICES=[],recommendVoices=()=>[],voiceById=()=>({}),speak=()=>{},stopSpeaking=()=>{},audioContext=()=>null;
export const unlockAudio=()=>{window.spies.unlocks++};
export const speakBtn=(text,label)=>{const b=document.createElement('button');b.textContent=label||text;return b};`;
const ai = `export const aiErrorText=()=> 'Unavailable';export const askJSON=(prompt,opts={})=>{
 window.spies.asks++; if(window.holdAI)return new Promise(resolve=>{window.pendingAI={resolve,signal:opts.signal}});
 return Promise.resolve(prompt.startsWith('Write a')?window.testStory:{chunk:'took the bus',better:'rode the bus',note:'A shorter expression.'});};`;
const harness = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="css/app.css"><link rel="stylesheet" href="css/feat/retell.css"></head><body><main id="root" class="wrap stack"></main>
<script type="module">import {setLanguage,addStrings} from './js/i18n.js';import {mount} from './js/feat-retell.js';
const extra=await fetch('locales/feat/retell.json').then(r=>r.json());for(const [lang,strings]of Object.entries(extra))addStrings(lang,strings);
await setLanguage('en');window.dispose=mount(document.querySelector('#root'));window.ready=true;</script></body></html>`;
const profiles = [
 ['iOS Safari','Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',true],
 ['iOS Chrome','Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',true],
 ['Android Chrome','Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',true],
 ['iPad desktop Safari','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',true],
 ['desktop without models','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',false],
 ['desktop with models','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',true],
];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.ASOUND_BROWSER||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined)});
 const report=[];
 try{
  for(const [name,userAgent,installed] of profiles){
   const desktop=name.startsWith('desktop'),context=await browser.newContext({userAgent,viewport:{width:desktop?1100:390,height:900}}),page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',async route=>{
    const u=new URL(route.request().url());assert.equal(u.hostname,'asound.test','No external model request is allowed');const rel=u.pathname.slice(1);
    if(!rel)return route.fulfill({contentType:'text/html',body:harness});
    if(rel==='js/speech.js')return route.fulfill({contentType:'text/javascript',body:speech});
    if(rel==='js/ai.js')return route.fulfill({contentType:'text/javascript',body:ai});
    if(rel==='js/packs.js')return route.fulfill({contentType:'text/javascript',body:'export const activePacks=()=>window.testPacks;'});
    try{await route.fulfill({body:await fs.readFile(path.join(app,rel)),contentType:rel.endsWith('.js')?'text/javascript':rel.endsWith('.json')?'application/json':rel.endsWith('.css')?'text/css':'application/octet-stream'});}catch{await route.fulfill({status:404,body:'Not found'});}
   });
   await context.addInitScript(({installed,name,story})=>{
    window.spies={preloads:0,asks:0,records:0,cancels:0,transcribes:0,unlocks:0};window.claude={};window.testStory=story;
    window.testPacks={llm:installed?'llm-cpu':null,asr:installed?'asr-tiny':null};
    localStorage.setItem('asound.layout.v1','desktop'); // A layout override must never authorize mobile inference.
    if(name==='iPad desktop Safari'){Object.defineProperty(navigator,'platform',{get:()=> 'MacIntel'});Object.defineProperty(navigator,'maxTouchPoints',{get:()=>5});}
    window.ASoundMic={supported:true,preload(){spies.preloads++},cancel(){spies.cancels++},
     async record(){spies.records++},async stop(){return {audio:new Float32Array(64000).fill(0.2)}},
     async transcribe(){spies.transcribes++;return story.story}};
   },{installed,name,story});
   await page.goto('http://asound.test/');await page.waitForFunction(()=>window.ready);
   assert.deepEqual(await page.evaluate(()=>spies),{preloads:0,asks:0,records:0,cancels:0,transcribes:0,unlocks:0});
   await page.locator('.rt-choice').first().click();await page.waitForSelector('.drill-text.para',{state:'attached'});
   assert.equal(await page.evaluate(()=>spies.asks),desktop&&installed?1:0);
   assert.equal(await page.evaluate(()=>spies.unlocks),0,'Choosing a story does not initialize audio');
   const text=await page.locator('.drill-text.para').textContent();
   for(let round=1;round<=3;round++){
    await page.getByRole('button',{name:new RegExp(`^Start round ${round}`)}).click();
    if(installed)await page.getByRole('button',{name:'Type instead',exact:true}).click();
    else assert.equal(await page.getByRole('button',{name:'Start speaking',exact:true}).isVisible(),false);
    await page.getByRole('textbox',{name:'Your retelling',exact:true}).fill(text);
    await page.getByRole('button',{name:'Submit this round',exact:true}).click();
   }
   await page.getByRole('heading',{name:'How you changed',exact:true}).waitFor();
   const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('asound.retell.v1'))[0]);
   assert.equal(saved.rounds.length,3);for(const r of saved.rounds){assert.ok(r.words>50);assert.equal(r.wpm,null);assert.equal(r.pauses,null);assert.equal(r.points,saved.total);}
   const typedSpies=await page.evaluate(()=>spies);
   assert.equal(typedSpies.preloads,0);assert.equal(typedSpies.records,0);assert.equal(typedSpies.asks,desktop&&installed?4:0);
   if(installed){
    await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByRole('button',{name:/^Start round 1/}).click();
    await page.getByRole('button',{name:'Start speaking',exact:true}).click();await page.getByRole('button',{name:"I'm done",exact:true}).click();
    await page.getByRole('heading',{name:'How that round went',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>spies.records),1);assert.equal(await page.evaluate(()=>spies.transcribes),1);
   }
   if(desktop&&installed){
    await page.locator('.back').click();await page.evaluate(()=>{window.holdAI=true});await page.locator('.rt-choice').first().click();await page.waitForFunction(()=>!!window.pendingAI);
    await page.evaluate(()=>{dispose();document.querySelector('#root').textContent='Exited';pendingAI.resolve(testStory)});
    assert.equal(await page.evaluate(()=>pendingAI.signal.aborted),true);assert.equal(await page.locator('#root').innerText(),'Exited');
   }
   assert.deepEqual(errors,[]);report.push({profile:name,threeTypedRounds:true,spies:typedSpies,explicitRecording:installed});await context.close();
  }
  console.log(JSON.stringify(report,null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
