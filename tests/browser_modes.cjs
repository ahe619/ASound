// No-model browser smoke checks. All requests are fulfilled from local files or stubs.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const app = path.resolve(__dirname, '../app');
const speech = `
export const VOICES=[]; export const recommendVoices=()=>[]; export const voiceById=()=>({});
export const voicePreviewBtn=()=>document.createElement('button');
export const speak=()=>{}; export const isSpeaking=()=>false; export const unlockAudio=()=>{};
export const stopSpeaking=()=>{window.stops++}; export const paintSpeak=()=>{};
let ctx; export const audioContext=()=>ctx ||= new AudioContext();
export const renderSpeech=async()=>audioContext().createBuffer(1, 2400, 24000);
export const speakBtn=(text,label)=>{const b=document.createElement('button'); b.textContent=label||text; return b;};
`;
const ai = `
export const askJSON=(input,opts={})=>new Promise((resolve,reject)=>window.pending.push({resolve,reject,signal:opts.signal}));
export const ask=askJSON; export const aiErrorText=()=> 'Test failure'; export const aiStatus=()=>({state:'ready'});
`;
const harness = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="css/app.css"></head><body>
<nav>${['talk','accent','vocab','me'].map(x=>`<button id="tab-${x}">${x}</button>`).join('')}</nav>
${['talk-home','chat','summary','accent','vocab','me','models','mode'].map(x=>`<main class="view" id="view-${x}"><div class="wrap stack" id="${x==='talk-home'?'talk-home':x}"></div></main>`).join('')}
<div id="toast" hidden></div>
<script type="module">
import {setLanguage,t} from './js/i18n.js';
import {initModes,modeCards} from './js/modes.js';
import {registerTab,setTab,show} from './js/nav.js';
await Promise.all([setLanguage('en'),initModes()]);
const paint=(id)=>document.getElementById(id==='talk'?'talk-home':id).replaceChildren(modeCards(id));
for (const id of ['talk','accent','vocab','me']) { registerTab(id,()=>{if(id==='talk'||id==='accent')paint(id)}); document.getElementById('tab-'+id).onclick=()=>setTab(id); }
paint('talk');show(); window.harness={setLanguage,setTab,paint,t};
</script></body></html>`;

(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.ASOUND_BROWSER || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined),args:['--mute-audio']});
 const page=await browser.newPage({viewport:{width:1100,height:900}});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 let holdRetell=null;
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());
  assert.equal(u.hostname,'asound.test','Unexpected network request');
  const rel=decodeURIComponent(u.pathname).replace(/^\//,'');
  if(rel==='') return route.fulfill({contentType:'text/html',body:harness});
  if(rel==='js/speech.js') return route.fulfill({contentType:'text/javascript',body:speech});
  if(rel==='js/ai.js') return route.fulfill({contentType:'text/javascript',body:ai});
  if(rel==='js/engines.js') return route.fulfill({contentType:'text/javascript',body:'export const enginesApplied=Promise.resolve();'});
  if(rel==='js/packs.js') return route.fulfill({contentType:'text/javascript',body:'export const activePacks=()=>({llm:"llm-cpu",asr:"asr-tiny"});'});
  if(rel==='js/feat-retell.js' && holdRetell) await holdRetell;
  try { const body=await fs.readFile(path.join(app,rel)); await route.fulfill({body,contentType:rel.endsWith('.js')?'text/javascript':rel.endsWith('.json')?'application/json':rel.endsWith('.css')?'text/css':'application/octet-stream'}); }
  catch { await route.fulfill({status:404,body:'Missing test resource'}); }
 });
 await page.addInitScript(()=>{
  window.pending=[];window.stops=0;window.cancels=0;window.recording=false;window.claude={};
  window.ASoundMic={supported:true,RATE:16000,preload(){},cancel(){window.cancels++;window.recording=false},pause(){},resume(){},
   async record(){window.recording=true},async stop(){window.recording=false;return {text:'Test recording',audio:new Float32Array(16000)}},async transcribe(){return 'Test recording'}};
  const st=window.setTimeout.bind(window),ct=window.clearTimeout.bind(window),si=window.setInterval.bind(window),ci=window.clearInterval.bind(window);
  window.testTimeouts=new Map();window.testIntervals=new Map();
  window.setTimeout=(fn,ms,...args)=>{const id=st(()=>{testTimeouts.delete(id);fn(...args)},ms);testTimeouts.set(id,ms);return id};
  window.clearTimeout=(id)=>{testTimeouts.delete(id);ct(id)};
  window.setInterval=(fn,ms,...args)=>{const id=si(fn,ms,...args);testIntervals.set(id,ms);return id};
  window.clearInterval=(id)=>{testIntervals.delete(id);ci(id)};
 });
 try {
  await page.goto('http://asound.test/'); await page.waitForFunction(()=>!!window.harness);
  assert.equal(await page.locator('#talk-home .mode-card').count(),2);
  assert.match(await page.locator('#talk-home').innerText(),/Shrinking Retell.*Phone Line/s);
  await page.click('#tab-accent');assert.equal(await page.locator('#accent .mode-card').count(),1);
  await page.evaluate(async()=>{await harness.setLanguage('zh');harness.paint('accent')});
  assert.match(await page.locator('#accent').innerText(),/弱读阶梯/);
  await page.evaluate(async()=>{await harness.setLanguage('en');harness.paint('accent')});
  // The host must ignore a lazy import that finishes after the user has left.
  let release;holdRetell=new Promise(r=>release=r);
  await page.click('#tab-talk');await page.locator('#talk-home .mode-card').first().click();
  await page.click('#tab-vocab');release();holdRetell=null;
  await page.waitForTimeout(100);assert.equal(await page.locator('#mode').innerText(),'');
  // A delayed model answer cannot resurrect an exited retell or replace a new mount.
  await page.click('#tab-talk');await page.locator('#talk-home .mode-card').first().click();
  await page.locator('#mode .rt-choice').first().click();
  await page.waitForFunction(()=>pending.length===1);await page.click('#tab-vocab');
  assert.equal(await page.evaluate(()=>pending[0].signal.aborted),true);
  await page.click('#tab-talk');await page.locator('#talk-home .mode-card').first().click();
  await page.waitForSelector('#mode .rt-choice');
  await page.evaluate(()=>pending.shift().resolve({title:'STALE STORY',text:'Old content',points:['one','two','three']}));
  await page.waitForTimeout(50);assert.equal(await page.locator('#mode .rt-choice').count(),2);
  // Timed recording is stopped when a primary tab is selected.
  await page.locator('#mode .rt-choice').nth(1).click();await page.locator('#mode .rt-topics .opt').first().click();
  await page.locator('#mode .actions .btn.primary').click();await page.locator('#mode .btn.hot').click();
  assert.equal(await page.evaluate(()=>recording),true);await page.click('#tab-me');
  assert.equal(await page.evaluate(()=>recording),false);assert.equal(await page.evaluate(()=>[...testIntervals.values()].includes(100)),false);
  // Incoming and outgoing calls dispose their clock and pending transitions.
  for(const scen of ['delivery','pharmacy']) {
   await page.click('#tab-talk');await page.locator('#talk-home .mode-card').nth(1).click();
   await page.locator('#mode [data-scen="'+scen+'"]').click();await page.click('#ph-start');
   await page.click('#tab-me');
   assert.equal(await page.evaluate(()=>[...testIntervals.values()].includes(1000)),false);
   assert.equal(await page.evaluate(()=>[...testTimeouts.values()].some(ms=>[1800,5200,900,1100].includes(ms))),false);
  }
  // Ladder uses its stylesheet, and a late AI answer cannot update an exited mode.
  await page.click('#tab-accent');await page.locator('#accent .mode-card').click();
  await page.waitForSelector('#ladder-start');
  assert.equal(await page.evaluate(()=>[...document.styleSheets].some(s=>s.href?.endsWith('/css/feat/ladder.css'))),true);
  await page.locator('#mode .seg button').nth(1).click();await page.click('#ladder-start');
  await page.waitForFunction(()=>pending.length===1);await page.click('#tab-talk');
  assert.equal(await page.evaluate(()=>pending[0].signal.aborted),true);
  await page.evaluate(()=>pending.shift().resolve({sentences:[{text:'I want to go home.',meaning:'test'}]}));
  await page.waitForTimeout(50);assert.equal(await page.locator('#mode').innerText(),'');
  // A mode's own back button follows the same cleanup path.
  await page.click('#tab-accent');await page.locator('#accent .mode-card').click();
  await page.locator('#mode .back').click();assert.equal(await page.locator('#view-accent').isVisible(),true);
  await page.locator('#accent .mode-card').click();await page.waitForSelector('#ladder-start');
  const beforeRestore=await page.evaluate(()=>({length:history.length,href:location.href}));
  await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  assert.equal(await page.locator('#view-mode').isVisible(),true);assert.equal(await page.locator('#mode').innerText(),'');
  await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await page.waitForSelector('#ladder-start');
  assert.deepEqual(await page.evaluate(()=>({length:history.length,href:location.href})),beforeRestore);
  assert.deepEqual(errors,[]);
  console.log('PASS: mode cards, en/zh strings, CSS, lazy-load cancellation, retell model/recording cancellation, phone timer teardown, ladder cancellation, back navigation; no browser errors.');
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
