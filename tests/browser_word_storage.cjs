// Real, isolated same-origin tabs: Web Locks and IndexedDB fallback, no models.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app');
const key = 'asound.wordstudy.v1';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const fakeMic = `window.ASoundMic={supported:true,RATE:16000,hasModel:()=>true,hasNative:()=>false,
status:()=>({asr:'ready',mic:'off'}),onStatus:()=>()=>{},configure(){},configureHelp(){},cancel(){},
async record(){},async stop(){return {text:'brigde',audio:new Float32Array(16000)}}};`;
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1) || 'index.html';
  if (rel === 'storage-fixture.html') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Storage test</title>');
  if (rel === 'js/voice-input.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(fakeMic);
  const file = path.resolve(app, rel);
  if (!file.startsWith(app + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ASOUND_BROWSER
    || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined) });
  const report = [], errors = [];
  async function contextFor(backend = 'locks') {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await context.addInitScript(backend => {
      window.restoreStorage = () => {};
      if (backend !== 'locks') {
        const locks = navigator.locks, db = window.indexedDB;
        Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
        if (backend === 'none') Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
        window.restoreStorage = () => {
          Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
          Object.defineProperty(window, 'indexedDB', { configurable: true, value: db });
        };
      }
    }, backend);
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    return context;
  }
  const read = page => page.evaluate(() => JSON.parse(localStorage.getItem('asound.wordstudy.v1')));
  async function seed(page, practice = 'spelling') {
    await page.evaluate(practice => {
      const options = { deck: 'cet4', topic: '', scenario: '', size: 10, practice };
      localStorage.setItem('asound.wordstudy.v1', JSON.stringify({ options, progress: {}, session: {
        ids: ['bridge', 'harvest'], options, index: 0, mode: 'random', revealed: false, ratings: [], draft: '', attempt: null,
        choices: practice === 'choice' ? ['bridge', 'balance', 'ticket', 'harvest'] : [],
      } }));
    }, practice);
  }
  async function appPage(context, practice) {
    const page = await context.newPage();
    await page.goto(base + 'storage-fixture.html'); await seed(page, practice);
    await page.goto(base + '?web&nogpu#vocab/practice'); await page.locator('#ws-word').waitFor();
    return page;
  }
  async function hold(page) {
    await page.evaluate(() => {
      window.lockHeld = false;
      navigator.locks.request('asound.wordstudy.v1', () => {
        window.lockHeld = true; return new Promise(resolve => { window.releaseLock = resolve; });
      });
    });
    await page.waitForFunction(() => window.lockHeld);
  }
  try {
    for (const backend of ['locks', 'idb']) {
      const context = await contextFor(backend), a = await context.newPage(), b = await context.newPage();
      for (const page of [a, b]) await page.goto(base + 'storage-fixture.html');
      await a.evaluate(async () => {
        window.core = await import('./js/word-study-core.js');
        core.saveStudyState({ progress: { bridge: core.answerProgress(null, true, 'choice', 1000) } });
        window.study = core.readStudyState();
      });
      await b.evaluate(async () => { window.core = await import('./js/word-study-core.js'); window.study = core.readStudyState(); });
      for (const now of [2000, 3000]) assert.equal(await a.evaluate(now => core.commitStudyState(study, next => {
        next.progress.bridge = core.answerProgress(next.progress.bridge, true, 'choice', now);
      }), now), true);
      assert.equal(await b.evaluate(() => core.commitStudyState(study, next => {
        next.progress.bridge = core.answerProgress(next.progress.bridge, false, 'spelling', 4000);
      })), true);
      let actual = (await read(a)).progress.bridge;
      assert.equal(actual.seen, 4); assert.equal(actual.answers, 4); assert.equal(actual.correctAnswers, 3);
      assert.equal(actual.lastAnswerCorrect, false); assert.equal(actual.due, 604000);
      // Both tabs queue writes without observing the other's in-memory state.
      const concurrent = await Promise.all([a, b].map((page, tab) => page.evaluate(async tab => {
        const results = await Promise.all(Array.from({ length: 12 }, (_, n) => core.commitStudyState(study, next => {
          next.progress.bridge = core.answerProgress(next.progress.bridge, tab === 0, 'choice', 5000 + n);
        })));
        await core.commitStudyState(study); // old setup save cannot replay a review
        return results;
      }, tab)));
      assert.ok(concurrent.flat().every(value => value === true));
      actual = (await read(a)).progress.bridge;
      assert.equal(actual.seen, 28); assert.equal(actual.answers, 28); assert.equal(actual.correctAnswers, 15);
      if (backend === 'idb') {
        // Real IDB abort after the localStorage write must not report an unsaved
        // review: a retry would otherwise increment the durable count twice.
        assert.equal(await a.evaluate(async () => {
          const get = IDBObjectStore.prototype.get;
          IDBObjectStore.prototype.get = function (...args) {
            window.lockTransaction = this.transaction;
            return get.apply(this, args);
          };
          try { return await core.commitStudyState(study, next => {
            next.progress.bridge = core.answerProgress(next.progress.bridge, false, 'choice', 9000);
            queueMicrotask(() => window.lockTransaction.abort());
          }); }
          finally { IDBObjectStore.prototype.get = get; }
        }), true);
        assert.equal((await read(a)).progress.bridge.seen, 29);
      }
      await context.close(); report.push(`${backend}: stale wrong answer retained; two tabs preserve 24 concurrent reviews; setup saves never replay`);
    }

    // A lock delayed by another tab must not cause double grading or reopen the
    // departed question, and a replaced session must reject the old operation.
    {
      const context = await contextFor(), page = await appPage(context, 'choice'), blocker = await context.newPage();
      await blocker.goto(base + 'storage-fixture.html'); await hold(blocker);
      await page.locator('#ws-answer-0').evaluate(button => { button.click(); button.click(); });
      await page.locator('.ws-study-head button').click(); await page.locator('#ws-practice-choice').waitFor();
      await blocker.evaluate(() => releaseLock());
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('asound.wordstudy.v1')).session.attempt?.correct === true);
      assert.equal((await read(page)).progress.bridge.answers, 1);
      assert.equal(await page.locator('#ws-practice-choice').isVisible(), true, 'late save stays in setup');
      await page.goto(base + 'storage-fixture.html'); await seed(page, 'choice');
      await page.goto(base + '?web&nogpu#vocab/practice'); await page.locator('#ws-word').waitFor();
      await hold(blocker); await page.locator('#ws-answer-0').click();
      await page.locator('.ws-study-head button').click();
      await page.getByRole('button', { name: '开始随机学习', exact: true }).click();
      await blocker.evaluate(() => releaseLock());
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('asound.wordstudy.v1')).session.ids.length === 10);
      assert.equal((await read(page)).progress.bridge, undefined, 'replaced session does not receive old queued review');
      assert.equal((await read(page)).session.attempt, null);
      await context.close(); report.push('pending answer: double click counted once; back stays in setup; replacement session skips stale review');
    }

    for (const practice of ['spelling', 'say']) {
      const context = await contextFor('none'), page = await appPage(context, practice);
      if (practice === 'spelling') {
        await page.locator('#ws-spelling').fill('brigde'); await page.locator('#ws-spelling').press('Enter');
      } else {
        await page.locator('.ws-say .mic-btn').click(); await page.locator('.ws-say .mic-btn').click();
      }
      await page.locator('.ws-storage-warning').waitFor();
      const input = page.locator(practice === 'say' ? '#ws-say-input' : '#ws-spelling');
      assert.equal(await input.inputValue(), 'brigde');
      assert.equal((await read(page)).session.attempt, null); assert.equal((await read(page)).progress.bridge, undefined);
      assert.equal(await page.locator('#ws-feedback').count(), 0);
      await page.evaluate(() => restoreStorage()); await input.press('Enter'); await page.locator('#ws-feedback').waitFor();
      assert.equal((await read(page)).progress.bridge.answers, 1);
      assert.equal((await read(page)).progress.bridge.lastAnswerCorrect, false);
      assert.equal((await read(page)).session.attempt.response, 'brigde');
      await context.close(); report.push(`${practice}: unavailable locking keeps draft; retry saves the same wrong answer exactly once`);
    }
    assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ passed: report, errors }, null, 2) + '\n');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
