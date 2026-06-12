// Turns an AudioBuffer into a playable note chart.
// Pipeline: STFT -> per-band spectral flux -> onset peak-picking ->
// tempo estimate -> 16th-note grid snap -> lane assignment -> difficulty filter.

const FFT_SIZE = 2048;
const HOP = 512;
const LANES = 5;

// ---------------------------------------------------------------- FFT
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

// ------------------------------------------------- spectral flux per band
function computeFlux(mono, sampleRate) {
  const numFrames = Math.max(0, Math.floor((mono.length - FFT_SIZE) / HOP));
  const half = FFT_SIZE / 2;
  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }
  // band edges in Hz -> bins. Roughly: kick / low / mid / high-mid / treble
  const edgesHz = [0, 120, 400, 1200, 4000, 11000];
  const edges = edgesHz.map((hz) =>
    Math.min(half, Math.round((hz / sampleRate) * FFT_SIZE))
  );

  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  let prevMag = new Float32Array(half);
  const curMag = new Float32Array(half);

  const totalFlux = new Float32Array(numFrames);
  const bandFlux = Array.from({ length: LANES }, () => new Float32Array(numFrames));

  for (let f = 0; f < numFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = mono[off + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let i = 0; i < half; i++) {
      curMag[i] = Math.hypot(re[i], im[i]);
    }
    let total = 0;
    for (let b = 0; b < LANES; b++) {
      let s = 0;
      for (let i = edges[b]; i < edges[b + 1]; i++) {
        const d = curMag[i] - prevMag[i];
        if (d > 0) s += d;
      }
      bandFlux[b][f] = s;
      total += s;
    }
    totalFlux[f] = total;
    prevMag.set(curMag);
  }
  return { totalFlux, bandFlux, frameDur: HOP / sampleRate };
}

// ------------------------------------------------------- onset peak pick
function pickOnsets(flux, frameDur) {
  const n = flux.length;
  const onsets = [];
  const W = 10; // local mean window (frames)
  for (let i = 3; i < n - 3; i++) {
    const v = flux[i];
    if (v <= 0) continue;
    let isMax = true;
    for (let k = -3; k <= 3; k++) {
      if (flux[i + k] > v) { isMax = false; break; }
    }
    if (!isMax) continue;
    let mean = 0, count = 0;
    for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) {
      mean += flux[k]; count++;
    }
    mean /= count;
    if (v > mean * 1.45 + 1e-6) {
      onsets.push({ t: i * frameDur, frame: i, strength: v / (mean + 1e-9) });
    }
  }
  return onsets;
}

// --------------------------------------------------------- tempo estimate
function estimateBpm(flux, frameDur) {
  const n = flux.length;
  const minLag = Math.round(0.3 / frameDur);  // 200 BPM
  const maxLag = Math.round(1.0 / frameDur);  // 60 BPM
  let bestLag = 0, bestVal = -Infinity;
  for (let lag = minLag; lag <= Math.min(maxLag, n - 1); lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += flux[i] * flux[i + lag];
    // mild bias toward mid tempos (~120) so we don't pick half/double time
    const bpm = 60 / (lag * frameDur);
    const bias = 1 - Math.abs(Math.log2(bpm / 120)) * 0.18;
    s *= bias;
    if (s > bestVal) { bestVal = s; bestLag = lag; }
  }
  return bestLag > 0 ? 60 / (bestLag * frameDur) : 120;
}

// --------------------------------------------------------- lane assignment
function assignLane(bandFlux, frame, prevLane, prevTime, time) {
  let best = 0, bestV = -1;
  for (let b = 0; b < LANES; b++) {
    const v = bandFlux[b][frame];
    if (v > bestV) { bestV = v; best = b; }
  }
  // keep patterns hand-friendly: limit jump size on fast successions
  if (prevLane >= 0 && time - prevTime < 0.28) {
    const diff = best - prevLane;
    if (Math.abs(diff) > 2) best = prevLane + Math.sign(diff) * 2;
  }
  return Math.max(0, Math.min(LANES - 1, best));
}

function secondLane(bandFlux, frame, lane) {
  let best = -1, bestV = -1;
  for (let b = 0; b < LANES; b++) {
    if (b === lane) continue;
    const v = bandFlux[b][frame];
    if (v > bestV) { bestV = v; best = b; }
  }
  // chords look/play best on adjacent or near frets
  if (best < 0 || Math.abs(best - lane) > 2) {
    best = lane + (lane < LANES - 1 ? 1 : -1);
  }
  return best;
}

const DIFFICULTY = {
  easy:   { minGap: 0.42, keepRatio: 0.45, chords: false },
  medium: { minGap: 0.26, keepRatio: 0.68, chords: true },
  hard:   { minGap: 0.165, keepRatio: 0.88, chords: true },
  expert: { minGap: 0.105, keepRatio: 1.0, chords: true },
};

// ------------------------------------------------------------- main entry
export function generateChart(audioBuffer, difficulty = 'medium') {
  const cfg = DIFFICULTY[difficulty] || DIFFICULTY.medium;
  const sampleRate = audioBuffer.sampleRate;

  // mono downmix
  const ch0 = audioBuffer.getChannelData(0);
  let mono = ch0;
  if (audioBuffer.numberOfChannels > 1) {
    const ch1 = audioBuffer.getChannelData(1);
    mono = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
  }

  const { totalFlux, bandFlux, frameDur } = computeFlux(mono, sampleRate);
  let onsets = pickOnsets(totalFlux, frameDur);
  const bpm = estimateBpm(totalFlux, frameDur);

  if (onsets.length === 0) return { notes: [], bpm, duration: audioBuffer.duration };

  // keep only the strongest onsets per difficulty
  if (cfg.keepRatio < 1) {
    const sorted = [...onsets].sort((a, b) => b.strength - a.strength);
    const cutoff = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * cfg.keepRatio))].strength;
    onsets = onsets.filter((o) => o.strength >= cutoff);
  }

  // snap to a 16th-note grid anchored on the strongest onset
  const grid = 60 / bpm / 4;
  const anchor = onsets.reduce((a, b) => (b.strength > a.strength ? b : a)).t;
  for (const o of onsets) {
    const snapped = anchor + Math.round((o.t - anchor) / grid) * grid;
    if (Math.abs(snapped - o.t) < grid * 0.35) o.t = snapped;
  }
  onsets.sort((a, b) => a.t - b.t);

  // enforce min gap, preferring stronger onsets
  const spaced = [];
  for (const o of onsets) {
    const last = spaced[spaced.length - 1];
    if (!last || o.t - last.t >= cfg.minGap) spaced.push(o);
    else if (o.strength > last.strength * 1.25) spaced[spaced.length - 1] = o;
  }

  // strength threshold for chords / sustains
  const strengths = spaced.map((o) => o.strength).sort((a, b) => a - b);
  const strong = strengths[Math.floor(strengths.length * 0.85)] || Infinity;

  const notes = [];
  let prevLane = -1, prevTime = -10;
  for (let i = 0; i < spaced.length; i++) {
    const o = spaced[i];
    const lane = assignLane(bandFlux, o.frame, prevLane, prevTime, o.t);
    const gapNext = (i + 1 < spaced.length ? spaced[i + 1].t : audioBuffer.duration) - o.t;

    let len = 0;
    if (gapNext > 0.9 && o.strength >= strong * 0.8) {
      len = Math.min(gapNext - 0.35, 2.2);
    }
    notes.push({ t: o.t, lane, len });

    if (cfg.chords && o.strength >= strong && gapNext > 0.3 && (i === 0 || o.t - spaced[i - 1].t > 0.3) && len === 0) {
      notes.push({ t: o.t, lane: secondLane(bandFlux, o.frame, lane), len: 0 });
    }
    prevLane = lane;
    prevTime = o.t;
  }

  // dedupe identical (t, lane)
  const seen = new Set();
  const finalNotes = notes.filter((n) => {
    const key = `${n.t.toFixed(3)}|${n.lane}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  finalNotes.sort((a, b) => a.t - b.t || a.lane - b.lane);

  return { notes: finalNotes, bpm, duration: audioBuffer.duration };
}
