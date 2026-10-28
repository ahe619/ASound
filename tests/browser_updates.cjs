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
    console.log(JSON.stringify({ passed: ['1 -> waiting 2 -> latest 3', 'no false redundant failure', 'no reload before consent', 'failed check preserves waiting release', 'explicit apply activates 3 offline'], errors }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
