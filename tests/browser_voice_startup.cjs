// Real DOM and decoded recordings; a controllable worker adapter tests slow UI.
// Mobile UA in Chromium checks routing/layout, not physical iOS performance.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app'), origin = 'https://voice.test';
const slowVoice = `let listener=()=>{};export const configure=()=>{};
export const onStatus=fn=>{listener=fn};export const synthesize=(text,{signal}={})=>new Promise((resolve,reject)=>{
  window.voiceSignals.push(signal);listener({state:'loading'});
  const timer=setTimeout(()=>listener({state:'ready'}),1500);
  signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('cancelled'))},{once:true});
});`;
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.ASOUND_BROWSER||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined)});
 const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,locale:'zh-CN',
  userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'});
 const page=await context.newPage(),requests=[],errors=[];
 page.setDefaultTimeout(15000);
 page.on('request',r=>requests.push(r.url()));page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.voiceSignals=[];window.utterances=[];
  Object.defineProperty(window,'SpeechSynthesisUtterance',{value:class {constructor(text){this.text=text}}});
  Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>[{lang:'en-US',name:'Test English'}],addEventListener(){},cancel(){},
   speak(u){window.utterances.push(u.text);u.onstart?.();if(u.text.trim())setTimeout(()=>u.onend?.(),100);}}});
 });
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
  const rel=url.pathname.slice(1)||'index.html';
  if(rel==='version.json'||rel.startsWith('api/'))return route.fulfill({status:404,body:'{}'});
  if(rel==='kokoro/neural-tts.js')return route.fulfill({contentType:'text/javascript',body:slowVoice});
  try{await route.fulfill({body:await fs.readFile(path.join(app,rel)),contentType:rel.endsWith('.js')?'text/javascript':rel.endsWith('.json')?'application/json':rel.endsWith('.css')?'text/css':rel.endsWith('.html')?'text/html':rel.endsWith('.wav')?'audio/wav':'application/octet-stream'});}
  catch{await route.fulfill({status:404,body:''});}
 });
 try{
  await page.goto(origin+'/?web#me');await page.locator('#settings-open').waitFor();
  await page.evaluate(async()=>{
   await (await import('./js/engines.js')).enginesApplied;
   (await import('./js/state.js')).prefs.voiceEngine='standard';
   (await import('./js/speech.js')).configureVoice({mode:'web',base:origin+'/',canon:origin+'/',cache:'test-voices'});
  });
  await page.click('#settings-open');
  await page.locator('#voice-options details').filter({has:page.locator('.voice-grid')}).locator('summary').click();
  assert.equal(await page.locator('.voice-grid .speak').count(),16);
  for(let i=0;i<16;i++){
   await page.locator('.voice-grid .speak').nth(i).click();
   await page.waitForFunction(async()=>{const s=(await import('./js/speech.js')).speechStatus();return s.engine==='preview'&&s.phase==='playing'});
   await page.evaluate(async()=>{(await import('./js/speech.js')).stopSpeaking()});
  }
  assert.equal(new Set(requests.filter(url=>url.includes('/audio/voices/'))).size,16);
  assert.equal(requests.filter(url=>/kokoro\/neural|\.onnx|\.wasm|voices\/.*\.bin/.test(url)).length,0);
  console.log('16 recorded previews passed without model requests');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.evaluate(async()=>{(await import('./js/speech.js')).speak('This is a new lesson sentence.')});
  await page.locator('.speech-notice').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('.speech-notice').textContent.includes('正在生成语音'));
  console.log('slow speech waiting feedback visible');
  await page.getByRole('button',{name:'先用基础朗读',exact:true}).click({timeout:12000});
  await page.waitForFunction(()=>window.utterances.includes('This is a new lesson sentence.'));
  assert.equal(await page.evaluate(()=>voiceSignals[0].aborted),true);
  assert.equal(await page.evaluate(async()=>(await import('./js/state.js')).prefs.voiceEngine),'standard');
  await page.locator('.speech-notice').waitFor({state:'hidden'});
  await page.evaluate(async()=>{(await import('./js/speech.js')).speak('Stop this request.')});
  await page.locator('.speech-notice').waitFor({state:'visible'});
  await page.locator('.speech-notice').getByRole('button',{name:'停止',exact:true}).click();
  assert.equal(await page.evaluate(()=>voiceSignals.at(-1).aborted),true);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({previews:16,modelLoadsForPreviews:0,slowSpeechStages:true,basicFallback:true,stop:true,errors}));
 }catch(error){
  console.error(await page.evaluate(async()=>({status:(await import('./js/speech.js')).speechStatus(),notice:document.querySelector('.speech-notice')?.textContent,lang:document.documentElement.lang})).catch(()=>({})));
  throw error;
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
