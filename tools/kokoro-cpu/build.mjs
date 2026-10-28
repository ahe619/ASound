// Rebuild the browser voice with the matching WASM-only ONNX Runtime.
// Outputs only to build/kokoro-cpu; publishing remains an explicit separate step.
import { rollup } from 'rollup';
import alias from '@rollup/plugin-alias';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(root, '../../build/kokoro-cpu');
const nm = path.join(root, 'node_modules');
const ortVersion = '1.22.0-dev.20250409-89f8206ba4';
const ortCommit = '89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0';
const versions = { 'kokoro-js': '1.2.1', '@huggingface/transformers': '3.5.1',
  'phonemizer': '1.2.1', 'onnxruntime-web': ortVersion };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const license = `MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const lockBytes = await readFile(path.join(root, 'package-lock.json'));
const lock = JSON.parse(lockBytes);
const dependencies = {};
for (const [name, version] of Object.entries(versions)) {
  const installed = JSON.parse(await readFile(path.join(nm, name, 'package.json'), 'utf8'));
  const locked = lock.packages[`node_modules/${name}`];
  if (installed.version !== version || locked?.version !== version || !locked.integrity) {
    throw new Error(`Unexpected ${name} dependency; run npm ci --ignore-scripts`);
  }
  dependencies[name] = { version, resolved: locked.resolved, integrity: locked.integrity };
}
const actualCommit = (await readFile(path.join(nm, 'onnxruntime-web/__commit.txt'), 'utf8')).trim();
if (actualCommit !== ortCommit) throw new Error('Unexpected ONNX Runtime source revision');

await mkdir(path.join(out, 'ort-cpu'), { recursive: true });
const runtimeDir = path.join(nm, 'onnxruntime-web/dist');
const warnings = [];
const bundle = await rollup({
  input: path.join(nm, 'kokoro-js/dist/kokoro.js'),
  plugins: [
    alias({ entries: [{ find: /^onnxruntime-web$/, replacement: path.join(runtimeDir, 'ort.wasm.bundle.min.mjs') }] }),
    nodeResolve({ browser: true }),
    terser({ format: { comments: false } }),
  ],
  onwarn(warning) {
    warnings.push({ code: warning.code, message: warning.message });
    if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message);
  },
});
const modules = bundle.cache.modules.map(m => path.relative(root, m.id).replaceAll('\\', '/'));
await bundle.write({ file: path.join(out, 'kokoro.web.js'), format: 'esm' });
await bundle.close();
for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await copyFile(path.join(runtimeDir, name), path.join(out, 'ort-cpu', name));
}
await writeFile(path.join(out, 'ort-cpu/LICENSE.txt'), license);
const output = await readFile(path.join(out, 'kokoro.web.js'), 'utf8');
if (output.includes('ort-wasm-simd-threaded.jsep') || !output.includes('ort-wasm-simd-threaded.mjs')) {
  throw new Error('Output must select the matching plain WASM runtime');
}
const files = [];
for (const name of ['kokoro.web.js', 'ort-cpu/ort-wasm-simd-threaded.mjs', 'ort-cpu/ort-wasm-simd-threaded.wasm', 'ort-cpu/LICENSE.txt']) {
  const bytes = await readFile(path.join(out, name));
  files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
const sourceFiles = [];
for (const name of ['kokoro-js/dist/kokoro.js', 'phonemizer/dist/phonemizer.js',
  '@huggingface/transformers/dist/transformers.web.js', 'onnxruntime-web/dist/ort.wasm.bundle.min.mjs']) {
  const bytes = await readFile(path.join(nm, name));
  sourceFiles.push({ path: name, sha256: sha256(bytes) });
}
const provenance = {
  schema: 1,
  purpose: 'Kokoro browser voice with the WASM-only ONNX Runtime; existing model weights and voices are unchanged.',
  build: 'tools/kokoro-cpu/build.mjs',
  packageLockSha256: sha256(lockBytes),
  dependencies, sourceFiles,
  onnxRuntime: { version: ortVersion, commit: ortCommit, license: 'MIT',
    licenseSource: `https://github.com/microsoft/onnxruntime/blob/${ortCommit}/LICENSE` },
  files,
};
await writeFile(path.join(out, 'ort-cpu/sources.json'), JSON.stringify(provenance, null, 2) + '\n');
await writeFile(path.join(out, 'build-report.json'), JSON.stringify({ files, modules, warnings }, null, 2) + '\n');
console.log(JSON.stringify({ out, files, moduleCount: modules.length, warnings }, null, 2));
