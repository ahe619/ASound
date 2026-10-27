// Real ServiceWorker + CacheStorage integration, using tiny test runtimes/weights.
// No model is downloaded or executed. The production packs.js and sw.js run unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app');
const version = 'runtime-offline-test-v1';
const runtimes = [
  'vendor/transformers/ort-wasm-simd-threaded.jsep.mjs',
  'vendor/transformers/ort-wasm-simd-threaded.jsep.wasm',
  'kokoro/kokoro.web.js', 'kokoro/neural-tts.js', 'kokoro/lexicon-us.json',
];
const files = new Map([
  ['index.html', `<!doctype html><meta charset="utf-8"><title>Offline runtime check</title>
    <script type="module">
      import * as api from './js/packs.js'; window.api = api;
      await api.initPacks(); window.started = true;
    </script>`],
  ['js/packs.js', fs.readFileSync(path.join(app, 'js/packs.js'), 'utf8')],
  ['js/state.js', 'export const prefs={source:"deployment"}; export const savePrefs=()=>{};'],
  ['js/device.js', 'export const deviceInfo=()=>({mobile:true});'],
  ['js/model-download.js', `
    export const modelPartialBytes=async()=>0, discardModelPartial=async()=>{};
    export const downloadModelFile=async({cache,key,signal,onBytes})=>{
      signal.throwIfAborted(); window.weightDownloads=(window.weightDownloads||0)+1;
      await cache.put(key,new Response('x')); onBytes(1);
    };`],
  ['version.json', JSON.stringify({ version })],
  ['packs.json', JSON.stringify({ defaultSource: 'deployment', sources: { deployment: { models: 'https://unused.test', libs: 'https://unused.test/libs' } },
    packs: [{ id: 'voice', group: 'voice', kind: 'voice', size: 1, files: [{ repo: 'test/voice', path: 'weights.bin', size: 1 }] }] })],
]);
for (const file of runtimes) files.set(file, 'verified test runtime: ' + file + (file.endsWith('.wasm') ? 'x'.repeat(1024 * 1024) : ''));
const assets = [...files].map(([url, bytes]) => ({ url, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  ...(runtimes.includes(url) ? { lazy: true } : {}) }));
const sw = fs.readFileSync(path.join(app, 'sw.js'), 'utf8')
  .replace('const RELEASE = "development"; // @asound-release', `const RELEASE = ${JSON.stringify(version)}; // @asound-release`)
  .replace('const ASSETS = []; // @asound-assets', `const ASSETS = ${JSON.stringify(assets)}; // @asound-assets`);
let failRuntime = true;
let slowRuntime = false, slowResponse = null, runtimeStarted, runtimeClosed;
const startedRuntime = new Promise(resolve => { runtimeStarted = resolve; });
const closedRuntime = new Promise(resolve => { runtimeClosed = resolve; });
const requests = [];
const server = http.createServer((req, res) => {
  const rel = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  requests.push(rel);
  if (rel === 'sw.js') return res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(sw);
  if (!files.has(rel)) return res.writeHead(404).end('missing');
  if (rel === runtimes[0] && failRuntime) return res.writeHead(503).end('temporary failure');
  if (rel === runtimes[1] && slowRuntime) {
    const body = Buffer.from(files.get(rel));
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.write(body.subarray(0, 100));
    slowResponse = res;
    res.on('close', () => { runtimeClosed(!res.writableEnded); slowResponse = null; });
    runtimeStarted();
    return;
  }
  res.writeHead(200, { 'Content-Type': rel.endsWith('.html') ? 'text/html' : rel.endsWith('.js') || rel.endsWith('.mjs') ? 'text/javascript'
    : rel.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'Cache-Control': 'no-store' }).end(files.get(rel));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ASOUND_BROWSER
    || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined) });
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  const errors = [], passed = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(base + '?web&nogpu');
    await page.waitForFunction(() => window.started);
    await page.evaluate(() => api.install('voice'));
    await page.waitForFunction(() => window.weightDownloads === 1);
    assert.equal(await page.evaluate(() => api.packStatus('voice').state), 'downloading');
    assert.equal(requests.filter(url => runtimes.includes(url)).length, 0);
    await page.evaluate(() => api.cancel('voice'));
    assert.equal(await page.evaluate(() => api.packStatus('voice').state), 'partial');
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    await page.waitForTimeout(50);
    assert.equal(requests.filter(url => runtimes.includes(url)).length, 0, 'activation does not revive cancellation');
    passed.push('first install waits for the real controller; cancelling it keeps weights and stops subsequent warm-up');

    await page.evaluate(() => api.install('voice'));
    await page.waitForFunction(() => api.packStatus('voice').state === 'partial' && /HTTP 503/.test(api.packStatus('voice').error || ''));
    assert.equal(await page.evaluate(() => weightDownloads), 1);
    passed.push('a real ServiceWorker 503 keeps the pack partial');
    failRuntime = false;
    slowRuntime = true;
    await page.evaluate(() => api.install('voice'));
    await startedRuntime;
    assert.equal(await page.evaluate(() => api.packStatus('voice').state), 'downloading');
    await page.evaluate(() => api.cancel('voice'));
    let timer;
    const closed = await Promise.race([closedRuntime, new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
    clearTimeout(timer);
    assert.equal(closed, true, 'explicit cancellation must close the ServiceWorker upstream connection before the body finishes');
    assert.equal(await page.evaluate(async ({ version, file }) => {
      const root = new URL('./', location.href).href;
      const cache = await caches.open(`asound-shell-v2:${encodeURIComponent(root)}:${version}`);
      return !!await cache.match(new URL(file, root));
    }, { version, file: runtimes[1] }), false, 'an interrupted response is never cached');
    assert.equal(await page.evaluate(() => api.packStatus('voice').state), 'partial');
    assert.equal(await page.evaluate(() => weightDownloads), 1);
    passed.push('cancelling a slow runtime closes the actual network connection and publishes no incomplete cache entry');
    slowRuntime = false;
    await page.evaluate(() => api.install('voice'));
    await page.waitForFunction(() => api.packStatus('voice').state === 'installed');
    assert.equal(await page.evaluate(() => weightDownloads), 1);
    const cached = await page.evaluate(async ({ version, runtimes }) => {
      const root = new URL('./', location.href).href;
      const cache = await caches.open(`asound-shell-v2:${encodeURIComponent(root)}:${version}`);
      return Promise.all(runtimes.map(async file => !!await cache.match(new URL(file, root))));
    }, { version, runtimes });
    assert.ok(cached.every(Boolean));
    assert.deepEqual([...new Set(requests.filter(url => url.startsWith('vendor/') || url.startsWith('kokoro/')))], runtimes);
    passed.push('retry reuses weights and only the voice runtime is verified into the complete snapshot');

    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => window.started);
    assert.equal(await page.evaluate(() => api.packStatus('voice').state), 'installed');
    assert.equal(await page.evaluate(() => window.weightDownloads || 0), 0);
    const offline = await page.evaluate(async runtimes => {
      const responses = await Promise.all(runtimes.map(url => fetch(url).then(r => r.text())));
      return responses.every(text => text.startsWith('verified test runtime:'));
    }, runtimes);
    assert.equal(offline, true);
    passed.push('offline reload recognizes the complete pack and serves every runtime without a network');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed, errors }));
  } catch (error) {
    console.error(JSON.stringify({ errors, requests, status: await page.evaluate(() => window.api?.packStatus('voice')) }));
    throw error;
  } finally { await browser.close(); slowResponse?.destroy(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
