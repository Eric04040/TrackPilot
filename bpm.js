'use strict';
// 0.9.70: Tempo (BPM) und Wellenform aus einem Track – gemeinsam für die Leiste (panel.js) und die Player-Leiste auf Bandcamp (bar.js).
// Schätzung: ~60 s mono, Einsatz-Hüllkurve (Bass + Gesamtsignal), Autokorrelation über 70–180 BPM mit leichter Vorliebe um 128,
// verfeinert über die Vielfachen der Periode, gefaltet in 85–175. Halbes/doppeltes Tempo bleibt möglich (Korrektur in der Leiste).
const TP_SR = 22050;   // reicht für Bassdrum und Hi-Hat, halber Speicher
const tpDecode = (ab) => new OfflineAudioContext(1, 1, TP_SR).decodeAudioData(ab);
// 400 Spitzenwerte 0..1 wie die Wellenform im TrackPilot-Player
function tpPeaks(buf, N = 400) {
  const ch = buf.getChannelData(0), step = ch.length / N, out = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    let m = 0;
    for (let j = Math.floor(i * step), end = Math.floor((i + 1) * step); j < end; j += 4) { const v = Math.abs(ch[j]); if (v > m) m = v; }
    out[i] = m;
  }
  const max = Math.max(...out) || 1;
  return out.map((v) => Math.round((v / max) * 100) / 100);
}
function tpBpm(buf) {
  const sr = buf.sampleRate;
  let n0 = Math.floor(Math.min(15, buf.duration * 0.1) * sr), n1 = Math.min(buf.length, n0 + 60 * sr);
  if (n1 - n0 < 20 * sr) { n0 = 0; n1 = Math.min(buf.length, 60 * sr); }   // kurzer Track: von vorn
  if (n1 - n0 < 6 * sr) return null;
  const chs = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const hop = Math.max(1, Math.round(sr / 172)), fps = sr / hop, F = Math.floor((n1 - n0) / hop);
  // Energie je Block: Tiefpass ~150 Hz (Bassdrum) und Gesamtsignal
  const a = Math.exp((-2 * Math.PI * 150) / sr), eL = new Float32Array(F), eA = new Float32Array(F);
  let y = 0;
  for (let f = 0, i = n0; f < F; f++) {
    let sl = 0, sa = 0;
    for (const end = i + hop; i < end; i++) {
      let x = 0;
      for (const c of chs) x += c[i];
      x /= chs.length;
      y = (1 - a) * x + a * y;
      sl += y * y; sa += x * x;
    }
    eL[f] = sl; eA[f] = sa;
  }
  const logn = (e) => { let m = 0; for (const v of e) if (v > m) m = v; return e.map((v) => Math.log1p((100 * v) / (m || 1))); };
  const lL = logn(eL), lA = logn(eA), on = new Float32Array(F);
  for (let f = 1; f < F; f++) on[f] = Math.max(0, lL[f] - lL[f - 1]) + 0.5 * Math.max(0, lA[f] - lA[f - 1]);
  // gleitenden Mittelwert (~0,4 s) abziehen – nur deutliche Einsätze bleiben
  const W = Math.round(0.2 * fps), env = new Float32Array(F);
  let s = 0;
  for (let f = 0; f < Math.min(F, W); f++) s += on[f];
  for (let f = 0; f < F; f++) {
    if (f + W < F) s += on[f + W];
    if (f - W - 1 >= 0) s -= on[f - W - 1];
    const cnt = Math.min(F - 1, f + W) - Math.max(0, f - W) + 1;
    env[f] = Math.max(0, on[f] - s / cnt);
  }
  // Autokorrelation bis zum 4-fachen der längsten Periode
  const lagMin = Math.floor((fps * 60) / 180), lagMax = Math.ceil((fps * 60) / 70), R = Math.min(F - 1, 4 * lagMax + 6), r = new Float32Array(R + 1);
  for (let L = 1; L <= R; L++) { let acc = 0; for (let f = 0; f + L < F; f++) acc += env[f] * env[f + L]; r[L] = acc / (F - L); }
  const bpmOf = (L) => (60 * fps) / L, prior = (b) => Math.exp(-0.5 * (Math.log2(b / 128) / 0.6) ** 2);
  // Auswahl über drei Nachbarn: eine Periode zwischen zwei Blöcken verteilt sich sonst auf zwei kleinere Spitzen
  const rs = (L) => r[L - 1] + r[L] + r[L + 1];
  let best = 0, bestS = 0;
  for (let L = lagMin; L <= lagMax; L++) {
    const sc = rs(L) * prior(bpmOf(L));
    if (sc > bestS && rs(L) >= rs(L - 1) && rs(L) >= rs(L + 1)) { bestS = sc; best = L; }
  }
  if (!best) return null;
  // Spitze genauer: Parabel an den Vielfachen k·L (k = 1..4), Periode = Σ lag_k / Σ k
  const peak = (c, w) => {
    let m = c;
    for (let L = Math.max(1, c - w); L <= Math.min(R - 1, c + w); L++) if (r[L] > r[m]) m = L;
    if (m <= 1 || m >= R) return m;
    const d = r[m - 1] - 2 * r[m] + r[m + 1];
    return d < 0 ? m + (0.5 * (r[m - 1] - r[m + 1])) / d : m;
  };
  let sumL = 0, sumK = 0, p = peak(best, 1);
  for (let k = 1; k <= 4 && Math.round(k * p) + k + 1 < R; k++) { const lk = k === 1 ? p : peak(Math.round(k * p), k); sumL += lk; sumK += k; }
  let bpm = bpmOf(sumL / sumK);
  while (bpm < 85) bpm *= 2;
  while (bpm > 175) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}
async function tpAnalyze(ab) {
  const buf = await tpDecode(ab);
  return { bpm: tpBpm(buf), peaks: tpPeaks(buf), dur: buf.duration };
}
