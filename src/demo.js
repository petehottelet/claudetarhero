// Renders a 32-second synth-rock demo track with an OfflineAudioContext,
// so the game is fully playable with zero network access.

export async function renderDemoTrack() {
  const sr = 44100;
  const dur = 32;
  const ctx = new OfflineAudioContext(2, sr * dur, sr);
  const bpm = 128;
  const beat = 60 / bpm;

  const master = ctx.createGain();
  master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);

  // --- noise buffer for drums
  const noiseBuf = ctx.createBuffer(1, sr, sr);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  const kick = (t) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(1.0, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.3);
  };
  const snare = (t) => {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    s.connect(f).connect(g).connect(master);
    s.start(t); s.stop(t + 0.2);
  };
  const hat = (t, open = false) => {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 8000;
    const g = ctx.createGain();
    const d = open ? 0.25 : 0.06;
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    s.connect(f).connect(g).connect(master);
    s.start(t); s.stop(t + d + 0.02);
  };
  const bass = (t, freq, len) => {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.28, t);
    g.gain.setValueAtTime(0.28, t + len - 0.04);
    g.gain.linearRampToValueAtTime(0, t + len);
    o.connect(f).connect(g).connect(master);
    o.start(t); o.stop(t + len);
  };
  const lead = (t, freq, len) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth';
    o2.frequency.value = freq * 1.005;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.01);
    g.gain.setValueAtTime(0.16, t + len - 0.05);
    g.gain.linearRampToValueAtTime(0, t + len);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 3500;
    o.connect(g); o2.connect(g);
    g.connect(f).connect(master);
    o.start(t); o.stop(t + len);
    o2.start(t); o2.stop(t + len);
  };

  const A = 110;
  const semi = (n) => A * Math.pow(2, n / 12);
  // Am - F - C - G progression, root semitones from A2
  const prog = [0, -4, 3, -2];
  const scale = [0, 3, 5, 7, 10, 12, 15]; // A minor pentatonic-ish

  const bars = Math.floor(dur / (beat * 4)) - 1;
  let seed = 1337;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  for (let bar = 0; bar < bars; bar++) {
    const t0 = 0.5 + bar * beat * 4;
    const root = prog[bar % 4];
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * beat;
      kick(t);
      if (b % 2 === 1) snare(t);
      hat(t); hat(t + beat / 2, b === 3);
      bass(t, semi(root) / 2, beat * 0.45);
      bass(t + beat / 2, semi(root) / 2, beat * 0.3);
    }
    // lead riff: denser every other bar
    const hits = bar % 2 === 0 ? 4 : 8;
    for (let i = 0; i < hits; i++) {
      const t = t0 + (i * beat * 4) / hits;
      const deg = scale[Math.floor(rand() * scale.length)];
      lead(t, semi(root + 12 + deg), (beat * 4) / hits * 0.8);
    }
    // long power chord at section starts
    if (bar % 4 === 0) {
      lead(t0, semi(root + 12), beat * 2.5);
      lead(t0, semi(root + 19), beat * 2.5);
    }
  }

  return await ctx.startRendering();
}
