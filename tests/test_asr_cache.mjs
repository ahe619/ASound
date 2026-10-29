import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('ASR finds its installed cache after switching from a host root to an OSS path prefix', async () => {
  const source = (await readFile(new URL('../app/js/asr-worker.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', '"https://app.test/js/asr-worker.js"');
  const keys = [];
  const context = vm.createContext({ URL, env: { backends: { onnx: { wasm: {} } } }, self: {},
    caches: { open: async () => ({ match: key => { keys.push(key); return 'cached'; }, put: (key) => keys.push(key) }) } });
  vm.runInContext(source + '\nglobalThis.cacheFor = canonCache;', context);
  for (const base of ['https://hf.test/', 'https://oss.test/models/']) {
    const cache = context.cacheFor('models', 'https://models.asound.invalid/', base);
    assert.equal(await cache.match(base + 'onnx-community/test/resolve/main/config.json'), 'cached');
  }
  assert.deepEqual(keys, Array(2).fill('https://models.asound.invalid/onnx-community/test/config.json'));
});
