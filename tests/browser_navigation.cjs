// Real Back/Forward interactions with isolated storage and no downloaded models.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app');
const out = path.resolve(__dirname, '../build/optimization-checks/navigation');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).slice(1) || 'index.html';
  if (rel === 'before.html') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Previous website</h1>');
  const file = path.resolve(app, rel);
  if (!file.startsWith(app + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end('{}');
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ASOUND_BROWSER
    || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined), args: ['--mute-audio'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  await context.route('**/*', route => {
    if (!route.request().url().startsWith(base)) return route.abort();
    if (new URL(route.request().url()).pathname === '/js/speech.js') {
      const source = fs.readFileSync(path.join(app, 'js/speech.js'), 'utf8').replace(
        'export function speak(text, btn = null, rateMul = 1, onDone = null, voiceId = null) {',
        'export function speak(text, btn = null, rateMul = 1, onDone = null, voiceId = null) { window.testSpeakCalls = (window.testSpeakCalls || 0) + 1;');
      return route.fulfill({ contentType: 'text/javascript', body: source });
    }
    if (new URL(route.request().url()).pathname === '/js/packs.js') {
      const source = fs.readFileSync(path.join(app, 'js/packs.js'), 'utf8').replace('export function ready() {',
        'export function ready() { if (typeof window.testAllPacksReady === "boolean") return window.testAllPacksReady;');
      return route.fulfill({ contentType: 'text/javascript', body: source });
    }
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [], requests = [], passed = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  const nav = () => page.evaluate(() => history.state?.['asound.navigation.v1']);
  const count = () => page.evaluate(() => history.length);
  const study = () => page.evaluate(() => JSON.parse(localStorage.getItem('asound.wordstudy.v1')));
  const back = async () => { await page.goBack(); await page.waitForTimeout(80); };
  const forward = async () => { await page.goForward(); await page.waitForTimeout(80); };
  const visible = async selector => assert.equal(await page.locator(selector).isVisible(), true, selector);
  try {
    fs.mkdirSync(out, { recursive: true });
    await page.goto(base + 'before.html');
    await page.goto(base + '?web&nogpu');
    await page.locator('#ws-practice-cards').waitFor();
    const rootLength = await count();
    assert.equal((await nav()).parent, null);
    await back(); assert.equal(new URL(page.url()).pathname, '/before.html');
    await forward(); await page.locator('#ws-practice-cards').waitFor();
    assert.equal(await count(), rootLength);
    passed.push('root Back exits to previous website; Forward returns without a trap');

    await page.click('#tab-talk'); await visible('#view-talk-home');
    await page.click('#tab-accent'); await visible('#view-accent');
    await page.click('#tab-vocab'); await page.locator('#ws-practice-cards').waitFor();
    const setupId = (await nav()).id, setupLength = await count();
    await back(); await visible('#view-accent');
    await forward(); await page.locator('#ws-practice-cards').waitFor();
    assert.equal((await nav()).id, setupId); assert.equal(await count(), setupLength);
    passed.push('ordinary tabs have reversible Back/Forward history');

    await page.click('#ws-practice-spelling');
    await page.getByRole('button', { name: '开始随机学习', exact: true }).click();
    await page.locator('#ws-spelling').fill(' unfinished draft ');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('asound.wordstudy.v1')).session.draft === ' unfinished draft ');
    const original = await study();
    const practiceId = (await nav()).id, practiceLength = await count();
    assert.equal((await nav()).route.detail, 'practice');
    await back(); await page.locator('#ws-practice-spelling').waitFor();
    assert.equal((await nav()).id, setupId);
    assert.equal((await study()).session.draft, ' unfinished draft ');
    await forward(); await page.locator('#ws-spelling').waitFor();
    assert.equal(await page.locator('#ws-spelling').inputValue(), ' unfinished draft ');
    assert.equal(await count(), practiceLength);
    assert.deepEqual((await study()).progress, original.progress);
    passed.push('practice Back goes one level to choices and Forward restores unsubmitted spelling');

    await page.click('#settings-open'); await visible('#settings');
    const settingsId = (await nav()).id;
    await page.locator('#settings-appearance > summary').click();
    await page.locator('#layout-mode').scrollIntoViewIfNeeded();
    const panelScroll = await page.locator('#settings-panel').evaluate(el => el.scrollTop);
    await back(); await page.locator('#ws-spelling').waitFor();
    await forward(); await visible('#settings');
    assert.equal((await nav()).id, settingsId);
    assert.ok(Math.abs(await page.locator('#settings-panel').evaluate(el => el.scrollTop) - panelScroll) < 3, 'settings scroll restored');
    await page.click('#settings-close'); await page.waitForTimeout(80);
    await page.click('#tab-models');
    await visible('#view-models');
    assert.equal(await page.locator('#settings').isVisible(), false);
    assert.equal(await page.locator('#tab-models').getAttribute('aria-selected'), 'true');
    const modelsId = (await nav()).id, modelsLength = await count();
    await page.locator('#models details[data-download-detail="connections"]').evaluate(el => { el.open = true; });
    await page.locator('#view-models').evaluate(el => { el.scrollTop = 450; });
    await back(); await page.locator('#ws-spelling').waitFor();
    assert.equal((await nav()).id, practiceId);
    assert.equal((await nav()).route.detail, 'practice');
    assert.equal(await page.locator('#ws-spelling').inputValue(), ' unfinished draft ');
    await forward(); await visible('#view-models');
    assert.equal((await nav()).id, modelsId);
    assert.equal(await page.locator('#models details[data-download-detail="connections"]').evaluate(el => el.open), true);
    assert.ok(Math.abs(await page.locator('#view-models').evaluate(el => el.scrollTop) - 450) < 3, 'downloads scroll restored');
    assert.equal(await count(), modelsLength);
    await page.locator('#models .back').click(); await page.waitForTimeout(80);
    assert.equal(await page.locator('#settings').isVisible(), false);
    assert.equal((await nav()).id, practiceId);
    assert.equal(await page.locator('#ws-spelling').inputValue(), ' unfinished draft ');
    passed.push('settings history preserves scroll; the Models tab restores downloads and the original practice draft on Back/Forward');

    await page.getByRole('button', { name: '返回选择', exact: true }).click(); await page.waitForTimeout(80);
    await page.locator('#ws-practice-spelling').waitFor();
    await back(); await visible('#view-accent');
    await forward(); await page.locator('#ws-practice-spelling').waitFor();
    await forward(); await page.locator('#ws-spelling').waitFor();
    assert.equal((await nav()).id, practiceId);
    assert.deepEqual((await study()).session, original.session);
    passed.push('in-page Back uses the same parent; choices Back reaches prior tab; Forward remains intact');

    await page.reload(); await page.locator('#ws-spelling').waitFor();
    assert.equal((await nav()).id, practiceId);
    await back(); await page.locator('#ws-practice-spelling').waitFor();
    await forward(); await page.locator('#ws-spelling').waitFor();
    assert.equal(await page.locator('#ws-spelling').inputValue(), ' unfinished draft ');
    const other = await context.newPage();
    await other.goto(base + '?web&nogpu#me'); await other.locator('#view-me:not([hidden])').waitFor();
    assert.equal((await nav()).id, practiceId, 'another tab does not change navigation');
    await other.close();
    passed.push('reload retains route ancestry and draft; another browser tab does not navigate this one');

    await page.getByRole('button', { name: '我的生词本', exact: true }).click();
    await page.locator('#vocab-search').waitFor();
    await back(); await page.locator('#ws-spelling').waitFor();
    assert.equal(await page.locator('#ws-spelling').inputValue(), ' unfinished draft ');
    await forward(); await page.locator('#vocab-search').waitFor();
    passed.push('saved vocabulary section restores independently of practice');

    await page.click('#tab-talk');
    await page.locator('#talk-home .mode-card').first().click();
    await page.locator('#mode .rt-choice').first().waitFor();
    const modeId = (await nav()).id, modeLength = await count();
    await back(); await visible('#view-talk-home');
    assert.equal(await page.locator('#mode').innerText(), '');
    await forward(); await page.locator('#mode .rt-choice').first().waitFor();
    assert.equal((await nav()).id, modeId);
    assert.equal(await count(), modeLength);
    await page.locator('#mode .back').click(); await page.waitForTimeout(80); await visible('#view-talk-home');
    await forward(); await page.locator('#mode .rt-choice').first().waitFor();
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    assert.equal((await nav()).id, modeId);
    assert.equal(await page.locator('#mode').innerText(), '');
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.locator('#mode .rt-choice').first().waitFor();
    assert.equal(await count(), modeLength);
    passed.push('practice modes dispose on Back and remount on Forward/bfcache without history mutations');

    await page.click('#tab-vocab'); await page.locator('#ws-practice-spelling').waitFor();
    await page.getByRole('button', { name: '继续学习', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 420 });
    await page.locator('#ws-spelling').focus();
    await back(); await page.locator('#ws-practice-spelling').waitFor();
    await forward(); await page.locator('#ws-spelling').waitFor();
    await page.locator('#ws-spelling').focus();
    await page.screenshot({ path: path.join(out, 'phone-short-restored-draft.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('#ws-spelling').inputValue(), ' unfinished draft ');
    passed.push('320px short viewport retains draft without horizontal overflow');

    // Real chat listeners with fake microphone/model I/O: no recording permission,
    // inference, or audio hardware is used. A delayed reply must not speak offscreen.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async () => {
      const { prefs } = await import('./js/state.js');
      prefs.scenario = 'chat'; prefs.autoplay = true;
      window.pendingReply = null; window.testRecording = false; window.testCancels = 0;
      const sample = () => new Promise(resolve => { window.pendingReply = resolve; });
      sample.json = async () => ({});
      window.claude = { use: async () => sample };
      window.ASoundMic = { supported: true, status: () => ({ mic: 'off' }),
        listen: async () => { window.testRecording = true; },
        cancel: () => { window.testRecording = false; window.testCancels++; },
        pause: () => {}, resume: () => {}, hasNative: () => false };
    });
    await page.click('#tab-talk'); await page.click('#start-btn');
    await page.locator('#view-chat:not([hidden])').waitFor();
    await page.waitForFunction(() => typeof pendingReply === 'function');
    await page.click('#live-toggle');
    assert.equal(await page.evaluate(() => testRecording), true);
    const speakCalls = await page.evaluate(() => window.testSpeakCalls || 0);
    const liveId = await page.evaluate(async () => (await import('./js/state.js')).state.session.id);
    await back(); await visible('#view-talk-home');
    assert.equal(await page.evaluate(() => testRecording), false);
    assert.ok(await page.evaluate(() => testCancels > 0));
    await page.evaluate(() => pendingReply({ text: 'This reply completed after leaving the chat.' }));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('asound.live.v1'))?.turns.length === 1);
    assert.equal(await page.evaluate(() => window.testSpeakCalls || 0), speakCalls, 'late hidden reply is never spoken');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('asound.live.v1')).id), liveId);
    await forward(); await visible('#view-chat');
    assert.match(await page.locator('#thread').innerText(), /completed after leaving/);
    await page.click('#live-toggle'); assert.equal(await page.evaluate(() => testRecording), true);
    await page.click('#tab-me'); await visible('#view-me');
    assert.equal(await page.evaluate(() => testRecording), false);
    assert.equal(await page.evaluate(async () => (await import('./js/state.js')).state.session.id), liveId);
    passed.push('chat Back and tab exits stop microphones; late replies save without hidden autoplay or session loss');

    await page.click('#tab-talk');
    await page.getByRole('button', { name: '接着练', exact: true }).click();
    await page.click('#mode-type');
    await page.evaluate(async () => { (await import('./js/state.js')).prefs.autoplay = false; window.pendingReply = null; });
    await page.locator('#composer-input').fill('Please keep this conversation going.');
    await page.click('#send-btn');
    await page.waitForFunction(() => typeof pendingReply === 'function');
    await page.evaluate(async () => {
      window.testLiveSession = (await import('./js/state.js')).state.session;
      window.testPendingBubble = document.querySelector('#thread .bubble.thinking');
    });
    await back(); await visible('#view-talk-home');
    await page.getByRole('button', { name: '接着练', exact: true }).click();
    await visible('#view-chat');
    assert.equal(await page.evaluate(async () => (await import('./js/state.js')).state.session === testLiveSession), true);
    assert.equal(await page.evaluate(() => testPendingBubble.isConnected && testPendingBubble === document.querySelector('#thread .bubble.thinking')), true);
    assert.equal(await page.locator('#send-btn').isDisabled(), true, 'resuming retains pending reply busy state');
    await page.evaluate(() => pendingReply({ text: 'Your pending reply survived resuming.' }));
    await page.waitForFunction(() => document.getElementById('thread').textContent.includes('survived resuming'));
    assert.equal(await page.locator('#send-btn').isDisabled(), false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('asound.live.v1')).turns.at(-1).text), 'Your pending reply survived resuming.');

    await page.evaluate(() => { window.pendingReply = null; });
    await page.locator('#composer-input').fill('Discard this unfinished conversation.');
    await page.click('#send-btn');
    await page.waitForFunction(() => typeof pendingReply === 'function');
    await page.evaluate(async () => { window.testDiscardController = (await import('./js/state.js')).state.session._ctl; });
    await back(); await visible('#view-talk-home');
    await page.getByRole('button', { name: '不要了', exact: true }).click();
    assert.equal(await page.locator('#talk-home .resume').count(), 0);
    assert.equal(await page.evaluate(async () => (await import('./js/state.js')).state.session), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('asound.live.v1')), null);
    assert.equal(await page.evaluate(() => testDiscardController.signal.aborted), true);
    await page.evaluate(() => pendingReply({ text: 'This discarded reply must never return.' }));
    await page.waitForTimeout(30);
    assert.equal(await page.evaluate(() => localStorage.getItem('asound.live.v1')), null);
    assert.equal(await page.locator('#talk-home .resume').count(), 0);
    passed.push('Back then Continue preserves pending reply identity, DOM and busy state; Discard clears memory/storage and aborts the reply');
    await page.click('#tab-me');

    const beforeSetup = (await nav()).id;
    await page.evaluate(async () => {
      window.testAllPacksReady = false;
      (await import('./js/models.js')).showModels({ setup: true, onReady: () => { window.testSetupDone = true; } });
    });
    const setupEntryId = (await nav()).id, beforeFinishLength = await count();
    assert.equal(await page.getByRole('button', { name: '开始练习', exact: true }).first().isDisabled(), true);
    await page.evaluate(async () => { window.testAllPacksReady = true; (await import('./js/models.js')).renderModels(); });
    await page.getByRole('button', { name: '开始练习', exact: true }).first().click();
    await visible('#view-talk-home');
    assert.equal(await page.evaluate(() => testSetupDone), true);
    assert.equal((await nav()).id, setupEntryId);
    assert.equal(await count(), beforeFinishLength, 'finished setup is replaced, not left as a stale entry');
    await back(); await visible('#view-me'); assert.equal((await nav()).id, beforeSetup);
    await forward(); await visible('#view-talk-home');
    passed.push('completed model setup replaces its entry and preserves the original parent');
    assert.deepEqual(errors, []);
    assert.equal(requests.some(url => /\.onnx|\.gguf|params_shard/.test(url)), false);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ passed, errors }, null, 2));
    console.log(JSON.stringify({ passed, errors }));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
