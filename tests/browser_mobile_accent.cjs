// Real DOM, packs, engines, local-ai, mic controls and storage. Tiny cached model
// fixtures and deterministic runtime doubles prove which engines are invoked;
// this is not a measurement of real model memory or an iOS process-crash test.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app'), origin = 'https://accent.test';
const correctionText = 'Yesterday I walked through a quiet park with my friends and watched the birds beside the river. We talked about our weekend plans and decided to visit the library together after lunch.';
const cpu = `export class Wllama {
 constructor(){window.diag.llmLoads++}setCompat(){}async loadModel(){}exit(){}
 async *createChatCompletion(){window.diag.generations++;yield {choices:[{delta:{content:JSON.stringify({text:${JSON.stringify(correctionText)},sentences:[],points:[],problems:[],drills:[]})},finish_reason:'stop'}]};}
}`;
const voice = `window.diag.voiceLoads++;export const configure=()=>{};export const onStatus=()=>{};
export const synthesize=async()=>{window.diag.voiceCalls++;return {pcm:new Float32Array(2400),sr:24000}};`;
const microphone = `window.ASoundMic={supported:true,RATE:16000,hasModel:()=>true,hasNative:()=>false,
 status:()=>({asr:'ready',mic:'off'}),onStatus:()=>()=>{},configure(){},configureHelp(){},
 preload(){window.diag.asrPreloads++},cancel(){window.recording=false},
 async record(){window.recording=true},async stop(){window.recording=false;return {text:'zebra',audio:new Float32Array(16000)}}};`;

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
  await page.addInitScript(({tablet})=>{
   window.diag={jsonCalls:0,llmLoads:0,generations:0,voiceLoads:0,voiceCalls:0,asrPreloads:0};
   if(tablet){Object.defineProperty(navigator,'maxTouchPoints',{value:5});Object.defineProperty(navigator,'platform',{value:'MacIntel'});}
  },{tablet:profile.tablet});
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
   const rel=url.pathname.slice(1)||'index.html';
   if(rel==='seed.html')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated fixture</title>'});
   if(rel==='version.json')return route.fulfill({status:404,body:'{}',contentType:'application/json'});
   if(rel==='packs.json')return route.fulfill({contentType:'application/json',body:JSON.stringify(catalog)});
   if(rel==='vendor/wllama/index.js')return route.fulfill({contentType:'text/javascript',body:cpu});
   if(rel==='kokoro/neural-tts.js')return route.fulfill({contentType:'text/javascript',body:voice});
   if(rel==='js/voice-input.js')return route.fulfill({contentType:'text/javascript',body:microphone});
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
  async function record(){await page.locator('#accent .mic-btn').click();await page.waitForFunction(()=>recording);await page.locator('#accent .mic-btn').click();await page.locator('#accent .score').waitFor();}
  async function idleModels(){assert.deepEqual(await page.evaluate(()=>diag),{jsonCalls:0,llmLoads:0,generations:0,voiceLoads:0,voiceCalls:0,asrPreloads:0});}
  return{context,page,errors,record,idleModels};
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
   await page.locator('#accent .sum-head .back').click();await page.click('#drill-start');await page.locator('#accent .drill-text:not(.para)').waitFor();
   assert.equal(await page.locator('#accent .speak').count(),2);assert.equal(await page.locator('#accent .mic-btn').count(),1);
   await f.idleModels();assert.deepEqual(f.errors,[]);await f.context.close();
   passed.push(`${profile.name}: installed LLM/ASR/voice; roll/new passage/drill/missed-word results use zero LLM or voice initialization, even in desktop layout`);
  }
  {
   const f=await fixture({name:'desktop',mobile:false}),{page}=f;
   await page.evaluate(async()=>{(await import('./js/device.js')).setLayoutMode('phone')});
   await page.click('#check-start');await page.locator('#accent .drill-text.para').waitFor();
   await f.record();await page.waitForFunction(()=>diag.jsonCalls===2);
   await page.locator('#accent .sum-head .back').click();await page.click('#drill-start');await page.waitForFunction(()=>diag.jsonCalls===3);
   await f.record();await page.waitForFunction(()=>diag.jsonCalls===4);
   assert.equal(await page.evaluate(()=>diag.llmLoads),1);assert.deepEqual(f.errors,[]);await f.context.close();
   passed.push('desktop keeps all four existing generation paths; phone layout does not change device capability');
  }
  console.log(JSON.stringify({passed},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
