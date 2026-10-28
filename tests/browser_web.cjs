// Optional real-browser release test. Requires Playwright and a Chromium/Edge executable.
// NODE_PATH can point at an existing Playwright installation; no models or microphone are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const python = process.env.ASOUND_PYTHON || (process.platform === 'win32'
  ? path.join(root, '.venv/Scripts/python.exe') : 'python3');
const output = path.join(root, 'build/web-browser-check');
const screenshot = path.join(root, 'build/optimization-checks/web-mobile.png');
function build(version) {
  const result = spawnSync(python, ['-B', 'tools/build_web.py', '--out', output, '--version', version], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(fs.readFileSync(path.join(output, 'version.json'), 'utf8')).version;
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json' };
let corruptVersion = false;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!url.pathname.startsWith('/ASound/')) { res.writeHead(404).end(); return; }
  const relative = decodeURIComponent(url.pathname.slice('/ASound/'.length)) || 'index.html';
  const file = path.resolve(output, relative);
  if (!file.startsWith(output + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}'); return;
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (corruptVersion && relative === 'version.json') res.end('{"version":"corrupted-deployment"}');
  else fs.createReadStream(file).pipe(res);
});

(async () => {
  const first = build('0.2.0-smoke-a');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/ASound/?nogpu`;
  const edge = process.env.ASOUND_BROWSER || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
  const browser = await chromium.launch({ headless: true, executablePath: edge });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    const page = await context.newPage();
    if (process.env.ASOUND_DEBUG) page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) console.log('navigate:', frame.url()); });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const status = () => page.evaluate(async () => (await import('./js/updates.js')).updateStatus());
    const check = () => page.evaluate(async () => (await import('./js/updates.js')).checkForUpdates());
    const apply = () => page.evaluate(async () => (await import('./js/updates.js')).applyUpdate());
    await page.goto(url);
    await page.waitForFunction(async () => (await import('./js/updates.js')).updateStatus().state === 'current', undefined, { timeout: 120000 });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    assert.equal((await status()).version, first);
    await page.evaluate(async () => {
      localStorage.setItem('asound.smoke.learning', 'keep-my-progress');
      await (await caches.open('asound-models-v1')).put('https://models.asound.invalid/sentinel', new Response('keep-my-model'));
      await (await caches.open('another-project-cache')).put('/outside', new Response('keep-other-project'));
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle('smoke-model', { create: true });
      const writer = await file.createWritable();
      await writer.write('keep-opfs-model'); await writer.close();
    });
    await page.locator('#tab-talk').click();
    assert.equal(await page.locator('#talk-home .mode-card').count(), 2);
    await page.locator('#talk-home .mode-card').first().scrollIntoViewIfNeeded();
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile horizontal overflow');
    await page.locator('#talk-home .mode-card').first().click();
    await page.waitForFunction(() => !document.querySelector('#mode').hasAttribute('aria-busy'));
    assert.equal(await page.locator('#mode').textContent().then((text) => /retell\./.test(text)), false, 'raw feature translation key');
    await page.locator('#tab-talk').click();

    await context.setOffline(true);
    await page.reload();
    await page.locator('#start-btn').waitFor();
    await page.waitForFunction(async (version) => (await import('./js/updates.js')).updateStatus().version === version, first);
    assert.equal((await status()).version, first, 'offline release must boot');
    await context.setOffline(false);

    const second = build('0.2.0-smoke-b');
    await check();
    assert.equal((await status()).state, 'available');
    assert.equal((await status()).nextVersion, second);
    assert.equal((await status()).version, first, 'waiting update must not change current UI');
    assert.equal(await page.evaluate(async () => (await fetch('version.json').then((r) => r.json())).version), first);
    const secondTab = await context.newPage();
    await secondTab.goto(url);
    assert.equal((await apply()).reason, 'tabs', 'do not switch another open window');
    await secondTab.close();
    await page.locator('#tab-talk').click();
    await page.locator('#talk-home .mode-card').first().click();
    await page.waitForFunction(() => !document.querySelector('#mode').hasAttribute('aria-busy'));
    assert.equal((await apply()).reason, 'practice', 'do not replace an active exercise');
    await page.locator('#tab-talk').click();
    await page.locator('#settings-open').click();
    await page.locator('#settings-app > summary').click();
    await Promise.all([
      page.waitForEvent('domcontentloaded'),
      page.locator('#app-updates button').last().click(),
    ]);
    await page.waitForFunction(async (version) => (await import('./js/updates.js')).updateStatus().version === version, second, { timeout: 60000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('asound.smoke.learning')), 'keep-my-progress');
    assert.equal(await page.evaluate(async () => (await (await caches.open('asound-models-v1')).match('https://models.asound.invalid/sentinel')).text()), 'keep-my-model');
    assert.equal(await page.evaluate(async () => (await (await caches.open('another-project-cache')).match('/outside')).text()), 'keep-other-project');
    assert.equal(await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('smoke-model')).getFile()).text()), 'keep-opfs-model');

    build('0.2.0-smoke-broken');
    corruptVersion = true;
    await check();
    assert.equal((await status()).state, 'error', 'reject partial/corrupted deployment');
    assert.equal((await status()).version, second, 'failed update preserves current release');
    assert.equal(await page.evaluate(async () => (await fetch('version.json').then((r) => r.json())).version), second);
    await context.setOffline(true);
    await page.reload();
    await page.locator('#start-btn').waitFor();
    await page.waitForFunction(async (version) => (await import('./js/updates.js')).updateStatus().version === version, second);
    assert.equal((await status()).version, second, 'old release still boots offline after failed update');
    assert.deepEqual(errors, [], 'unexpected browser errors');
    console.log('PASS: real browser subpath boot, mobile layout, offline reload, waiting update, practice/multi-tab protection, explicit activation, model/OPFS/learning preservation, failed-deployment recovery.');
    console.log(`Screenshot: ${screenshot}`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
