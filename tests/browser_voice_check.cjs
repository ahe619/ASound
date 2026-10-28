// Diagnostic-page behavior with real packs.js/speech.js, real Web Audio output, and controlled PCM synthesis.
// This verifies measurement/routing, not Kokoro inference or physical speaker audibility on an iPhone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app');
const version = '0.3.5-test';
const runtimes = ['kokoro/ort-cpu/ort-wasm-simd-threaded.mjs', 'kokoro/ort-cpu/ort-wasm-simd-threaded.wasm',
  'kokoro/kokoro.web.js', 'kokoro/neural-tts.js', 'kokoro/lexicon-us.json'];
const savedPrefs = JSON.stringify({ voiceEngine: 'standard', voice: 'af_heart', rate: 1, source: 'deployment', custom: 'PRIVATE_LEARNER_TEXT', rehearsal: 'PRIVATE_RECORDING_TEXT' });
const catalog = { defaultSource: 'hf', sources: { hf: { models: 'https://unused.test', libs: 'https://unused.test/libs' } },
  packs: [{ id: 'voice', kind: 'voice', group: 'voice', size: 1, files: [{ repo: 'test/voice', path: 'weights.bin', size: 1 }] }] };
const neural = `
  const f = window.__voiceFixture = { calls: 0, disposed: 0, mode: new URL(location.href).searchParams.get('case') || 'normal' };
  const listeners = new Set(); let state = { state:'off',error:'',engine:'fixture',initMs:null,generationMs:null,generating:false };
  const emit = () => listeners.forEach(fn => fn({...state}));
  export const configure = cfg => { f.configured = cfg.mode; };
  export const onStatus = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  export const status = () => ({...state});
  export const dispose = () => { f.disposed++; state.state='off';state.generating=false;emit(); };
  export async function synthesize(text, {signal}={}) {
    f.calls++; state.state='loading';emit();
    await new Promise((resolve,reject) => {
      const timer=setTimeout(resolve, f.mode==='slow'?8000:80);
      const abort=()=>{clearTimeout(timer);reject(new DOMException('cancelled','AbortError'));};
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted) abort();
    });
    state.state='ready';state.initMs=80;state.generating=true;emit();
    const pcm=new Float32Array(12000);
    if(f.mode!=='silent') for(let i=0;i<pcm.length;i++)pcm[i]=.2*Math.sin(i*2*Math.PI*440/24000);
    if(f.mode==='paused') await window.__testContext.suspend();
    state.generating=false;state.generationMs=3;emit();return{pcm,sr:24000};
  }
`;
let servedVersion = version;
const requests = [];
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1);
  requests.push(name);
  res.setHeader('Cache-Control', 'no-store');
  if (name === 'version.json') return res.writeHead(servedVersion ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: servedVersion }));
  if (name === 'packs.json') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(catalog));
  if (name === 'kokoro/neural-tts.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(neural);
  if (name === 'fixture.html') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><link rel="icon" href="data:,">');
  if (name === 'old-sw.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(`self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>{if(e.data?.type==='ASOUND_VERSION')e.ports[0].postMessage({version:'0.3.4-old'});});`);
  const file = path.resolve(app, name);
  if (!file.startsWith(app + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end('missing');
  res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : 'application/json');
  res.end(fs.readFileSync(file));
});
const report = page => page.locator('#report').textContent().then(JSON.parse);
const idle = page => page.waitForFunction(() => !document.getElementById('start').disabled);
const ended = page => page.waitForFunction(() => ['speech-ended','speech-error','replay-ended','error','not-ready','timeout'].includes(JSON.parse(document.getElementById('report').textContent).outcome));

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const errors = [], passed = [];
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.ASOUND_BROWSER
      || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined) });
    const base = `http://127.0.0.1:${server.address().port}/`;
    async function pageFor(mode = 'normal', { weights = true, runtime = true, accelerated = false } = {}) {
      const context = await browser.newContext({ viewport: { width: 320, height: 620 }, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
        permissions: ['clipboard-read', 'clipboard-write'] });
      await context.addInitScript(({ savedPrefs, accelerated }) => {
        localStorage.setItem('asound.prefs.v1', savedPrefs);
        localStorage.setItem('learner-secret', 'PRIVATE_LEARNER_TEXT');
        const write = Storage.prototype.setItem;
        window.__writes = 0; Storage.prototype.setItem = function (...args) { window.__writes++; return write.apply(this,args); };
        Object.defineProperty(window, 'speechSynthesis', { value: null });
        const AC = window.AudioContext, resume = AC.prototype.resume;
        window.__allowAudio = new URL(location.href).searchParams.get('case') !== 'paused';
        window.AudioContext = class extends AC { constructor(...args) { super(...args); window.__testContext=this; } };
        AC.prototype.resume = function (...args) { return window.__allowAudio ? resume.apply(this,args) : Promise.resolve(); };
        if (accelerated) { const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,ms===180000?300:ms,...args); }
      }, { savedPrefs, accelerated });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + 'fixture.html');
      await page.evaluate(async ({ base, version, runtimes, weights, runtime }) => {
        if (weights) await (await caches.open('asound-models-v1')).put('https://models.asound.invalid/test/voice/weights.bin', new Response('x'));
        const cache = await caches.open('asound-shell-v2:' + encodeURIComponent(base) + ':' + version);
        await cache.put(base + '__asound_release__', new Response(JSON.stringify({version})));
        if (runtime) for (const file of runtimes) await cache.put(base + file, new Response('cached test runtime'));
      }, { base, version, runtimes, weights, runtime });
      await page.goto(base + 'voice-check.html?case=' + mode);
      await idle(page);
      return { context, page };
    }

    // The actual controlling worker takes precedence over newer metadata on the server.
    const oldContext = await browser.newContext(); const oldPage = await oldContext.newPage();
    await oldPage.goto(base + 'fixture.html');
    await oldPage.evaluate(async () => { await navigator.serviceWorker.register('old-sw.js'); await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true})); });
    const before = requests.length;
    await oldPage.goto(base + 'voice-check.html');
    await oldPage.waitForFunction(() => document.getElementById('status').textContent.includes('0.3.5'));
    assert.equal((await report(oldPage)).version, '0.3.4-old');
    assert.equal(await oldPage.locator('#start').isDisabled(), true);
    assert.equal(requests.slice(before).some(name => name.startsWith('js/') || name.startsWith('kokoro/')), false);
    await oldContext.close();
    passed.push('old controlling SW is rejected before any application module imports');

    for (const options of [{weights:false,runtime:true}, {weights:true,runtime:false}]) {
      const {context,page} = await pageFor('normal', options);
      assert.equal(await page.evaluate(() => __voiceFixture.calls), 0);
      await page.locator('#start').click(); await ended(page);
      const data = await report(page);
      assert.equal(data.outcome, 'not-ready'); assert.equal(data.installed.runtimeMissing, options.weights);
      assert.equal(await page.evaluate(() => __voiceFixture.calls), 0);
      assert.equal(await page.evaluate(() => __writes), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem('asound.prefs.v1')), savedPrefs);
      await context.close();
    }
    passed.push('missing weights and missing runtimes do not synthesize, install, or write preferences');

    for (const mode of ['normal','silent','paused']) {
      const {context,page} = await pageFor(mode);
      assert.equal(await page.evaluate(() => __voiceFixture.calls), 0);
      await page.locator('#start').click(); await ended(page);
      let data = await report(page);
      assert.equal(data.buffers.length, 1); assert.equal(data.buffers[0].samples, 12000); assert.equal(data.buffers[0].finite, true);
      assert.equal(data.neural.initMs, 80); assert.equal(data.neural.generationMs, 3);
      assert.ok(data.events.some(event => event.type === 'speak-button-click'));
      if (mode === 'paused') {
        assert.equal(data.outputs.length, 0); assert.equal(data.audioContext.state, 'suspended');
        assert.equal(await page.locator('#replay').isEnabled(), true);
        await page.evaluate(() => { window.__allowAudio = true; });
        await page.locator('#replay').click();
        await page.waitForFunction(() => JSON.parse(document.getElementById('report').textContent).outcome === 'replay-ended');
        data = await report(page); assert.equal(await page.evaluate(() => __voiceFixture.calls), 1, 'replay must reuse generated PCM');
      }
      assert.equal(data.outputs[0].startSucceeded, true); assert.equal(data.outputs[0].connectedToDestination, true); assert.equal(data.outputs[0].ended, true);
      assert.ok(data.outputs[0].endClock > data.outputs[0].startClock); assert.ok(data.audioContext.clockAdvanced > 0);
      assert.equal(data.buffers[0].peak > 0, mode !== 'silent');
      assert.equal(data.heard, null, 'software output must never assert that the speaker was heard');
      await page.locator('#silent').click(); await page.locator('#copy').click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(JSON.parse(copied).heard, false); assert.equal(copied.includes('PRIVATE_'), false);
      assert.equal(await page.evaluate(() => __writes), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await context.close();
    }
    passed.push('real speech button measures nonzero and silent PCM; actual Web Audio start/ended/clock; explicit replay reuses paused PCM; clipboard excludes learner content');

    const {context,page} = await pageFor('slow');
    await page.locator('#start').click();
    await page.waitForFunction(() => __voiceFixture.calls === 1);
    assert.equal(await page.locator('#start').isDisabled(), true);
    await page.locator('#cancel').click();
    assert.equal((await report(page)).outcome, 'cancelled'); assert.equal((await report(page)).outputs.length, 0);
    await page.evaluate(() => { __voiceFixture.mode='normal'; });
    await page.locator('#start').click(); await ended(page);
    assert.equal((await report(page)).outcome, 'speech-ended'); assert.equal(await page.evaluate(() => __voiceFixture.calls), 2);
    await context.close();
    const timed = await pageFor('slow', {accelerated:true});
    await timed.page.locator('#start').click(); await ended(timed.page);
    assert.equal((await report(timed.page)).outcome, 'timeout'); assert.equal((await report(timed.page)).outputs.length, 0);
    assert.equal(await timed.page.locator('#start').isEnabled(), true); await timed.context.close();
    passed.push('cancel, retry, non-reentrancy, and bounded timeout');
    assert.equal(requests.some(name => name.endsWith('weights.bin') || name.endsWith('.wasm') || name.startsWith('voice-models/')), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({passed,errors,limitation:'Controlled synthesis fixture; actual iPhone Kokoro and physical audibility require device diagnostics.'}));
  } finally { if(browser) await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
