// Voice pitch: median fundamental frequency (F0) of voiced speech, by normalized autocorrelation.
// Used to recommend an AI voice whose pitch is close to the learner's own (easier to imitate when shadowing).

export function medianF0(pcm, sampleRate) {
  const frame = Math.round(sampleRate * 0.04);
  const hop = Math.round(sampleRate * 0.01);
  const minLag = Math.floor(sampleRate / 400);   // 400 Hz upper bound
  const maxLag = Math.floor(sampleRate / 65);    // 65 Hz lower bound
  const f0s = [];
  for (let s = 0; s + frame + maxLag < pcm.length; s += hop) {
    let energy = 0;
    for (let i = 0; i < frame; i++) energy += pcm[s + i] * pcm[s + i];
    if (energy / frame < 2e-4) continue; // silence or breath
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0, e2 = 0;
      for (let i = 0; i < frame; i++) {
        const b = pcm[s + i + lag];
        c += pcm[s + i] * b;
        e2 += b * b;
      }
      const r = c / Math.sqrt(energy * e2 + 1e-12);
      if (r > best) { best = r; bestLag = lag; }
    }
    if (best > 0.65 && bestLag) f0s.push(sampleRate / bestLag);
  }
  if (f0s.length < 5) return 0;
  f0s.sort((a, b) => a - b);
  return f0s[Math.floor(f0s.length / 2)];
}
