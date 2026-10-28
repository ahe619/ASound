import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// salvageJSON lives inside the local-ai.js script closure; evaluate just that function.
const source = readFileSync(new URL("../app/js/local-ai.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const salvageJSON = new Function(`${source.match(/function salvageJSON[\s\S]*?\n  }\n/)[0]}\nreturn salvageJSON;`)();

test("a reply cut off mid-list keeps every complete field", () => {
  const cut = '{"level": 2, "scores": {"grammar": 2}, "summary": "ok", "reasons": ["one", "two", "thr';
  assert.deepEqual(salvageJSON(cut), { level: 2, scores: { grammar: 2 }, summary: "ok", reasons: ["one", "two"] });
});

test("commas inside strings are not cut points", () => {
  assert.deepEqual(salvageJSON('{"a": [1, {"b": "x, y"}, 3'), { a: [1, { b: "x, y" }] });
});

test("text with no object gives up", () => {
  assert.equal(salvageJSON("no json here"), null);
});
