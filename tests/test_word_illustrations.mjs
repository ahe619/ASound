import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

test("published illustration mappings match real dictionary senses and intact local raster assets", async () => {
  const app = new URL("../app/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("vocabulary/illustrations.json", app), "utf8"));
  const dictionary = JSON.parse(await readFile(new URL("vocabulary/words.json", app), "utf8"));
  const words = new Map(dictionary.words.map(word => [word.id, word]));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.illustrations.map(item => item.wordId).sort(), ["balance", "bridge", "harvest"]);
  const paths = new Set();
  for (const entry of manifest.illustrations) {
    const word = words.get(entry.wordId);
    assert.ok(word, `${entry.wordId} must exist in the real dictionary`);
    assert.equal(entry.term, word.term);
    assert.ok(word.meaning.includes(entry.sense.zh), `${entry.term}: illustrated sense must occur in its dictionary definition`);
    for (const lang of ["zh", "en"]) {
      assert.ok(entry.alt[lang]?.length > 12, `${entry.term}: descriptive ${lang} alt text`);
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
    assert.equal(entry.width, 960);
    assert.equal(entry.height, 720);
    assert.equal(entry.generation.tool, "image_gen.imagegen");
    assert.equal(entry.generation.mode, "built-in");
    assert.deepEqual(entry.generation.inputImages, []);
    assert.ok(entry.generation.prompt.includes(`'${entry.term}'`));
    assert.match(entry.generation.original.sha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.generation.publicationEncoding.preserveFullFrame, true);
  }
});
