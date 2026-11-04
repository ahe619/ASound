const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const app=path.resolve(__dirname,'../app');
const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2'};
const server=http.createServer((req,res)=>{
 const file=path.resolve(app,new URL(req.url,'http://localhost').pathname.slice(1)||'index.html');
 if(!file.startsWith(app+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return res.writeHead(404).end('{}');
 res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});fs.createReadStream(file).pipe(res);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/`;
 const browser=await chromium.launch({headless:true,executablePath:process.env.ASOUND_BROWSER||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined)});
 try{
 const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN',hasTouch:true});
 await context.addInitScript(()=>{
  window.utterances=[];
  Object.defineProperty(window,'SpeechSynthesisUtterance',{value:class{constructor(text){this.text=text;}}});
  Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>[{lang:'en-US',name:'Test English'}],addEventListener(){},cancel(){},speak(u){window.utterances.push({text:u.text,rate:u.rate});u.onstart?.();setTimeout(()=>u.onend?.(),50);}}});
 });
 await context.route('**/*',route=>{
  const url=route.request().url();if(!url.startsWith(base))return route.abort();
  const rel=new URL(url).pathname.slice(1);
  if(rel==='js/ai.js'||rel==='js/packs.js'){
   let source=fs.readFileSync(path.join(app,rel),'utf8');
   source=source.replace('export async function ask(input, opts = {}) {','export async function ask(input, opts = {}) { if(window.testTranslate) return window.testTranslate(input,opts);');
   source=source.replace('export function activePacks() {','export function activePacks() { if(window.testModel) return {llm:"llm-cpu"};');
   return route.fulfill({contentType:'text/javascript',body:source});
  }
  return route.continue();
 });
 const page=await context.newPage(),errors=[],requests=[];page.setDefaultTimeout(15000);
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
 await page.goto(base+'?web&nogpu#translate');await page.locator('#lookup-input').waitFor();
 assert.equal(await page.locator('#tab-translate').getAttribute('aria-selected'),'true');
 assert.equal(requests.filter(url=>url.includes('/dictionary/shards/')).length,0,'opening the page does not load dictionary shards');
 await page.locator('#lookup-input').fill('electroencephalography');await page.locator('#lookup-input').press('Enter');
 await page.locator('.lookup-word').first().waitFor();assert.match(await page.locator('.lookup-word').first().innerText(),/electroencephalography/);
 assert.equal(new Set(requests.filter(url=>url.includes('/dictionary/shards/'))).size,1);
 await page.evaluate(async()=>{(await import('./js/state.js')).prefs.voiceEngine='system';});
 await page.getByRole('button',{name:'听读音',exact:true}).first().click();
 await page.waitForFunction(()=>window.utterances.some(u=>u.text==='electroencephalography'));
 await page.waitForFunction(async()=>(await import('./js/speech.js')).speechStatus().phase==='idle');
 await page.getByRole('button',{name:'慢速听',exact:true}).first().click();
 await page.waitForFunction(()=>window.utterances.filter(u=>u.text==='electroencephalography').length===2);
 const spoken=await page.evaluate(()=>window.utterances.filter(u=>u.text==='electroencephalography'));assert.ok(spoken[1].rate<spoken[0].rate);
 await page.locator('#lookup-input').fill('recieve');await page.locator('#lookup-input').press('Enter');await page.getByRole('button',{name:'receive',exact:true}).waitFor();
 await page.getByRole('button',{name:'receive',exact:true}).click();await page.locator('.lookup-word').first().waitFor();
 for(const width of [320,390,768,1280]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 await page.setViewportSize({width:390,height:844});
 fs.mkdirSync(path.resolve(__dirname,'../build/translation'),{recursive:true});await page.screenshot({path:path.resolve(__dirname,'../build/translation/phone.png')});
 await page.locator('#lookup-mode-sentence').click();await page.locator('#lookup-input').fill('Good morning.');await page.getByRole('button',{name:'翻译',exact:true}).click();
 await page.getByRole('button',{name:'打开模型',exact:true}).waitFor();
 await page.getByRole('button',{name:'打开模型',exact:true}).click();await page.locator('#download-route-original').waitFor();await page.goBack();await page.locator('#lookup-input').waitFor();
 await page.evaluate(()=>{window.testModel=true;window.testTranslate=(input,opts)=>new Promise(resolve=>{window.oldTranslation={input,opts,resolve};});});
 await page.getByRole('button',{name:'翻译',exact:true}).click();await page.waitForFunction(()=>!!window.oldTranslation);
 await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.locator('#lookup-input').inputValue(),'Good morning.');
 assert.equal(await page.evaluate(()=>window.oldTranslation.opts.signal.aborted),true);
 await page.evaluate(()=>{window.testTranslate=async(input)=>{window.translationPrompt=input;return '早上好。';};});
 await page.getByRole('button',{name:'翻译',exact:true}).click();await page.getByText('早上好。',{exact:true}).waitFor();
 await page.evaluate(()=>window.oldTranslation.resolve('STALE OUTPUT'));assert.equal(await page.getByText('STALE OUTPUT',{exact:true}).count(),0);
 assert.match(await page.evaluate(()=>window.translationPrompt[0].content),/Simplified Chinese/);
 await page.locator('#tab-vocab').click();await page.locator('#ws-practice-cards').waitFor();await page.goBack();await page.locator('#lookup-input').waitFor();
 assert.equal(await page.locator('#lookup-input').inputValue(),'Good morning.');
 await page.reload();await page.locator('#lookup-input').waitFor();
 assert.equal(await page.locator('#lookup-mode-sentence').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('#lookup-input').inputValue(),'Good morning.');
 assert.deepEqual(errors,[]);assert.ok(requests.every(url=>url.startsWith(base)));assert.ok(requests.every(url=>!/\.(onnx|gguf)/.test(url)));
 console.log(JSON.stringify({largeDictionary:true,pronunciationAndSlow:true,suggestions:true,phoneKeyboard:true,translationGate:true,cancellation:true,back:true,errors}));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
