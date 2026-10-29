// Real controls; test invitation only, no external downloads or model execution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app');
const types = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.css':'text/css', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.webp':'image/webp' };
const testCode = 'TEST-V101-ONLY';
const server = http.createServer((req, res) => {
  const relative = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  const file = path.resolve(app, relative);
  if (!file.startsWith(app + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end('{}');
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  if (relative === 'packs.json') {
    const data = JSON.parse(fs.readFileSync(file));
    data.aliyunDownload.codeSha256 = createHash('sha256').update(testCode).digest('hex');
    return res.end(JSON.stringify(data));
  }
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless:true, executablePath:process.env.ASOUND_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const context = await browser.newContext({ viewport:{width:390,height:844},locale:'zh-CN',hasTouch:true });
  await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [], remote = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (!req.url().startsWith(base)) remote.push(req.url()); });
  try {
    await page.goto(base + '?web&nogpu#models');
    await page.locator('#download-route-original').waitFor();
    assert.equal(await page.locator('#download-route-original').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.brand .app-version').innerText(), 'V1.01');
    await page.locator('#download-route-aliyun').click();
    await page.locator('#download-invitation').fill('wrong');
    await page.getByRole('button', {name:'验证邀请码',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'邀请码不正确'}).waitFor();
    assert.equal(await page.evaluate(async () => (await import('./js/packs.js')).downloadLocked()), true);
    await page.locator('#download-invitation').fill(testCode);
    await page.getByRole('button', {name:'验证邀请码',exact:true}).click();
    await page.getByText('已获准使用阿里云下载', {exact:true}).waitFor();
    await page.reload();
    await page.getByText('已获准使用阿里云下载', {exact:true}).waitFor();
    for (const width of [320,390,768]) {
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.locator('#download-route-original').click();
    await page.setViewportSize({width:390,height:844});
    await page.locator('#tab-vocab').click();
    await page.locator('#ws-pictured-only').check();
    await page.getByRole('button', {name:'开始随机学习',exact:true}).click();
    await page.locator('#ws-word').waitFor();
    const session = await page.evaluate(() => navigator.locks.request('asound.wordstudy.v1', () => JSON.parse(localStorage.getItem('asound.wordstudy.v1')).session));
    const pictures = JSON.parse(fs.readFileSync(path.join(app,'vocabulary/pictures.json'))).pictures;
    assert.equal(session.options.picturedOnly, true);
    assert.ok(session.ids.length > 0 && session.ids.every(id => pictures[id]), 'every selected word has a picture');
    await page.evaluate(() => {
      const options = {deck:'cet4',topic:'',scenario:'',size:10,practice:'spelling'};
      localStorage.setItem('asound.wordstudy.v1', JSON.stringify({options,progress:{},session:{ids:['act'],options,index:0,mode:'random',revealed:false,ratings:[],draft:'',attempt:null,choices:[]}}));
    });
    await page.reload(); await page.locator('#ws-spelling').waitFor();
    assert.equal(await page.locator('.ws-relations').count(), 0, 'families must not reveal a spelling answer');
    await page.locator('#ws-spelling').fill('act');
    await page.locator('#ws-spelling').press('Enter');
    await page.locator('.ws-relations:not([hidden])').waitFor();
    assert.match(await page.locator('.ws-family').innerText(), /action/);
    await page.locator('.ws-forms > summary').click();
    assert.match(await page.locator('.ws-forms').innerText(), /acted/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    fs.mkdirSync(path.resolve(__dirname,'../build/v101'), {recursive:true});
    await page.screenshot({path:path.resolve(__dirname,'../build/v101/word-family-phone.png')});
    assert.deepEqual(errors, []);
    assert.deepEqual(remote, [], 'selection and invitation do not start paid downloads');
    console.log(JSON.stringify({invitationGate:true,choicePersists:true,picturedWordsOnly:true,answerNotLeaked:true,wordFamilies:true,mobileVersion:true,externalRequests:remote.length,errors}));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
