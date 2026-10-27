import assert from "node:assert/strict";
import test from "node:test";
import { medianF0 } from "../app/js/pitch.js";

const voice = (f0, rate = 16000, seconds = 3) => Float32Array.from({ length: rate * seconds }, (_, i) =>
  0.3 * Math.sin(2 * Math.PI * f0 * i / rate) + 0.15 * Math.sin(4 * Math.PI * f0 * i / rate) + 0.05 * Math.sin(6 * Math.PI * f0 * i / rate));

test("median pitch is found for low and high voices without octave errors", () => {
  for (const f0 of [85, 120, 150, 200, 260]) {
    const est = medianF0(voice(f0), 16000);
    assert.ok(Math.abs(est - f0) / f0 < 0.04, `${f0} Hz read as ${est}`);
  }
});

test("silence gives no pitch", () => {
  assert.equal(medianF0(new Float32Array(16000 * 2), 16000), 0);
});
