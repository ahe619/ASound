// Exercise the standalone repair page against real service workers under a project subpath.
// Old snapshots deliberately omit repair.html; no main application or model is executed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app');
const repair = fs.readFileSync(path.join(app, 'repair.html'), 'utf8');
const template = fs.readFileSync(path.join(app, 'sw.js'), 'utf8');
const scope = '/project/asound/';
const releases = new Map();
for (const number of [1, 2, 3, 4, 5]) {
  const version = `repair-test-${number}`;
  const files = new Map([
    ['index.html', `<!doctype html><link rel="icon" href="data:,"><script>window.documentVersion=${JSON.stringify(version)}</script>`],
    ['version.json', JSON.stringify({ version })],
  ]);
  if (number >= 3) files.set('repair.html', repair);
  const assets = [...files].map(([url, body]) => ({ url, sha256: crypto.createHash('sha256').update(body).digest('hex') }));
  let sw = template
    .replace('const RELEASE = "development"; // @asound-release', `const RELEASE = ${JSON.stringify(version)}; // @asound-release`)
    .replace('const ASSETS = []; // @asound-assets', `const ASSETS = ${JSON.stringify(assets)}; // @asound-assets`);
  if (number === 4) {
    // A worker which stops responding to activation requests must not leave the page stuck.
    sw = sw.replace('if (!event.data || event.data.type !== "ASOUND_APPLY_UPDATE") return;', 'if (!event.data || event.data.type !== "ASOUND_APPLY_UPDATE") return; return;');
  }
  if (number === 5) sw = sw.replace('if (event.data && event.data.type === "ASOUND_VERSION") {', 'if (event.data && event.data.type === "ASOUND_VERSION") { return;');
  releases.set(number, { files, sw });
}
let served = 3, failUpdate = false;
const requests = [];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  requests.push(pathname);
  if (!pathname.startsWith(scope)) return res.writeHead(404).end('outside scope');
  const file = pathname.slice(scope.length) || 'index.html';
  if (file === 'sw.js' && failUpdate) return res.writeHead(503).end('temporary failure');
  const release = releases.get(served);
  const body = file === 'repair.html' ? repair : file === 'sw.js' ? release.sw : release.files.get(file);
  if (body == null) return res.writeHead(404).end('missing');
  res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': file.endsWith('.html') ? 'text/html'
    : file.endsWith('.js') ? 'text/javascript' : 'application/json' }).end(body);
});
const checkDone = page => page.waitForFunction(() => !document.getElementById('check').disabled);

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const errors = [], passed = [];
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.ASOUND_BROWSER
      || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined) });
    const base = `http://127.0.0.1:${server.address().port}${scope}`;
    const fresh = await browser.newContext({ viewport: { width: 320, height: 620 }, colorScheme: 'dark', serviceWorkers: 'allow' });
    const first = await fresh.newPage();
    first.on('pageerror', error => errors.push(error.message));
    await first.goto(base + 'repair.html');
    await checkDone(first);
    assert.equal(await first.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
    assert.equal(requests.some(url => url.endsWith('/sw.js')), false, 'opening repair must not register or update a worker');
    assert.equal(await first.locator('#apply').isDisabled(), true);
    failUpdate = true;
    await first.locator('#check').click();
    await checkDone(first);
    assert.match(await first.locator('#status').textContent(), /检查未完成/);
    failUpdate = false;
    await first.locator('#check').click();
    await checkDone(first);
    assert.equal(await first.locator('#current').textContent(), 'repair-test-3');
    assert.equal(await first.locator('#apply').isEnabled(), true);
    assert.equal(await first.evaluate(() => !!navigator.serviceWorker.controller), true);
    await first.locator('summary').click();
    assert.equal(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await first.locator('#apply').click();
    await first.waitForURL(base + '#accent');
    assert.equal(await first.evaluate(() => documentVersion), 'repair-test-3');
    passed.push('fresh page is inert; first installation failure retries successfully and claims controller; 320px layout');
    await fresh.close();

    served = 1;
    const old = await browser.newContext({ serviceWorkers: 'allow', permissions: ['clipboard-read', 'clipboard-write'] });
    const original = await old.newPage();
    original.on('pageerror', error => errors.push(error.message));
    await original.goto(base);
    await original.evaluate(async () => {
      localStorage.setItem('learning-test', 'keep');
      await (await caches.open('asound-models-test')).put(new URL('saved-model.bin', location.href), new Response('keep-model'));
      await navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    served = 2;
    await original.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg.update();
      const worker = reg.installing;
      if (worker) await new Promise((resolve, reject) => {
        const changed = () => {
          if (worker.state === 'installed') { worker.removeEventListener('statechange', changed); resolve(); }
          else if (worker.state === 'redundant') reject(new Error('fixture install failed'));
        };
        worker.addEventListener('statechange', changed); changed();
      });
    });
    const repairPage = await old.newPage();
    repairPage.on('pageerror', error => errors.push(error.message));
    await repairPage.goto(base + 'repair.html');
    await checkDone(repairPage);
    assert.equal(await repairPage.locator('#current').textContent(), 'repair-test-1');
    assert.equal(await repairPage.locator('#next').textContent(), 'repair-test-2');
    served = 3;
    failUpdate = true;
    await repairPage.locator('#check').click();
    await checkDone(repairPage);
    assert.match(await repairPage.locator('#status').textContent(), /检查未完成/);
    assert.equal(await repairPage.locator('#apply').isDisabled(), true);
    assert.equal(await repairPage.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting), true);
    failUpdate = false;
    await repairPage.locator('#check').click();
    await checkDone(repairPage);
    assert.equal(await repairPage.locator('#next').textContent(), 'repair-test-3');
    assert.equal(await repairPage.locator('#current').textContent(), 'repair-test-1');
    await repairPage.locator('#copy').click();
    const copied = await repairPage.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /当前版本：repair-test-1/);
    assert.match(copied, /可用更新：repair-test-3/);
    assert.match(copied, /浏览器：Mozilla/);
    await repairPage.locator('#apply').click();
    await repairPage.waitForFunction(() => document.getElementById('status').textContent.includes('只保留此检查页'));
    assert.equal(repairPage.url(), base + 'repair.html');
    assert.equal(old.pages().length, 2, 'repair must never close other user tabs');
    await original.close();
    await repairPage.locator('#apply').click();
    await repairPage.waitForURL(base + '#accent');
    assert.equal(await repairPage.evaluate(() => documentVersion), 'repair-test-3');
    assert.equal(await repairPage.evaluate(() => localStorage.getItem('learning-test')), 'keep');
    assert.equal(await repairPage.evaluate(async () => (await (await caches.open('asound-models-test')).match(new URL('saved-model.bin', location.href))).text()), 'keep-model');
    passed.push('old worker omitting repair serves it online; failed check preserves pending release; latest replaces older waiting; copy includes versions and UA; two-tab gate; explicit activation preserves learner/model data');

    await repairPage.goto(base + 'repair.html');
    await checkDone(repairPage);
    served = 4;
    await repairPage.locator('#check').click();
    await checkDone(repairPage);
    assert.equal(await repairPage.locator('#next').textContent(), 'repair-test-4');
    await repairPage.locator('#apply').click();
    await repairPage.waitForFunction(() => document.getElementById('status').textContent.includes('暂未响应'), null, { timeout: 20000 });
    assert.equal(repairPage.url(), base + 'repair.html');
    assert.equal(await repairPage.locator('#apply').isEnabled(), true);
    assert.equal(await repairPage.locator('#current').textContent(), 'repair-test-3');
    passed.push('unresponsive activation times out and restores controls without navigation');
    await old.close();

    served = 5;
    const stalled = await browser.newContext({ serviceWorkers: 'allow' });
    const recovery = await stalled.newPage();
    recovery.on('pageerror', error => errors.push(error.message));
    await recovery.goto(base);
    await recovery.evaluate(async () => {
      await navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
    });
    await recovery.goto(base + 'repair.html');
    await checkDone(recovery);
    assert.equal(await recovery.locator('#current').textContent(), '暂时无法读取');
    served = 3;
    await recovery.locator('#check').click();
    await checkDone(recovery);
    assert.equal(await recovery.locator('#next').textContent(), 'repair-test-3');
    assert.equal(await recovery.locator('#apply').isEnabled(), true, 'an unreadable old version must not block applying a healthy replacement');
    await recovery.locator('#apply').click();
    await recovery.waitForURL(base + '#accent');
    assert.equal(await recovery.evaluate(() => documentVersion), 'repair-test-3');
    passed.push('an old worker which cannot report its version can still be replaced');
    assert.deepEqual(errors, []);
    assert.equal(requests.every(url => url.startsWith(scope)), true, 'worker registration must remain within the project scope');
    assert.equal(requests.some(url => /\/(?:js|models|vendor|kokoro)\//.test(url)), false, 'the repair page must not import the app or load models');
    console.log(JSON.stringify({ passed, errors }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
