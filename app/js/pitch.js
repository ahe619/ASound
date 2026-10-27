// Voice pitch: median fundamental frequency (F0) of voiced speech, by normalized autocorrelation.
// Used to recommend an AI voice whose pitch is close to the learner's own (easier to imitate when shadowing).

// Kept cheap enough for the main thread on a phone: analysed at 8 kHz (half the lags and samples), a 20 ms hop,
// and it stops after 150 voiced frames, which is plenty for a median.
export function medianF0(input, inputRate) {
  let pcm = input, sampleRate = inputRate;
  if (inputRate >= 16000) {
    const step = Math.floor(inputRate / 8000);
    pcm = new Float32Array(Math.floor(input.length / step));
    for (let i = 0; i < pcm.length; i++) {
      let sum = 0;
      for (let k = 0; k < step; k++) sum += input[i * step + k];
      pcm[i] = sum / step; // averaging also filters out what 8 kHz cannot represent
    }
    sampleRate = inputRate / step;
  }
  const frame = Math.round(sampleRate * 0.04);
  const hop = Math.round(sampleRate * 0.02);
  const minLag = Math.floor(sampleRate / 400);   // 400 Hz upper bound
  const maxLag = Math.floor(sampleRate / 65);    // 65 Hz lower bound
  const f0s = [];
  for (let s = 0; s + frame + maxLag < pcm.length && f0s.length < 150; s += hop) {
    let energy = 0;
    for (let i = 0; i < frame; i++) energy += pcm[s + i] * pcm[s + i];
    if (energy / frame < 2e-4) continue; // silence or breath
    const rs = new Float32Array(maxLag + 1);
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0, e2 = 0;
      for (let i = 0; i < frame; i++) {
        const b = pcm[s + i + lag];
        c += pcm[s + i] * b;
        e2 += b * b;
      }
      rs[lag] = c / Math.sqrt(energy * e2 + 1e-12);
      if (rs[lag] > best) best = rs[lag];
    }
    // A voice correlates almost as well at two or three periods as at one: take the shortest period (first peak)
    // that comes within 3% of the best, or the pitch reads an octave too low.
    let bestLag = 0;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (rs[lag] >= best * 0.97 && rs[lag] >= rs[lag - 1] && rs[lag] >= rs[lag + 1]) { bestLag = lag; break; }
    }
    if (best > 0.65 && bestLag) f0s.push(sampleRate / bestLag);
  }
  if (f0s.length < 5) return 0;
  f0s.sort((a, b) => a - b);
  return f0s[Math.floor(f0s.length / 2)];
}
