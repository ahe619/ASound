// Real update chain with isolated browser storage and tiny release snapshots.
// The production updates.js and sw.js run unchanged; no models are loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app');
const updates = fs.readFileSync(path.join(app, 'js/updates.js'), 'utf8');
const template = fs.readFileSync(path.join(app, 'sw.js'), 'utf8');
const releases = new Map();
for (const number of [1, 2, 3]) {
  const version = `0.3.${number}-update-test`;
  const files = new Map([
    ['index.html', `<!doctype html><meta charset="utf-8"><title>Update check</title>
      <script type="module">
        import * as api from './js/updates.js';
        window.api = api; window.documentVersion = ${JSON.stringify(version)};
        sessionStorage.loads = Number(sessionStorage.loads || 0) + 1;
        window.states = []; api.onUpdateStatus(state => states.push(state));
        await api.initUpdates(); window.started = true;
      </script>`],
    ['js/updates.js', updates],
    ['version.json', JSON.stringify({ version })],
  ]);
  const assets = [...files].map(([url, body]) => ({ url, sha256: crypto.createHash('sha256').update(body).digest('hex') }));
  const sw = template
    .replace('const RELEASE = "development"; // @asound-release', `const RELEASE = ${JSON.stringify(version)}; // @asound-release`)
    .replace('const ASSETS = []; // @asound-assets', `const ASSETS = ${JSON.stringify(assets)}; // @asound-assets`);
  releases.set(number, { files, sw });
}
// Tiny historical-worker fixtures reproduce the old fetch failure and preserve
// real waiting/active worker lifecycles. The fixed worker is production sw.js.
// Deleting these APIs simulates the compatibility condition, not an entire Safari engine.
const legacyAPIs = 'delete AbortSignal.prototype.throwIfAborted;Object.defineProperty(AbortSignal.prototype,"reason",{configurable:true,get(){return undefined}});\n';
for (const [number, version, broken] of [[11, '0.3.1-legacy-working', false], [12, '0.3.5-legacy-broken', true], [13, '0.3.7-legacy-fixed', null]]) {
  const files = new Map([...releases.get(1).files].map(([name, body]) => [name, body.replaceAll('0.3.1-update-test', version)]));
  files.set('js/compat-probe.js', `export const version=${JSON.stringify(version)};`);
  const assets = [...files].map(([url, body]) => ({ url, sha256: crypto.createHash('sha256').update(body).digest('hex') }));
  const oldWorker = `
    const version=${JSON.stringify(version)}, root=self.registration.scope;
    const name='asound-shell-v2:'+encodeURIComponent(root)+':'+version;
    self.addEventListener('install',event=>event.waitUntil((async()=>{
      const cache=await caches.open(name);
      for(const file of ${JSON.stringify([...files.keys()])})await cache.put(new URL(file,root),await fetch(new URL(file,root),{cache:'no-store'}));
      await cache.put(new URL('__asound_release__',root),new Response(JSON.stringify({version,installed:Date.now()})));
    })()));
    self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
    self.addEventListener('message',event=>{if(event.data?.type==='ASOUND_VERSION')event.ports[0]?.postMessage({version});});
    self.addEventListener('fetch',event=>event.respondWith((async()=>{
      try{
        ${broken ? 'event.request.signal.throwIfAborted();' : ''}
        const url=new URL(event.request.url);url.search='';if(url.href===root)url.href=new URL('index.html',root).href;
        return await(await caches.open(name)).match(url)||fetch(event.request);
      }catch{return new Response('Old worker failure',{status:503});}
    })()));`;
  const fixed = template.replace('const RELEASE = "development"; // @asound-release', `const RELEASE = ${JSON.stringify(version)}; // @asound-release`)
    .replace('const ASSETS = []; // @asound-assets', `const ASSETS = ${JSON.stringify(assets)}; // @asound-assets`);
  releases.set(number, { files, sw: legacyAPIs + (broken === null ? fixed : oldWorker) });
}
let served = 1;
let failUpdate = false;
const requests = [];
const server = http.createServer((req, res) => {
  const file = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  requests.push({ release: served, file });
  if (file === 'sw.js' && failUpdate) return res.writeHead(503).end('temporary update failure');
  const release = releases.get(served);
  const body = file === 'sw.js' ? release.sw : release.files.get(file);
  if (body == null) return res.writeHead(404).end('missing');
  res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': file.endsWith('.html') ? 'text/html'
    : file.endsWith('.js') ? 'text/javascript' : 'application/json' }).end(body);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.ASOUND_BROWSER
      || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined) });
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.started);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      }
    });
    await page.reload();
    await page.waitForFunction(() => window.started);
    const originalLoads = await page.evaluate(() => sessionStorage.loads);

    served = 2;
    const waiting2 = await page.evaluate(() => api.checkForUpdates());
    assert.equal(waiting2.version, '0.3.1-update-test');
    assert.equal(waiting2.nextVersion, '0.3.2-update-test');
    assert.equal(waiting2.state, 'available');

    served = 3;
    const before = requests.filter(request => request.file === 'sw.js').length;
    const waiting3 = await page.evaluate(() => api.checkForUpdates());
    assert.ok(requests.filter(request => request.file === 'sw.js').length > before, 'check must fetch the latest worker despite an older waiting release');
    assert.equal(waiting3.version, '0.3.1-update-test');
    assert.equal(waiting3.nextVersion, '0.3.3-update-test');
    assert.equal(waiting3.state, 'available');
    assert.equal(await page.evaluate(() => states.some(state => state.state === 'error')), false, 'superseded waiting workers must not emit failure');
    assert.equal(await page.evaluate(() => sessionStorage.loads), originalLoads, 'checking must not reload the running app');
    assert.equal(await page.evaluate(() => documentVersion), '0.3.1-update-test');

    // The already verified waiting release remains usable if a later check fails.
    failUpdate = true;
    const failed = await page.evaluate(() => api.checkForUpdates());
    assert.equal(failed.state, 'error');
    assert.equal(failed.nextVersion, '0.3.3-update-test');
    await context.setOffline(true);
    await page.evaluate(() => api.applyUpdate());
    await page.waitForFunction(() => window.documentVersion === '0.3.3-update-test' && window.started);
    assert.equal(await page.evaluate(() => api.updateStatus().version), '0.3.3-update-test');
    assert.equal(Number(await page.evaluate(() => sessionStorage.loads)), Number(originalLoads) + 1);
    assert.deepEqual(errors, []);
    await context.close();
    failUpdate = false;
    const base = `http://127.0.0.1:${server.address().port}/`;
    const controllerVersion = target => target.evaluate(() => new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data.version); };
      navigator.serviceWorker.controller.postMessage({ type: 'ASOUND_VERSION' }, [channel.port2]);
    }));
    const controlled = target => target.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    // A newer bad waiting cache must not be confused with the working active worker.
    served = 11;
    const legacyContext = await browser.newContext({ serviceWorkers: 'allow' });
    const one = await legacyContext.newPage(); one.on('pageerror', error => errors.push(error.message));
    await one.goto(base); await one.waitForFunction(() => window.started); await controlled(one);
    await one.reload(); await one.waitForFunction(() => window.started);
    const two = await legacyContext.newPage(); two.on('pageerror', error => errors.push(error.message));
    await two.goto(base); await two.waitForFunction(() => window.started);
    served = 12;
    assert.equal((await one.evaluate(() => api.checkForUpdates())).nextVersion, '0.3.5-legacy-broken');
    served = 13;
    const fixedWaiting = await one.evaluate(() => api.checkForUpdates());
    assert.equal(fixedWaiting.state, 'available'); assert.equal(fixedWaiting.nextVersion, '0.3.7-legacy-fixed');
    for (const tab of [one, two]) {
      assert.equal(await controllerVersion(tab), '0.3.1-legacy-working');
      assert.equal(await tab.evaluate(() => documentVersion), '0.3.1-legacy-working');
      assert.match(await tab.evaluate(async () => (await fetch('js/compat-probe.js')).text()), /0\.3\.1-legacy-working/);
    }
    const blocked = await one.evaluate(() => api.applyUpdate());
    assert.equal(blocked.state, 'blocked'); assert.equal(blocked.reason, 'tabs');
    await two.close(); await one.evaluate(() => api.applyUpdate());
    await one.waitForFunction(() => window.documentVersion === '0.3.7-legacy-fixed' && window.started);
    await legacyContext.close();
    // The genuinely broken active worker still responds to version messages and
    // can be recovered without requiring its broken document to apply the update.
    served = 12;
    const brokenContext = await browser.newContext({ serviceWorkers: 'allow' });
    const stuck = await brokenContext.newPage(); stuck.on('pageerror', error => errors.push(error.message));
    await stuck.goto(base); await stuck.waitForFunction(() => window.started); await controlled(stuck);
    assert.equal(await stuck.evaluate(async () => (await fetch('js/compat-probe.js')).status), 503);
    assert.equal(await controllerVersion(stuck), '0.3.5-legacy-broken');
    served = 13; await stuck.evaluate(() => api.checkForUpdates());
    await stuck.waitForFunction(() => !window.api.updateStatus().nextVersion && window.api.updateStatus().state === 'current');
    assert.equal(await controllerVersion(stuck), '0.3.7-legacy-fixed');
    assert.equal(await stuck.evaluate(async () => (await fetch('js/compat-probe.js')).status), 200);
    await stuck.reload(); await stuck.waitForFunction(() => window.documentVersion === '0.3.7-legacy-fixed' && window.started);
    await brokenContext.close();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: ['1 -> waiting 2 -> latest 3', 'no false redundant failure', 'no reload before consent', 'failed check preserves waiting release', 'explicit apply activates 3 offline',
      'legacy APIs: working active + bad waiting + fixed update preserves both tabs', 'legacy multi-tab apply stays blocked', 'legacy broken active automatically recovers'], errors }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
