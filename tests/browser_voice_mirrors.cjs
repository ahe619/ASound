// Real cross-origin HTTP/CORS, Service Worker, CacheStorage and ES module imports.
// Only tiny fixed fixtures are transferred; no real models are downloaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app'), version = 'mirror-browser-test';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const runtimes = ['kokoro/neural-tts.js', 'kokoro/kokoro.web.js', 'kokoro/lexicon-us.json',
  'kokoro/ort-cpu/ort-wasm-simd-threaded.mjs', 'kokoro/ort-cpu/ort-wasm-simd-threaded.wasm'];
const wasm = runtimes[4], preview = 'audio/voices/af_heart.wav';
const files = new Map([
  ['index.html', '<!doctype html><title>Voice mirror check</title>'],
  [runtimes[0], "import { value, childURL } from './kokoro.web.js'; export {value,childURL}; export const moduleURL=import.meta.url;"],
  [runtimes[1], "export const value='verified';export const childURL=import.meta.url;"],
  [runtimes[2], '{"verified":true}'], [runtimes[3], 'export const runtime=true;'],
  [wasm, 'verified wasm fixture '.repeat(500)], [preview, 'verified audio fixture'],
  ['js/state.js', 'export const prefs={source:"hf"};export const savePrefs=()=>{};'],
  ['js/device.js', 'export const deviceInfo=()=>({mobile:true});'],
  ['version.json', JSON.stringify({version})],
]);
for (const file of ['js/packs.js', 'js/model-download.js']) files.set(file, fs.readFileSync(path.join(app, file)));
const modelVersion = '0123456789abcdef', repository = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const modelFiles = [{path:'config.json',body:'{"fixture":true}'},{path:'onnx/model_quantized.onnx',body:'tiny verified model'}]
  .map(file => ({...file, repo:repository,size:Buffer.byteLength(file.body),sha256:hash(file.body)}));
for (const file of modelFiles) files.set(`voice-models/${modelVersion}/${repository}/resolve/main/${file.path}`, file.body);
const modelURLs = modelFiles.map(file => `voice-models/${modelVersion}/${repository}/resolve/main/${file.path}`);
const mime = name => name.endsWith('.js')||name.endsWith('.mjs')?'text/javascript':name.endsWith('.json')?'application/json'
  :name.endsWith('.wasm')?'application/wasm':name.endsWith('.wav')?'audio/wav':name.endsWith('.html')?'text/html':'application/octet-stream';
const requests = [], errors = [];
let base, mirrorBase, sw, slow = true, slowStarted, slowClosed;
const beganSlow = new Promise(resolve => {slowStarted=resolve});
const closedSlow = new Promise(resolve => {slowClosed=resolve});
const send = (res,name,body=files.get(name),headers={}) => res.writeHead(200,{'Content-Type':mime(name),'Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store',...headers}).end(body);
const mirror = http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'); requests.push({server:'mirror',path:url.pathname,cookie:req.headers.cookie,origin:req.headers.origin});
  const model=url.pathname.replace(/^\/models\//,'');
  if(modelURLs.includes(model)) {
    const body=model.endsWith('.onnx')?'x'.repeat(Buffer.byteLength(files.get(model))):files.get(model);
    return send(res,model,body,{'Access-Control-Allow-Origin':'*'});
  }
  const match=/^\/(bad|good)\/assets\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname);
  if(!match||!files.has(match[3])) return res.writeHead(404).end();
  const [,kind,digest,name]=match; assert.equal(digest,hash(files.get(name)));
  if(name===wasm&&slow&&kind==='bad') {
    res.writeHead(200,{'Content-Type':'application/wasm','Content-Length':Buffer.byteLength(files.get(name)),'Access-Control-Allow-Origin':'*'});
    res.write('verified');res.on('close',()=>slowClosed(!res.writableEnded));slowStarted();return;
  }
  if(kind==='good')return send(res,name,undefined,{'Access-Control-Allow-Origin':'*'});
  if(name===runtimes[2])return send(res,name); // Real CORS failure, despite matching bytes.
  if(name===preview)return send(res,name,undefined,{'Access-Control-Allow-Origin':'*','Content-Type':'text/plain'});
  return send(res,name,'x'.repeat(Buffer.byteLength(files.get(name))),{'Access-Control-Allow-Origin':'*'});
});
const site=http.createServer((req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';requests.push({server:'site',path:name});
  if(name==='sw.js')return res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'}).end(sw);
  if(!files.has(name))return res.writeHead(404).end();send(res,name);
});
const wait = promise => Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Network event timed out')),10000);timer.unref();})]);
(async()=>{
  await new Promise(resolve=>mirror.listen(0,'127.0.0.1',resolve));mirrorBase=`http://127.0.0.1:${mirror.address().port}`;
  await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${site.address().port}/`;
  const catalog={defaultSource:'hf',sources:{hf:{models:'https://unused.test',libs:'https://unused.test'}},downloadBases:[mirrorBase+'/models'],
    voiceSource:{version:modelVersion,models:`voice-models/${modelVersion}`,repository},
    packs:[{id:'voice',kind:'voice',group:'voice',size:modelFiles.reduce((n,f)=>n+f.size,0),files:modelFiles.map(({body,...file})=>file)}]};
  files.set('packs.json',JSON.stringify(catalog));
  const assets=[...files].filter(([url])=>!url.startsWith('voice-models/')).map(([url,bytes])=>({url,sha256:hash(bytes),
    ...(runtimes.includes(url)||url===preview?{lazy:true,size:Buffer.byteLength(bytes),mirrors:['bad','good'].map(name=>`${mirrorBase}/${name}/assets/${hash(bytes)}/${url}`)}:{})}));
  sw=fs.readFileSync(path.join(app,'sw.js'),'utf8').replace('const RELEASE = "development"; // @asound-release',`const RELEASE = ${JSON.stringify(version)};`)
    .replace('const ASSETS = []; // @asound-assets',`const ASSETS = ${JSON.stringify(assets)};`);
  let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.ASOUND_BROWSER||(process.platform==='win32'?'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined)});
    const context=await browser.newContext({serviceWorkers:'allow'});
    await context.addCookies([{name:'private-cookie',value:'must-not-reach-mirror',url:mirrorBase}]);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'?web');
    await page.evaluate(async()=>{await navigator.serviceWorker.register('sw.js');await navigator.serviceWorker.ready;
      if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
    const result=await page.evaluate(async()=>{const m=await import('./kokoro/neural-tts.js');return{value:m.value,moduleURL:m.moduleURL,childURL:m.childURL}});
    assert.deepEqual(result,{value:'verified',moduleURL:base+runtimes[0],childURL:base+runtimes[1]});
    assert.equal(await page.evaluate(async()=> (await fetch('kokoro/lexicon-us.json')).text()),files.get(runtimes[2]));
    assert.equal(await page.evaluate(async()=> (await fetch('audio/voices/af_heart.wav')).text()),files.get(preview));
    for(const name of [runtimes[0],runtimes[1],runtimes[2],preview]) {
      assert.deepEqual(requests.filter(r=>r.server==='mirror'&&r.path.endsWith('/'+name)).map(r=>r.path.split('/')[1]),['bad','good']);
      assert.equal(requests.some(r=>r.server==='site'&&r.path===name),false);
    }
    await page.evaluate(wasm=>{window.pending=fetch(wasm,{headers:{'X-ASound-Runtime-Request':'mirror-browser-cancel-0001'}}).then(r=>r.status);},wasm);
    await wait(beganSlow);
    await page.evaluate(()=>navigator.serviceWorker.controller.postMessage({type:'ASOUND_CANCEL_RUNTIME',requestId:'mirror-browser-cancel-0001'}));
    assert.equal(await page.evaluate(()=>pending),503);assert.equal(await wait(closedSlow),true,'cancellation closes the actual mirror connection');
    assert.equal(requests.filter(r=>r.path.endsWith('/'+wasm)).length,1,'cancelled transfer must not try another mirror');
    assert.equal(requests.some(r=>r.server==='site'&&r.path===wasm),false);
    slow=false;
    assert.equal(await page.evaluate(async wasm=>(await fetch(wasm,{headers:{'X-ASound-Runtime-Request':'mirror-browser-retry-0002'}})).text(),wasm),files.get(wasm));
    assert.ok(requests.filter(r=>r.server==='mirror'&&r.path.includes('/assets/')).every(r=>r.cookie===undefined&&r.origin===base.slice(0,-1)),'CORS requests omit cookies');
    // Exercise the real packs + model-download path using two tiny SHA-pinned files.
    await page.evaluate(async()=>{window.api=await import('./js/packs.js');await api.initPacks({readOnly:true});await api.install('voice');});
    await page.waitForFunction(()=>api.packStatus('voice').state==='installed');
    const models=requests.filter(r=>modelURLs.some(url=>r.path===url||r.path==='/models/'+url));
    // The downloader may retry an invalid full response once before changing source.
    const sequence=models.map(r=>r.server+':'+r.path).filter((value,index,all)=>index===0||value!==all[index-1]);
    assert.deepEqual(sequence,['mirror:/models/'+modelURLs[0],'mirror:/models/'+modelURLs[1],'site:'+modelURLs[1]]);
    const keys=await page.evaluate(async()=> (await(await caches.open('asound-models-v1')).keys()).map(r=>r.url));
    assert.deepEqual(keys.sort(),modelFiles.map(f=>`https://models.asound.invalid/voice/${modelVersion}/${repository}/${f.path}`).sort());
    const count=requests.length;await page.reload();
    await page.evaluate(async()=>{window.api=await import('./js/packs.js');await api.initPacks({readOnly:true});await api.install('voice');});
    await page.waitForFunction(()=>api.packStatus('voice').state==='installed');
    assert.equal(requests.slice(count).some(r=>r.path.includes('voice-models/')),false,'reopen/install preserves the cached model files');
    await context.setOffline(true);
    assert.equal(await page.evaluate(async wasm=>(await fetch(wasm+'?offline=1')).text(),wasm),files.get(wasm));
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({moduleURLsStaySameOrigin:true,corsHashMimeFallback:true,credentialsOmitted:true,cancelClosesNetwork:true,retry:true,offline:true,
      modelMirrorAndSiteFallback:true,reopenDoesNotRedownload:true,errors}));
  }finally{if(browser)await browser.close();site.closeAllConnections();mirror.closeAllConnections();await Promise.all([new Promise(r=>site.close(r)),new Promise(r=>mirror.close(r))]);}
})().catch(error=>{console.error(error);process.exitCode=1;});
