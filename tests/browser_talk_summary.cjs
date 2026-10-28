// Actual app/navigation/storage; only model I/O is deferred. Each case has isolated browser storage.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app');
const origin = 'https://asound.review.test';
const model = `export const ask=async()=> 'Tell me more.';
export const askJSON=(prompt,opts={})=>new Promise((resolve,reject)=>{(window.pendingJSON||=[]).push({prompt,signal:opts.signal,resolve,reject});});
export const aiStatus=()=>({state:'ready'});export const aiErrorText=e=>String(e?.code||'error');`;
const correction = { ok:false, corrected:'I went home.', issues:[{wrong:'goed',right:'went',explain:'past tense'}] };
const summary = { overall:'A useful practice session.', strengths:[],focus:[],expressions:[] };

(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.ASOUND_BROWSER||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined)});
 const passed=[];
 async function fixture(){
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==origin)return route.abort();
   const rel=url.pathname.slice(1)||'index.html';
   if(rel==='js/ai.js')return route.fulfill({contentType:'text/javascript',body:model});
   try{
    const body=await fs.readFile(path.join(app,rel));
    await route.fulfill({body,contentType:rel.endsWith('.js')?'text/javascript':rel.endsWith('.html')?'text/html':rel.endsWith('.css')?'text/css':rel.endsWith('.json')?'application/json':'application/octet-stream'});
   }catch{await route.fulfill({status:404,body:'{}',contentType:'application/json'});}
  });
  await page.goto(origin+'/?web&nogpu#talk');await page.locator('#start-btn').waitFor();
  await page.evaluate(async()=>{const {prefs}=await import('./js/state.js');prefs.scenario='chat';prefs.autoplay=false;});
  await page.click('#start-btn');await page.locator('#view-chat:not([hidden])').waitFor();await page.click('#mode-type');
  async function send(text){await page.locator('#composer-input').fill(text);await page.click('#send-btn');await page.waitForFunction(()=>!document.querySelector('#send-btn').disabled);}
  async function end(){await page.click('#end-open');await page.click('#end-confirm');await page.locator('#view-summary:not([hidden])').waitFor();}
  const resolve=(index,value)=>page.evaluate(({index,value})=>pendingJSON[index].resolve(value),{index,value});
  const state=()=>page.evaluate(async()=>{const {state}=await import('./js/state.js');return{sessionId:state.session?.id||null,summaryActive:!!state.summaryOf,view:state.talkView,live:JSON.parse(localStorage.getItem('asound.live.v1')),archive:JSON.parse(localStorage.getItem('asound.sessions.v1'))||[],requests:pendingJSON.length};});
  await send('I goed home.');await page.waitForFunction(()=>pendingJSON.length===1);
  return{context,page,errors,send,end,resolve,state};
 }
 try{
  for(const destination of ['back','tab']){
   const f=await fixture(),{page}=f;
   const original=(await f.state()).sessionId;
   await f.end();
   if(destination==='back'){await page.goBack();await page.locator('#view-chat:not([hidden])').waitFor();}
   else {await page.click('#tab-accent');await page.locator('#view-accent:not([hidden])').waitFor();}
   await f.resolve(0,correction);
   await page.waitForFunction(()=>JSON.parse(localStorage.getItem('asound.live.v1')).turns[1].fb?.ok===false);
   assert.equal((await f.state()).requests,1,'leaving the feedback wait must not start a summary');
   assert.equal((await f.state()).summaryActive,false);assert.equal((await f.state()).sessionId,original);
   if(destination==='back'){
    await f.send('I am continuing after Back.');
    assert.ok((await f.state()).live.turns.some(x=>x.text==='I am continuing after Back.'));
    await page.goForward();await page.locator('#view-summary:not([hidden])').waitFor();
    assert.equal(await page.locator('#summary .loading-card').count(),0,'Forward never shows an abandoned spinner');
    assert.equal((await f.state()).sessionId,original);
   }
   assert.deepEqual(f.errors,[]);await f.context.close();passed.push(`${destination}: leaving the pending correction invalidates summary work and preserves the live conversation`);
  }
  {
   const f=await fixture(),{page}=f;
   const original=(await f.state()).sessionId;
   await f.resolve(0,correction);await page.locator('#thread .fb-fix').waitFor();
   await f.end();await page.waitForFunction(()=>pendingJSON.length===2);
   await page.goBack();await page.locator('#view-chat:not([hidden])').waitFor();
   assert.equal(await page.evaluate(()=>pendingJSON[1].signal.aborted),true);
   await f.send('Keep my new line after Back.');
   await f.resolve(1,summary); // emulate a provider that still delivers after cancellation
   await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
   const current=await f.state();
   assert.equal(current.sessionId,original);assert.equal(current.archive.length,0);
   assert.ok(current.live.turns.some(x=>x.text==='Keep my new line after Back.'));
   assert.deepEqual(f.errors,[]);await f.context.close();passed.push('late summary after system Back cannot clear or archive a resumed conversation');
  }
  {
   const f=await fixture(),{page}=f;
   await page.evaluate(()=>pendingJSON[0].reject({code:'unavailable'}));await page.locator('#thread .fb.failed button').waitFor();
   await page.locator('#thread .fb.failed button').click();await page.waitForFunction(()=>pendingJSON.length===2);
   await f.end();assert.equal((await f.state()).requests,2,'End waits for the actual Retry handler');
   await f.resolve(1,correction);await page.waitForFunction(()=>pendingJSON.length===3);
   await f.resolve(2,summary);await page.waitForFunction(()=>localStorage.getItem('asound.live.v1')===null);
   const archived=(await f.state()).archive[0];
   assert.equal(archived.fixes,1);assert.equal(archived.turns[1].fb.corrected,'I went home.');
   assert.equal(JSON.stringify(archived).includes('_fbP'),false);
   assert.match(await page.locator('#summary').innerText(),/A useful practice session/);
   await page.locator('#summary .sum-head button').click();await page.locator('#talk-history > summary').click();await page.locator('#talk-home .hist').click();
   await page.locator('#view-summary:not([hidden])').waitFor();
   assert.match(await page.locator('#summary').innerText(),/A useful practice session/);
   assert.equal((await f.state()).requests,3,'opening an archived summary does not re-run inference');
   await page.goBack();await page.goForward();await page.locator('#view-summary:not([hidden])').waitFor();
   assert.match(await page.locator('#summary').innerText(),/A useful practice session/);
   assert.deepEqual(f.errors,[]);await f.context.close();passed.push('retry result reaches saved summary; completed summary and archived history survive Back/Forward');
  }
  console.log(JSON.stringify({passed},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
