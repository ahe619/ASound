// Optional real-browser theme checks: isolated storage and a local static server, no model downloads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app');
const output = path.resolve(__dirname, '../build/optimization-checks');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const relative = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).slice(1) || 'index.html';
  const file = path.resolve(app, relative);
  if (!file.startsWith(app + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}'); return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.ASOUND_BROWSER || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined),
    args: ['--mute-audio'],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', colorScheme: 'light' });
  await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  context.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  try {
    fs.mkdirSync(output, { recursive: true });
    await page.goto(base + '?web&nogpu');
    await page.locator('.ws-deck').first().waitFor();
    assert.equal(await page.locator('#view-vocab').isVisible(), true, 'first web visit opens word study');
    assert.equal(requests.some(url => /\.onnx|\.gguf|params_shard/.test(url)), false, 'word study does not request model weights');
    const theme = () => page.evaluate(() => ({ mode: ASoundTheme.getMode(), resolved: ASoundTheme.getResolvedTheme(),
      background: getComputedStyle(document.body).backgroundColor, overflow: document.documentElement.scrollWidth > innerWidth,
      button: document.getElementById('theme-toggle').getBoundingClientRect().width }));
    assert.equal((await theme()).mode, 'system');
    await page.emulateMedia({ colorScheme: 'dark' });
    assert.equal((await theme()).resolved, 'dark');
    await page.locator('#theme-toggle').click();
    assert.equal((await theme()).mode, 'light');
    assert.equal((await theme()).background, 'rgb(243, 245, 250)');
    await page.screenshot({ path: path.join(output, 'theme-phone-day.png') });
    await page.locator('#theme-toggle').click();
    assert.equal((await theme()).mode, 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    assert.equal((await theme()).resolved, 'dark');
    assert.equal((await theme()).background, 'rgb(10, 16, 40)');
    assert.equal(await page.locator('.topbar').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(18, 26, 58)');
    await page.screenshot({ path: path.join(output, 'theme-phone-night.png') });
    await page.reload(); await page.locator('.ws-deck').first().waitFor();
    assert.equal((await theme()).mode, 'dark');
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal((await theme()).overflow, false, `overflow at ${width}px`);
      assert.ok((await theme()).button >= 44, 'theme has an accessible touch target');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#settings-open').click();
    await page.locator('#settings-learning > summary').click();
    await page.locator('#settings-panel select').first().waitFor();
    const form = await page.locator('#settings-panel select').first().evaluate(el => ({
      color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor,
      scheme: getComputedStyle(el).colorScheme, overflow: el.scrollWidth > el.clientWidth,
    }));
    assert.equal(form.scheme, 'dark');
    assert.equal(form.color, 'rgb(230, 234, 246)');
    assert.equal(form.background, 'rgb(10, 16, 40)');
    await page.screenshot({ path: path.join(output, 'theme-phone-settings-night.png') });
    await page.locator('#settings-close').click();
    await page.evaluate(async () => (await import('./js/models.js')).showModels());
    await page.locator('#models .pack').first().waitFor();
    await page.screenshot({ path: path.join(output, 'theme-phone-download-night.png') });
    assert.equal((await theme()).overflow, false);
    await page.locator('.download-options > summary').click();
    await page.getByRole('button', {name:'检查下载连接', exact:true}).click();
    await page.waitForFunction(async () => !(await import('./js/packs.js')).connectionStatus().checking);
    assert.equal(await page.locator('.download-options').evaluate(el => el.open), true, 'connection result stays expanded');
    await page.locator('.pack-details > summary').first().click();
    await page.evaluate(async () => (await import('./js/models.js')).renderModels());
    assert.equal(await page.locator('.pack-details').first().evaluate(el => el.open), true, 'licence details stay expanded on progress refresh');
    await page.locator('.download-options > summary').click();
    await page.evaluate(async () => (await import('./js/models.js')).renderModels());
    assert.equal(await page.locator('.download-options').evaluate(el => el.open), false, 'user can close a preserved panel');
    const other = await context.newPage();
    await other.goto(base + '?web&nogpu#vocab');
    await other.locator('.ws-deck').first().waitFor();
    assert.equal(await other.evaluate(() => ASoundTheme.getMode()), 'dark');
    await page.locator('#theme-toggle').click();
    await other.waitForFunction(() => ASoundTheme.getMode() === 'system');
    await other.close();
    assert.deepEqual(errors, []);
    const report = { checks: ['system changes', 'explicit day/night', 'refresh persistence', 'cross-tab sync',
      '320/390/768/1280 widths without overflow', 'night vocabulary/download/settings controls',
      'first web visit requires no model download', 'download details survive status refresh'], errors, form };
    fs.writeFileSync(path.join(output, 'theme-browser-checks.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
