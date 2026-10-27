import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const app = new URL("../app/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("vocabulary/illustrations.json", app), "utf8"));
const dictionary = JSON.parse(await readFile(new URL("vocabulary/words.json", app), "utf8"));
const words = new Map(dictionary.words.map(word => [word.id, word]));

test("published illustration mappings match real dictionary senses and intact local raster assets", async () => {
  assert.equal(manifest.schemaVersion, 1);
  const ids = manifest.illustrations.map(item => item.wordId);
  for (const id of ["balance", "bridge", "harvest"]) assert.ok(ids.includes(id), `the hand-checked ${id} picture stays`);
  assert.equal(new Set(ids).size, ids.length, "one picture per word");
  const paths = new Set();
  for (const entry of manifest.illustrations) {
    const word = words.get(entry.wordId);
    assert.ok(word, `${entry.wordId} must exist in the real dictionary`);
    assert.equal(entry.term, word.term);
    assert.ok(word.meaning.includes(entry.sense.zh), `${entry.term}: illustrated sense must occur in its dictionary definition`);
    for (const lang of ["zh", "en"]) {
      assert.ok(entry.alt[lang]?.length > 6, `${entry.term}: descriptive ${lang} alt text`);
      assert.ok(entry.sense[lang]);
    }
    assert.match(entry.src, /^img\/vocabulary\/[a-z0-9-]+\.webp$/);
    assert.ok(!paths.has(entry.src), "each word must have an independent image");
    paths.add(entry.src);
    const image = await readFile(new URL(entry.src, app));
    assert.equal(image.toString("ascii", 0, 4), "RIFF");
    assert.equal(image.toString("ascii", 8, 12), "WEBP");
    assert.equal(image.length, entry.bytes);
    assert.equal(createHash("sha256").update(image).digest("hex"), entry.sha256);
    assert.deepEqual(entry.generation.inputImages, []);
    assert.equal(entry.generation.publicationEncoding.preserveFullFrame, true);
    if (entry.generation.tool === "image_gen.imagegen") {
      assert.equal(entry.width, 960);
      assert.equal(entry.height, 720);
      assert.equal(entry.generation.mode, "built-in");
      assert.ok(entry.generation.prompt.includes(`'${entry.term}'`));
      assert.match(entry.generation.original.sha256, /^[a-f0-9]{64}$/);
    } else {
      // Drawn locally from a written scene; must not carry text (a wrong word on a picture would mislead).
      assert.equal(entry.generation.tool, "Z-Image-Turbo");
      assert.equal(entry.generation.mode, "local");
      assert.equal(entry.generation.modelLicense, "Apache-2.0");
      assert.equal(entry.generation.textCheck, "RapidOCR: no text");
      assert.equal(entry.width, 480);
      assert.equal(entry.height, 360);
      assert.match(entry.generation.prompt, /no writing of any kind/);
      assert.ok(entry.bytes < 120_000, `${entry.term}: small enough for phones`);
    }
  }
});

test("the run-time picture index matches the manifest exactly", async () => {
  const index = JSON.parse(await readFile(new URL("vocabulary/pictures.json", app), "utf8"));
  assert.equal(index.schemaVersion, 1);
  assert.deepEqual(Object.keys(index.pictures).sort(), manifest.illustrations.map(e => e.wordId).sort());
  for (const e of manifest.illustrations) {
    assert.deepEqual(index.pictures[e.wordId], [e.src, e.width, e.height, e.term, e.sense.zh, e.sense.en, e.alt.zh, e.alt.en]);
  }
});
