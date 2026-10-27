// Real app/word-study/microphone controls with isolated storage and a deterministic recognition provider.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app');
const base = 'https://asound.review.test/';
const fakeMic = `window.recording=false;window.cancelCount=0;
window.ASoundMic={supported:true,RATE:16000,hasModel:()=>true,hasNative:()=>false,
 status:()=>({asr:'ready',mic:window.recording?'recording':'off'}),onStatus:()=>()=>{},configure(){},configureHelp(){},
 cancel(){window.cancelCount++;window.recording=false;window.captureHandlers?.onCancel?.()},
 async record(h){window.captureHandlers=h;window.recording=true},
 async stop(){window.recording=false;const result={text:window.testHeard,audio:new Float32Array(16000).fill(.2)};
  return window.holdTranscript?new Promise(resolve=>{window.resolveTranscript=()=>resolve(result)}):result}};`;

(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.ASOUND_BROWSER||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined)});
 const report=[];
 async function fixture(id,heard=''){
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.addInitScript(({id,heard})=>{
   if(!localStorage.getItem('asound.wordstudy.v1')){
    const options={deck:'cet4',topic:'',scenario:'',size:10,practice:'say'};
    localStorage.setItem('asound.wordstudy.v1',JSON.stringify({options,progress:{},session:{ids:[id],index:0,options,mode:'random',revealed:false,ratings:[],attempt:null,draft:'',choices:[]}}));
   }
   window.testHeard=heard;window.idleJobs=[];window.prefetchCalls=[];
   window.requestIdleCallback=fn=>{idleJobs.push(fn);return idleJobs.length};
  },{id,heard});
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==new URL(base).origin)return route.abort();
   const rel=url.pathname.slice(1)||'index.html';
   if(rel==='js/voice-input.js')return route.fulfill({contentType:'text/javascript',body:fakeMic});
   try{
    let body=await fs.readFile(path.join(app,rel));
    if(rel==='js/speech.js')body=body.toString().replace('export function prefetchSpeech(', 'export function unusedPrefetchSpeech(')
      +'\nexport const prefetchSpeech = text => window.prefetchCalls.push(text);\n';
    await route.fulfill({body,contentType:rel.endsWith('.js')?'text/javascript':rel.endsWith('.json')?'application/json':rel.endsWith('.css')?'text/css':rel.endsWith('.html')?'text/html':'application/octet-stream'});
   }catch{await route.fulfill({status:404,body:'{}',contentType:'application/json'});}
  });
  await page.goto(base+'?web&nogpu#vocab/practice');await page.locator('.ws-say').waitFor();
  return {context,page,errors,read:()=>page.evaluate(()=>JSON.parse(localStorage.getItem('asound.wordstudy.v1')))};
 }
 try{
  for(const [target,alternative] of [['clothes','clothing'],['color','colour']]){
   const f=await fixture(target,`I think it is ${alternative}.`),{page}=f;
   assert.match(await page.locator('#ws-say-target').innerText(),/首字母 c/);
   assert.equal(await page.locator('.ws-illustration figcaption').count(),0,'picture cue has no answer caption');
   if(target==='color'){
    await page.locator('.ws-say .mic-btn').click();await page.locator('.ws-say .mic-btn').click();
   }else{
    await page.locator('#ws-say-input').fill(`I think it is ${alternative}.`);await page.locator('#ws-say-input').press('Enter');
   }
   await page.locator('.ws-say .note-card:not([hidden])').waitFor();
   assert.equal((await f.read()).session.attempt,null);assert.equal((await f.read()).progress[target],undefined);
   await page.reload();await page.locator('.ws-say .note-card:not([hidden])').waitFor();
   assert.equal(await page.locator('#ws-say-input').inputValue(),`I think it is ${alternative}.`);
   await page.locator('#ws-say-input').fill(target);
   await page.locator('.ws-say-type').evaluate(form=>{form.requestSubmit();form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});
   await page.locator('#ws-feedback').waitFor();assert.equal((await f.read()).progress[target].answers,1);
   assert.equal((await f.read()).progress[target].correctAnswers,1);
   assert.deepEqual(f.errors,[]);await f.context.close();report.push(`${target}/${alternative}: alternative unscored, draft restores, target scores once`);
  }
  {
   const heard='I can see a bridge over the river and people who are enjoying a walk in the park. '.repeat(5);
   const f=await fixture('bridge',heard),{page}=f;
   await page.locator('.ws-say .mic-btn').click();await page.locator('.ws-say .mic-btn').click();await page.locator('#ws-feedback').waitFor();
   assert.equal((await f.read()).session.attempt.response,heard);
   await page.reload();await page.locator('#ws-feedback').waitFor();assert.equal((await f.read()).progress.bridge.answers,1);
   await page.locator('#ws-next').click();await page.locator('#ws-finished').waitFor();
   await page.reload();await page.locator('#ws-finished').waitFor();
   assert.equal((await f.read()).session.ratings[0].response,heard);
   assert.deepEqual(await page.locator('.ws-results strong').allTextContents(),['1','0','100%']);
   assert.deepEqual(f.errors,[]);await f.context.close();report.push('410-character microphone answer: feedback and completed statistics survive reload without regrading');
  }
  {
   const f=await fixture('bridge','bridge '.repeat(300)),{page}=f;
   await page.locator('.ws-say .mic-btn').click();await page.locator('.ws-say .mic-btn').click();
   await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('内容太长'));
   assert.equal((await f.read()).session.attempt,null);assert.equal((await f.read()).progress.bridge,undefined);
   await f.context.close();report.push('over-limit recognition: explicit retry without scoring or truncating the answer');
  }
  {
   const f=await fixture('bridge','bridge'),{page}=f;
   await page.evaluate(()=>{for(const fn of idleJobs)fn({didTimeout:false,timeRemaining:()=>50})});
   assert.deepEqual(await page.evaluate(()=>prefetchCalls),['bridge'],'current card may prefetch normally');
   await page.evaluate(()=>{prefetchCalls=[]});
   await page.locator('.ws-say .mic-btn').click();assert.equal(await page.evaluate(()=>recording),true);
   assert.ok(await page.evaluate(()=>idleJobs.length>0));
   await page.locator('.ws-study-head button').click();await page.locator('#ws-practice-say').waitFor();
   assert.equal(await page.evaluate(()=>recording),false);assert.ok(await page.evaluate(()=>cancelCount>0));
   await page.evaluate(()=>{for(const fn of idleJobs.splice(0))fn({didTimeout:false,timeRemaining:()=>50})});
   assert.deepEqual(await page.evaluate(()=>prefetchCalls),[],'old card idle callbacks cannot prefetch after leaving practice');
   assert.deepEqual(f.errors,[]);await f.context.close();report.push('same-tab back cancels owned recording; late idle callbacks do not prefetch');
  }
  {
   const f=await fixture('bridge','bridge'),{page}=f;
   await page.evaluate(()=>{window.holdTranscript=true});
   await page.locator('.ws-say .mic-btn').click();await page.locator('.ws-say .mic-btn').click();
   await page.waitForFunction(()=>typeof resolveTranscript==='function');
   await page.locator('.ws-study-head button').click();await page.locator('#ws-practice-say').waitFor();
   await page.evaluate(async()=>{resolveTranscript();await new Promise(resolve=>setTimeout(resolve,0))});
   assert.equal((await f.read()).session.attempt,null);assert.equal((await f.read()).progress.bridge,undefined);
   assert.equal(await page.locator('#ws-feedback').count(),0);assert.deepEqual(f.errors,[]);
   await f.context.close();report.push('a transcript arriving after same-tab return cannot score or reopen the departed card');
  }
  {
   const f=await fixture('bridge','bridge'),{page}=f;
   await page.locator('.ws-say .mic-btn').click();
   await page.evaluate(async()=>{const {micButton}=await import('./js/mic.js');window.foreignMic=micButton({label:'Other recorder'});document.body.append(foreignMic);foreignMic.click()});
   await page.waitForFunction(()=>foreignMic.classList.contains('rec'));
   const before=await page.evaluate(()=>cancelCount);
   await page.locator('.ws-study-head button').click();await page.locator('#ws-practice-say').waitFor();
   assert.equal(await page.evaluate(()=>recording),true);assert.equal(await page.evaluate(()=>cancelCount),before,'old study cleanup never cancels another button');
   await page.evaluate(async()=>{const {cancelMicButton}=await import('./js/mic.js');cancelMicButton(foreignMic)});
   assert.deepEqual(f.errors,[]);await f.context.close();report.push('leaving the study card does not cancel a newer recorder owned elsewhere');
  }
  console.log(JSON.stringify({passed:report},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
