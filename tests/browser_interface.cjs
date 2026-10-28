// Real controls, isolated browser storage, no model downloads. This checks UI
// navigation and responsive layout, not physical iPhone rendering/performance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app');
const out = path.resolve(__dirname, '../build/ui-layout/verified');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = path.resolve(app, decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1) || 'index.html');
  if (!file.startsWith(app + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end('{}');
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ASOUND_BROWSER || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', hasTouch: true });
  await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [], requests = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  const open = async id => { if (!await page.locator('#' + id).evaluate(el => el.open)) await page.locator('#' + id + ' > summary').click(); };
  const inScreen = async locator => {
    const box = await locator.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height, JSON.stringify(box));
  };
  try {
    fs.mkdirSync(out, { recursive: true });
    await page.goto(base + '?web&nogpu#vocab');
    await page.locator('#ws-deck-general').waitFor();
    await inScreen(page.getByRole('button', { name: '开始随机学习', exact: true }));
    await page.locator('#study-options > summary').focus();
    await page.keyboard.press('Enter');
    const topic = page.locator('[id^="ws-topic-"]:not(#ws-topic-any)').first();
    const topicId = await topic.getAttribute('id');
    await topic.click();
    assert.equal(await page.locator('#study-options').evaluate(el => el.open), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), topicId);
    await page.locator('#ws-size-10').click();
    assert.match(await page.locator('#study-options > summary').innerText(), /10/);
    await page.locator('#ws-topic-any').click();
    assert.match(await page.locator('#study-options > summary').innerText(), /随机/);
    await page.locator('#study-options > summary').click();

    await page.click('#tab-talk');
    await inScreen(page.locator('#start-btn'));
    await open('talk-scenes');
    const scene = page.locator('#talk-scenes .opt').nth(1);
    const sceneId = await scene.getAttribute('id');
    await scene.click();
    assert.equal(await page.locator('#talk-scenes').evaluate(el => el.open), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), sceneId);
    assert.equal(await page.locator('#talk-scenes .ui-disclosure-note').innerText(), await page.locator('.launch-title').innerText());
    await page.locator('#talk-scenes > summary').click();
    await open('talk-level');
    await page.locator('#talk-level [data-id="3"]').click();
    assert.match(await page.locator('#talk-level > summary').innerText(), /3/);
    await page.locator('#talk-level > summary').click();

    await page.click('#tab-accent');
    await inScreen(page.locator('#check-start'));
    await open('accent-topics');
    const drill = page.locator('#accent-topics .opt').nth(1);
    const drillId = await drill.getAttribute('id');
    await drill.click();
    assert.equal(await page.locator('#accent-topics').evaluate(el => el.open), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), drillId);
    await page.locator('#accent-topics > summary').click();

    await page.click('#settings-open');
    await inScreen(page.locator('#settings-app > summary'));
    await open('settings-learning');
    await page.selectOption('#help-lang', 'es');
    await page.selectOption('#ui-lang', 'en');
    await page.waitForFunction(() => document.querySelector('#settings-title').textContent === 'Settings');
    assert.equal(await page.locator('#settings-learning').evaluate(el => el.open), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ui-lang');
    await open('settings-appearance');
    await page.locator('#settings-appearance').getByRole('button', { name: 'Dark', exact: true }).click();
    assert.equal(await page.evaluate(() => ASoundTheme.getMode()), 'dark');
    await page.locator('#settings-appearance').getByRole('button', { name: 'Light', exact: true }).click();
    await page.locator('.settings-link').click();
    await page.locator('#view-models:not([hidden])').waitFor();
    await page.goBack();
    await page.locator('#settings:not([hidden])').waitFor();
    assert.equal(await page.locator('#settings-learning').evaluate(el => el.open), true);
    assert.equal(await page.locator('#help-lang').inputValue(), 'es');
    await page.selectOption('#ui-lang', 'zh');
    await page.waitForFunction(() => document.querySelector('#settings-title').textContent === '设置');
    await page.click('#settings-close');
    await page.reload();
    await page.locator('#check-start').waitFor();
    assert.equal(await page.evaluate(async () => (await import('./js/state.js')).prefs.helpLang), 'es');

    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      for (const mode of ['light', 'dark']) {
        await page.evaluate(mode => ASoundTheme.setMode(mode), mode);
        for (const tab of ['talk', 'accent', 'vocab', 'me']) {
          await page.click('#tab-' + tab);
          assert.equal(await page.evaluate(() => {
            const view = document.querySelector('.view:not([hidden])');
            return document.documentElement.scrollWidth <= innerWidth && view.scrollWidth <= view.clientWidth;
          }), true, `${width} ${mode} ${tab}: no horizontal scrolling`);
          await page.screenshot({ path: path.join(out, `${width}-${mode}-${tab}.png`) });
        }
        await page.click('#settings-open');
        await page.screenshot({ path: path.join(out, `${width}-${mode}-settings.png`) });
        await page.click('#settings-close');
      }
    }
    assert.equal(requests.some(url => /\.onnx|\.gguf|params_shard/.test(url)), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ primaryActionsVisible: true, optionalChoicesPreserved: true, keyboardAndFocus: true,
      settingsAndBack: true, preferencesSaved: true, widths: [320, 390, 768, 1280], themes: ['light', 'dark'], modelDownloads: 0, errors }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
