// Parse Clone Hero chart files into the game's note format:
//   { notes: [{ t, lane, len }], bpm, duration, chartDifficulty, chartDifficulties }
// where t/len are seconds and lane is 0..4 (green..orange).
//
// Two formats are supported: text ".chart" (preferred) and binary ".mid".

const DIFF_ORDER = ['expert', 'hard', 'medium', 'easy'];
const td = new TextDecoder('utf-8');

export function parseChart(bytes, kind, want = 'medium', audioDuration = null) {
  const parsed = kind === 'mid'
    ? parseMidi(bytes, want, audioDuration)
    : parseDotChart(bytes, want, audioDuration);
  // Some charts trail notes past the end of the bundled audio (mismatched or
  // longer source mix). Those notes are unreachable and inflate the note total
  // so 100% accuracy becomes impossible — drop anything past the audio.
  if (audioDuration && parsed.notes.length) {
    parsed.notes = parsed.notes.filter((n) => n.t < audioDuration);
  }
  return parsed;
}

function pickDifficulty(available, want) {
  if (!available.length) return want;
  if (available.includes(want)) return want;
  const wi = DIFF_ORDER.indexOf(want);
  let best = available[0], bestDist = Infinity;
  for (const d of available) {
    const dist = Math.abs(DIFF_ORDER.indexOf(d) - wi);
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  return best;
}

// Build a tick -> seconds converter from a sorted list of tempo points.
// `points` is [{ tick, rate }] where rate is seconds-per-tick at that tick.
function makeTickToSec(points) {
  const pts = points.slice().sort((a, b) => a.tick - b.tick);
  if (pts.length === 0 || pts[0].tick !== 0) pts.unshift({ tick: 0, rate: pts[0] ? pts[0].rate : 0 });
  const cum = [{ tick: pts[0].tick, sec: 0, rate: pts[0].rate }];
  for (let i = 1; i < pts.length; i++) {
    const prev = cum[i - 1];
    const sec = prev.sec + (pts[i].tick - prev.tick) * prev.rate;
    cum.push({ tick: pts[i].tick, sec, rate: pts[i].rate });
  }
  return (tick) => {
    let i = cum.length - 1;
    while (i > 0 && cum[i].tick > tick) i--;
    return cum[i].sec + (tick - cum[i].tick) * cum[i].rate;
  };
}

// Pick a representative BPM (the tempo segment covering the most ticks).
function dominantBpm(segments, maxTick) {
  let best = segments[0] ? segments[0].bpm : 120, bestSpan = -1;
  for (let i = 0; i < segments.length; i++) {
    const end = i + 1 < segments.length ? segments[i + 1].tick : maxTick;
    const span = end - segments[i].tick;
    if (span > bestSpan) { bestSpan = span; best = segments[i].bpm; }
  }
  return best;
}

// ----------------------------------------------------------------- .chart
function parseDotChart(bytes, want, audioDuration) {
  const text = td.decode(bytes);
  const sections = {};
  const re = /\[([^\]\r\n]+)\]\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text))) sections[m[1].trim()] = m[2];

  const song = parseKeyVals(sections['Song'] || '');
  const resolution = parseInt(song.Resolution, 10) || 192;

  // tempo map from [SyncTrack] "tick = B microBpm" (bpm = value / 1000)
  const segs = [];
  for (const line of (sections['SyncTrack'] || '').split('\n')) {
    const mm = line.match(/^\s*(\d+)\s*=\s*B\s+(\d+)/);
    if (mm) segs.push({ tick: +mm[1], bpm: (+mm[2]) / 1000 });
  }
  if (!segs.length) segs.push({ tick: 0, bpm: 120 });
  segs.sort((a, b) => a.tick - b.tick);
  const tickToSec = makeTickToSec(segs.map((s) => ({ tick: s.tick, rate: 60 / (s.bpm * resolution) })));

  const SECTION = { expert: 'ExpertSingle', hard: 'HardSingle', medium: 'MediumSingle', easy: 'EasySingle' };
  const available = DIFF_ORDER.filter((d) => sections[SECTION[d]] && /=\s*N\s/.test(sections[SECTION[d]]));
  const diff = pickDifficulty(available, want);
  const body = sections[SECTION[diff]] || '';

  const notes = [];
  let maxTick = 0;
  for (const line of body.split('\n')) {
    const mm = line.match(/^\s*(\d+)\s*=\s*N\s+(\d+)\s+(\d+)/);
    if (!mm) continue;
    const tick = +mm[1], fret = +mm[2], lenTicks = +mm[3];
    let lane;
    if (fret >= 0 && fret <= 4) lane = fret;
    else if (fret === 7) lane = 0; // open note -> green
    else continue;                 // 5 = forced, 6 = tap (modifiers, not notes)
    const t = tickToSec(tick);
    const len = tickToSec(tick + lenTicks) - t;
    notes.push({ t, lane, len: len > 0.12 ? len : 0 });
    if (tick + lenTicks > maxTick) maxTick = tick + lenTicks;
  }
  notes.sort((a, b) => a.t - b.t);

  const bpm = dominantBpm(segs, maxTick || (segs.at(-1)?.tick ?? 0) + resolution);
  const duration = audioDuration || (notes.length ? notes.at(-1).t + notes.at(-1).len + 1 : 0);
  return { notes, bpm, duration, chartDifficulty: diff, chartDifficulties: available };
}

function parseKeyVals(block) {
  const o = {};
  for (const line of block.split('\n')) {
    const mm = line.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
    if (mm) o[mm[1]] = mm[2].replace(/^"|"$/g, '');
  }
  return o;
}

// ------------------------------------------------------------------- .mid
const MIDI_BASE = { expert: 96, hard: 84, medium: 72, easy: 60 };

function parseMidi(bytes, want, audioDuration) {
  const u8 = bytes;
  let p = 0;
  const readVLQ = () => {
    let v = 0, b;
    do { b = u8[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80);
    return v;
  };
  const u16 = () => { const v = (u8[p] << 8) | u8[p + 1]; p += 2; return v; };
  const u32 = () => { const v = (u8[p] * 16777216) + (u8[p + 1] << 16) + (u8[p + 2] << 8) + u8[p + 3]; p += 4; return v; };

  if (u32() !== 0x4d546864) throw new Error('Not a MIDI file (missing MThd).');
  const headerLen = u32();
  u16(); // format
  const ntracks = u16();
  let division = u16();
  if (division & 0x8000) division = 480; // SMPTE division unsupported; fall back
  p += headerLen - 6;

  const tempos = []; // { tick, us } microseconds per quarter note
  const tracks = [];
  for (let t = 0; t < ntracks; t++) {
    if (p + 8 > u8.length || u32() !== 0x4d54726b) break; // MTrk
    const len = u32();
    const end = p + len;
    let tick = 0, status = 0, name = '';
    const events = [];
    while (p < end) {
      tick += readVLQ();
      let b = u8[p++];
      if (b & 0x80) status = b; else p--; // running status
      const st = status;
      if (st === 0xff) {
        const type = u8[p++];
        const mlen = readVLQ();
        if (type === 0x51 && mlen === 3) {
          tempos.push({ tick, us: (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2] });
        } else if (type === 0x03) {
          name = td.decode(u8.subarray(p, p + mlen));
        }
        p += mlen;
      } else if (st === 0xf0 || st === 0xf7) {
        p += readVLQ();
      } else {
        const hi = st & 0xf0;
        if (hi === 0x90 || hi === 0x80) {
          const note = u8[p++], vel = u8[p++];
          events.push({ tick, note, on: hi === 0x90 && vel > 0 });
        } else if (hi === 0xc0 || hi === 0xd0) {
          p += 1;
        } else {
          p += 2;
        }
      }
    }
    p = end;
    tracks.push({ name, events });
  }

  if (!tempos.length) tempos.push({ tick: 0, us: 500000 });
  tempos.sort((a, b) => a.tick - b.tick);
  const tickToSec = makeTickToSec(tempos.map((e) => ({ tick: e.tick, rate: (e.us / 1e6) / division })));
  const segs = tempos.map((e) => ({ tick: e.tick, bpm: 60000000 / e.us }));

  const gtrack = tracks.find((tr) => /PART GUITAR$/i.test(tr.name)) ||
                 tracks.find((tr) => /GUITAR/i.test(tr.name));
  if (!gtrack) return { notes: [], bpm: 120, duration: audioDuration || 0, chartDifficulty: want, chartDifficulties: [] };

  const present = {};
  for (const e of gtrack.events) {
    for (const d of DIFF_ORDER) {
      if (e.note >= MIDI_BASE[d] && e.note <= MIDI_BASE[d] + 4) present[d] = true;
    }
  }
  const available = DIFF_ORDER.filter((d) => present[d]);
  const diff = pickDifficulty(available, want);
  const base = MIDI_BASE[diff];

  const open = {};
  const notes = [];
  let maxTick = 0;
  for (const e of gtrack.events) {
    if (e.note < base || e.note > base + 4) continue;
    const lane = e.note - base;
    if (e.on) {
      open[lane] = e.tick;
    } else if (open[lane] != null) {
      const startTick = open[lane];
      delete open[lane];
      const t = tickToSec(startTick);
      const len = tickToSec(e.tick) - t;
      notes.push({ t, lane, len: len > 0.18 ? len : 0 });
      if (e.tick > maxTick) maxTick = e.tick;
    }
  }
  notes.sort((a, b) => a.t - b.t);

  const bpm = dominantBpm(segs, maxTick || (segs.at(-1)?.tick ?? 0) + division);
  const duration = audioDuration || (notes.length ? notes.at(-1).t + notes.at(-1).len + 1 : 0);
  return { notes, bpm, duration, chartDifficulty: diff, chartDifficulties: available };
}
