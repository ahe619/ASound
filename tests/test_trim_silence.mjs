import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// trimSilence lives inside the voice-input.js script closure; evaluate just that function.
const source = readFileSync(new URL("../app/js/voice-input.js", import.meta.url), "utf8");
const trimSilence = new Function(`const RATE = 16000;
const rmsOf = (f) => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / f.length); };
${source.match(/function trimSilence[\s\S]*?\n  }\n/)[0]}
return trimSilence;`)();
const RATE = 16000;
const noise = (seconds) => Float32Array.from({ length: seconds * RATE }, (_, i) => Math.sin(i * 12.9898) * 0.002);

test("tap-to-talk audio keeps the speech and a quarter second around it, ignoring a click", () => {
  const audio = noise(3);
  audio[1000] = 0.9; audio[1001] = -0.9;
  for (let i = RATE; i < 1.8 * RATE; i++) audio[i] = 0.3 * Math.sin(i / 7);
  const out = trimSilence(audio);
  assert.ok(Math.abs(out.length / RATE - 1.3) < 0.05, `kept ${out.length / RATE} s`);
  assert.ok(Math.abs(out[0.25 * RATE + 20]) > 0.001, "speech starts after the leading margin");
});

test("silence or a very short clip is returned unchanged", () => {
  const quiet = noise(2);
  assert.equal(trimSilence(quiet).length, quiet.length);
  const short = noise(0.1);
  assert.equal(trimSilence(short).length, short.length);
});
