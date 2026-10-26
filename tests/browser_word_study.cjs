// Actual browser interactions against the local app with isolated storage. No model downloads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const app = path.resolve(__dirname, '../app');
const out = path.resolve(__dirname, '../build/optimization-checks/word-study-modes');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).slice(1) || 'index.html';
  const file = path.resolve(app, rel);
  if (!file.startsWith(app + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}'); return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ASOUND_BROWSER
    || (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined), args: ['--mute-audio'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', colorScheme: 'light' });
  await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  const read = () => page.evaluate(() => JSON.parse(localStorage.getItem('asound.wordstudy.v1')));
  const seed = async (practice, ids = ['bridge', 'harvest', 'balance'], extra = {}) => {
    await page.evaluate(({ practice, ids, extra }) => {
      const options = { deck: 'cet4', topic: '', scenario: '', size: 10, practice };
      localStorage.setItem('asound.wordstudy.v1', JSON.stringify({ options, progress: {}, session: {
        ids, options, index: 0, mode: 'random', revealed: false, ratings: [], draft: '', attempt: null,
        choices: practice === 'choice' ? ['balance', 'bridge', 'ticket', 'harvest'] : [], ...extra,
      } }));
    }, { practice, ids, extra });
    // A repeated URL with the same fragment may stay in the existing document.
    await page.reload();
    await page.locator('#ws-word').waitFor();
  };
  const answerChoice = async (id, duplicate = false) => {
    const current = await read();
    const selector = '#ws-answer-' + current.session.choices.indexOf(id);
    if (duplicate) await page.locator(selector).evaluate(button => { button.click(); button.click(); });
    else await page.locator(selector).click();
    await page.locator('#ws-feedback').waitFor();
  };
  const assertVisible = async selector => {
    const bounds = await page.locator(selector).evaluate(el => {
      const box = el.getBoundingClientRect(); const view = el.closest('.view').getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, viewportTop: view.top, viewportBottom: Math.min(view.bottom, visualViewport.height) };
    });
    assert.ok(bounds.top >= bounds.viewportTop - 2 && bounds.bottom <= bounds.viewportBottom + 2, JSON.stringify(bounds));
  };
  try {
    fs.mkdirSync(out, { recursive: true });
    await page.goto(base + '?web&nogpu');
    await page.locator('#ws-practice-cards').waitFor();
    assert.equal(await page.locator('#ws-practice-cards').getAttribute('aria-pressed'), 'true');
    assert.ok(requests.every(url => !/\/models\/|\.onnx|\.gguf/.test(url)), 'first visit does not fetch model weights');
    await page.locator('#ws-practice-choice').click();
    assert.equal((await read()).options.practice, 'choice');
    await page.getByRole('button', { name: '开始随机学习', exact: true }).click();
    await page.locator('.ws-option').first().waitFor();
    assert.equal(await page.locator('.ws-option').count(), 4);
    assert.equal(await page.locator('.ws-illustration').count(), 0);

    await seed('choice');
    const originalChoices = (await read()).session.choices;
    await page.reload(); await page.locator('.ws-option').first().waitFor();
    assert.deepEqual((await read()).session.choices, originalChoices);
    await page.screenshot({ path: path.join(out, 'choice-question-phone.png') });
    await answerChoice('bridge', true);
    assert.equal((await read()).progress.bridge.answers, 1, 'double click records once');
    assert.equal((await read()).session.attempt.correct, true);
    await page.locator('.ws-illustration:not([hidden])').waitFor();
    await page.reload(); await page.locator('#ws-feedback').waitFor();
    assert.equal((await read()).progress.bridge.answers, 1, 'feedback refresh does not grade again');
    assert.equal((await read()).session.index, 0);
    await page.locator('#ws-next').click();
    assert.equal((await read()).session.index, 1);
    assert.equal((await read()).session.ratings[0].correct, true);
    const wrongChoice = (await read()).session.choices.find(id => id !== 'harvest');
    await answerChoice(wrongChoice);
    assert.equal((await read()).session.attempt.correct, false);
    assert.equal((await read()).progress.harvest.correctAnswers, 0);
    assert.equal(await page.locator('.ws-option.is-correct').count(), 1);
    assert.equal(await page.locator('.ws-option.is-wrong').count(), 1);
    await page.screenshot({ path: path.join(out, 'choice-wrong-phone.png') });
    await page.locator('#ws-next').click(); await answerChoice('balance'); await page.locator('#ws-next').click();
    await page.locator('#ws-finished').waitFor();
    assert.deepEqual(await page.locator('.ws-results strong').allTextContents(), ['2', '1', '67%']);

    await seed('spelling');
    assert.equal(await page.locator('.ws-flashcard').evaluate(el => /bridge/i.test(el.innerHTML)), false, 'no target answer in visible or accessibility markup');
    assert.equal(await page.locator('.ws-flashcard .ipa, .ws-flashcard .speak, .ws-illustration').count(), 0);
    const input = page.locator('#ws-spelling');
    for (const [key, value] of Object.entries({ inputmode: 'text', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done', lang: 'en' })) {
      assert.equal(await input.getAttribute(key), value);
    }
    assert.ok(await input.evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
    await input.fill('  BrIdGe  ');
    await page.reload(); await page.locator('#ws-spelling').waitFor();
    assert.equal(await page.locator('#ws-spelling').inputValue(), '  BrIdGe  ', 'typing draft restores');
    await page.locator('#ws-spelling').press('Enter');
    await page.locator('#ws-feedback').waitFor();
    assert.equal((await read()).session.attempt.correct, true);
    assert.equal((await read()).progress.bridge.answers, 1);
    await page.locator('#ws-next').click();
    await page.setViewportSize({ width: 320, height: 420 });
    await page.locator('#ws-spelling').focus();
    await assertVisible('#ws-spelling');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#ws-spelling').fill('harvset');
    await page.locator('#ws-spelling').dispatchEvent('compositionstart');
    await page.locator('#ws-spelling').press('Enter');
    assert.equal((await read()).session.attempt, null, 'IME Enter does not submit');
    await page.locator('.ws-spelling-form').evaluate(form => form.requestSubmit());
    assert.equal((await read()).session.attempt, null, 'submit while composing is ignored');
    await page.locator('#ws-spelling').dispatchEvent('compositionend');
    await page.screenshot({ path: path.join(out, 'spelling-keyboard-small.png') });
    await page.locator('#ws-spelling').press('Enter');
    await page.locator('#ws-feedback').waitFor();
    await assertVisible('#ws-feedback');
    assert.equal((await read()).session.attempt.correct, false);
    assert.equal((await read()).progress.harvest.answers, 1);
    assert.match(await page.locator('#ws-feedback').innerText(), /harvest/);
    await page.screenshot({ path: path.join(out, 'spelling-feedback-small.png') });
    await page.reload(); await page.locator('#ws-feedback').waitFor();
    assert.equal((await read()).progress.harvest.answers, 1);
    await page.locator('#ws-next').click();
    await page.locator('#ws-spelling').fill('balance!');
    await page.locator('.ws-spelling-form').evaluate(form => { form.requestSubmit(); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await page.locator('#ws-feedback').waitFor();
    assert.equal((await read()).progress.balance.answers, 1);
    assert.equal((await read()).session.attempt.correct, false);
    await page.locator('#ws-next').click();
    await page.locator('#ws-finished').waitFor();
    assert.deepEqual(await page.locator('.ws-results strong').allTextContents(), ['1', '2', '33%']);

    // Real dictionary collisions are helpful retries, never incorrect or fabricated mastered words.
    for (const [target, alternative, letters] of [['clothes', 'clothing', 7], ['color', 'colour', 5]]) {
      await seed('spelling', [target]);
      assert.match(await page.locator('#ws-spelling-target').innerText(), new RegExp(`首字母 c.*${letters} 个字母`));
      assert.equal(await page.locator('.ws-illustration').count(), 0);
      await page.locator('#ws-spelling').fill(alternative);
      await page.locator('#ws-spelling').press('Enter');
      await page.locator('.ws-spelling-form .note-card:not([hidden])').waitFor();
      assert.match(await page.locator('.ws-spelling-form .note-card').innerText(), /答案也成立/);
      assert.equal((await read()).session.attempt, null);
      assert.equal((await read()).progress[target], undefined);
      assert.equal((await read()).progress[alternative], undefined);
      assert.equal(await page.locator('#ws-feedback').count(), 0);
      assert.equal(await page.locator('#ws-spelling').inputValue(), alternative);
      await page.reload(); await page.locator('#ws-spelling').waitFor();
      assert.equal(await page.locator('#ws-spelling').inputValue(), alternative);
      assert.equal(await page.locator('.ws-spelling-form .note-card').isVisible(), true);
      await page.locator('#ws-spelling').fill(target);
      await page.locator('.ws-spelling-form').evaluate(form => { form.requestSubmit(); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      await page.locator('#ws-feedback').waitFor();
      assert.equal((await read()).session.attempt.correct, true);
      assert.equal((await read()).progress[target].answers, 1);
      assert.equal((await read()).progress[target].correctAnswers, 1);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await seed('choice', ['reservation'], { options: { deck: 'general', topic: 'travel', scenario: 'restaurant', size: 10, practice: 'choice' }, choices: [] });
    assert.equal(await page.locator('.ws-option').count(), 0);
    assert.match(await page.locator('.ws-flashcard').innerText(), /不同释义不足/);
    await page.getByRole('button', { name: '查看释义', exact: true }).click();
    await page.locator('.ws-grade.good').click();
    await page.locator('#ws-finished').waitFor();
    assert.equal((await read()).progress.reservation.answers, undefined);
    assert.deepEqual(await page.locator('.ws-results strong').allTextContents(), ['0', '0', '—']);
    await seed('spelling');
    await page.evaluate(() => ASoundTheme.setMode('dark'));
    await page.screenshot({ path: path.join(out, 'spelling-question-phone-night.png') });
    await seed('choice');
    await page.screenshot({ path: path.join(out, 'choice-question-phone-night.png') });
    await seed(undefined, ['bridge'], { revealed: true });
    await page.locator('.ws-grade.good').waitFor();
    await page.locator('.ws-grade.good').click();
    await page.locator('#ws-finished').waitFor();
    assert.equal((await read()).progress.bridge.answers, undefined, 'legacy self-ratings are not fabricated objective answers');
    assert.deepEqual(errors, []);
    const report = { passed: ['default cards and actual mode selection', 'no models on initial visit', 'correct/wrong multiple choice',
      'stable choices and feedback on reload', 'once-only grading', 'spelling hidden answer/IPA/audio/images',
      'case and boundary spaces', 'strict misspelling rejection', 'draft restore', 'IME protection',
      '320px short keyboard viewport input and feedback visibility', 'tiny filtered pool falls back to unscored flashcards',
      'night mode', 'legacy flashcards', 'objective completion statistics',
      'dictionary-backed spelling alternatives retain draft without grading; target clue; exactly-once retry'], errors };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
