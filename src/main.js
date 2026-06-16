import './style.css';
import { searchSongs, fetchPreview } from './itunes.js';
import { generateChart } from './analysis.js';
import { renderDemoTrack } from './demo.js';
import { parseSng } from './sng.js';
import { parseChart } from './chart.js';
import { Game } from './game.js';

const $ = (id) => document.getElementById(id);

// Track the *visible* viewport (excludes mobile browser chrome / URL bars) and
// expose it as CSS vars so the HUD and touch controls always fit on screen and
// sit above the browser chrome. visualViewport is the reliable source on mobile.
(() => {
  const root = document.documentElement;
  const sync = () => {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    const w = vv ? vv.width : window.innerWidth;
    const top = vv ? vv.offsetTop : 0;
    root.style.setProperty('--app-h', `${Math.round(h)}px`);
    root.style.setProperty('--app-w', `${Math.round(w)}px`);
    root.style.setProperty('--app-top', `${Math.round(top)}px`);
  };
  sync();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', sync);
    window.visualViewport.addEventListener('scroll', sync);
  }
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', () => setTimeout(sync, 100));
})();

const screens = {
  menu: $('screen-menu'),
  loading: $('screen-loading'),
  results: $('screen-results'),
  hud: $('hud'),
};

function show(name) {
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', k !== name);
  }
  // home link is redundant on the menu (big logo already there)
  const home = $('home-link');
  if (home) home.classList.toggle('hidden', name === 'menu');
}

let audioCtx = null;
let difficulty = 'medium';
let lastSong = null; // for retry

// ---- iOS audio unlock --------------------------------------------------
// On iOS, Web Audio is attached to the "ambient" audio session by default, so
// the hardware mute/silent switch silences it even though the AudioContext is
// "running" and source.start() fires (works fine on desktop/Android). Two
// fixes: (1) set the session type to "playback" (iOS 17+), and (2) for older
// iOS, briefly play a silent <audio> element on a user gesture to flip the
// session category. We run both on the first interactions.
function setPlaybackSession() {
  try {
    if ('audioSession' in navigator && navigator.audioSession.type !== 'playback') {
      navigator.audioSession.type = 'playback';
    }
  } catch { /* not supported — fall back to the silent-element nudge */ }
}

(() => {
  setPlaybackSession();

  let silentEl = null;
  const silentSrc = () => {
    // a ~50ms silent WAV, built in-memory (no asset needed)
    const sr = 8000, n = Math.floor(sr * 0.05);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  };

  const events = ['pointerdown', 'touchend', 'click', 'keydown'];
  const unlock = () => {
    setPlaybackSession();
    try {
      if (!silentEl) {
        silentEl = new Audio(silentSrc());
        silentEl.setAttribute('playsinline', '');
        silentEl.volume = 0.0001;
      }
      silentEl.play().catch(() => { /* gesture not strong enough yet */ });
    } catch { /* ignore */ }
    // once the real context is up and running we no longer need to nudge
    if (audioCtx && audioCtx.state === 'running') {
      for (const ev of events) window.removeEventListener(ev, unlock);
    }
  };
  for (const ev of events) window.addEventListener(ev, unlock, { passive: true });
})();

// ------------------------------------------------------------------ HUD
let judgeTimer = 0;
const hud = {
  onScore(score, mult, streak) {
    const text = score.toLocaleString();
    $('hud-score').textContent = text;
    $('m-score').textContent = text;
    const cls = game && game.spActive ? ' sp' : mult >= 4 ? ' m4' : mult >= 3 ? ' m3' : mult >= 2 ? ' m2' : '';
    const badge = $('hud-mult');
    badge.textContent = `x${mult}`;
    badge.className = 'mult-badge' + cls;
    const mMult = $('m-mult');
    mMult.textContent = `x${mult}`;
    mMult.className = 'm-mult' + cls;
    const sc = $('hud-streak');
    sc.classList.toggle('hidden', streak < 5);
    $('hud-streak-n').textContent = streak;
  },
  onRock(v) {
    $('hud-rock').style.width = `${v}%`;
    $('m-rock').style.width = `${v}%`;
  },
  onSP(v, active) {
    const fill = $('hud-sp');
    fill.style.width = `${v}%`;
    const ready = !active && v >= 50;
    fill.classList.toggle('ready', ready);
    const mSp = $('m-sp');
    mSp.style.width = `${v}%`;
    mSp.classList.toggle('ready', ready);
    mSp.classList.toggle('active', active);
    const spBtn = $('touch-sp');
    if (spBtn) {
      spBtn.classList.toggle('ready', ready);
      spBtn.classList.toggle('active', active);
    }
  },
  onJudge(text, type) {
    const el = $('hud-judge');
    el.textContent = text;
    el.className = `judge ${type}`;
    el.classList.remove('hidden');
    clearTimeout(judgeTimer);
    judgeTimer = setTimeout(() => el.classList.add('hidden'), 450);
  },
  onBanner(text) {
    const el = $('hud-banner');
    el.textContent = text;
    el.classList.remove('hidden');
    el.style.animation = 'none';
    void el.offsetWidth; // restart animation
    el.style.animation = '';
    setTimeout(() => el.classList.add('hidden'), 1600);
  },
  onCountdown(text) {
    const el = $('hud-countdown');
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  },
  onEnd(stats) {
    showResults(stats);
  },
};

const game = new Game($('gl'), hud);
window.__game = game; // debug/autoplay handle

// home link: quit any running song, then return to the menu
$('home-link').addEventListener('click', (e) => {
  e.preventDefault();
  if (game.running) game.quit(); // -> onEnd(aborted) -> results -> menu handled below
  show('menu');
});

// ---------------------------------------------------------- touch controls
// On-screen fret pads + star-power button for touch devices. They drive the
// same input API as the keyboard. Pointer events give us multi-touch (each
// finger is its own pointer) and work for mouse/pen too.
(() => {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

  for (const pad of document.querySelectorAll('.touch-fret')) {
    const lane = parseInt(pad.dataset.lane, 10);
    const press = (e) => {
      stop(e);
      pad.classList.add('pressed');
      try { pad.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
      game.pressLane(lane);
    };
    const release = (e) => {
      stop(e);
      pad.classList.remove('pressed');
      game.releaseLane(lane);
    };
    pad.addEventListener('pointerdown', press);
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);
    pad.addEventListener('contextmenu', stop);
  }

  const spBtn = $('touch-sp');
  if (spBtn) {
    spBtn.addEventListener('pointerdown', (e) => {
      stop(e);
      game.activateStarPower();
    });
    spBtn.addEventListener('contextmenu', stop);
  }
})();

// ------------------------------------------------------------------ menu
// Each chip-group (e.g. difficulty) tracks its own selection.
function bindChipGroup(rowId, attr, onSelect) {
  const row = $(rowId);
  if (!row) return;
  for (const chip of row.querySelectorAll('.chip')) {
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      row.querySelectorAll('.chip').forEach((c) => c.classList.remove('selected'));
      chip.classList.add('selected');
      onSelect(chip.dataset[attr]);
    });
  }
}
bindChipGroup('difficulty-row', 'diff', (v) => { difficulty = v; });

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const term = $('search-input').value.trim();
  if (!term) return;
  return runItunesSearch(term);
});

async function runItunesSearch(term) {
  const status = $('search-status');
  const results = $('results');
  status.textContent = 'Searching iTunes…';
  results.innerHTML = '';
  try {
    const songs = await searchSongs(term);
    if (songs.length === 0) {
      status.textContent = 'No songs with previews found. Try another search.';
      return;
    }
    status.textContent = `${songs.length} tracks — pick one to shred`;
    for (const song of songs) {
      results.appendChild(renderSongCard({
        title: song.title,
        artist: song.artist,
        artwork: song.artwork,
        onClick: () => playItunes(song),
      }));
    }
  } catch (err) {
    status.textContent = `Search failed: ${err.message}. Try the demo track below.`;
  }
}

function renderSongCard({ title, artist, artwork, onClick }) {
  const card = document.createElement('div');
  card.className = 'song-card metal-frame';
  card.innerHTML = `
    <img alt="" loading="lazy" />
    <div class="meta">
      <div class="t"></div>
      <div class="a"></div>
    </div>`;
  if (artwork) card.querySelector('img').src = artwork;
  card.querySelector('.t').textContent = title;
  card.querySelector('.a').textContent = artist;
  card.addEventListener('click', onClick);
  return card;
}

$('demo-btn').addEventListener('click', () => {
  playItunes({
    title: 'Neon Overdrive',
    artist: 'The Claudetones (built-in)',
    artwork: '',
    demo: true,
  });
});

// ------------------------------------------------------------------ play
async function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // iOS: opt into the "playback" session so the hardware mute switch doesn't
  // silence Web Audio (default "ambient" is muted by the ringer switch).
  setPlaybackSession();
  if (audioCtx.state !== 'running') {
    try { await audioCtx.resume(); } catch { /* will retry on next gesture */ }
  }
  return audioCtx;
}

function showLoading(song) {
  show('loading');
  $('loading-art').src = song.artwork || '';
  $('loading-title').textContent = `${song.title} — ${song.artist}`;
  return async (msg) => {
    $('loading-status').textContent = msg;
    await new Promise((r) => setTimeout(r, 30));
  };
}

// iTunes / demo path: 30s preview, chart synthesized from audio analysis.
async function playItunes(song) {
  lastSong = { ...song };
  const step = showLoading(lastSong);

  try {
    await ensureAudioCtx();

    let buffer;
    if (song.demo) {
      await step('Synthesizing demo track…');
      buffer = await renderDemoTrack();
    } else {
      await step('Processing 30s preview…');
      const data = await fetchPreview(song.previewUrl);
      await step('Decoding audio…');
      buffer = await audioCtx.decodeAudioData(data);
    }

    await step('Analyzing onsets & tempo…');
    const chart = generateChart(buffer, difficulty);
    if (chart.notes.length < 8) {
      throw new Error('Could not find enough beats in this track — try another song.');
    }

    await step(`Charted ${chart.notes.length} notes @ ~${Math.round(chart.bpm)} BPM. Get ready!`);
    await new Promise((r) => setTimeout(r, 600));

    $('hud-song').textContent = `${song.title} — ${song.artist} (${difficulty.toUpperCase()})`;
    $('m-song').textContent = `${song.title} — ${song.artist}`;
    show('hud');
    game.start(audioCtx, buffer, chart, song);
  } catch (err) {
    show('menu');
    $('search-status').textContent = `Couldn't load that track: ${err.message}`;
  }
}

// --------------------------------------------------- local .sng (drag & drop)
// Play a .sng package the user downloaded from enchor.us (or anywhere) by
// dropping it on the page. Everything is parsed and decoded locally in the
// browser — no upload, no network.
async function playSngFile(file) {
  if (game.running) game.quit(); // stop any in-progress song first
  const fallbackTitle = file.name.replace(/\.sng$/i, '');
  const step = showLoading({ title: fallbackTitle, artist: 'Local .sng file', artwork: '' });

  try {
    await ensureAudioCtx();

    await step('Reading .sng…');
    const ab = await file.arrayBuffer();

    await step('Unpacking .sng…');
    const sng = parseSng(ab);
    const meta = sng.metadata || {};
    const title = meta.name || fallbackTitle;
    const artist = meta.artist || 'Unknown';
    const art = albumArtUrl(sng);
    $('loading-art').src = art || '';
    $('loading-title').textContent = `${title} — ${artist}`;

    await step('Decoding audio…');
    const buffer = await decodeSngAudio(sng);

    await step('Parsing chart…');
    const chart = pickAndParseChart(sng, difficulty, buffer.duration);
    // song.ini `delay` shifts the chart relative to the audio (milliseconds)
    const offsetSec = (parseFloat(meta.delay) || 0) / 1000;
    if (offsetSec) for (const n of chart.notes) n.t += offsetSec;
    if (chart.notes.length < 4) {
      throw new Error('No playable guitar chart found in this .sng.');
    }

    const diffLabel = chart.chartDifficulty && chart.chartDifficulty !== difficulty
      ? `${chart.chartDifficulty.toUpperCase()} (no ${difficulty.toUpperCase()} chart)`
      : difficulty.toUpperCase();
    await step(`Charted ${chart.notes.length} notes @ ~${Math.round(chart.bpm)} BPM. Get ready!`);
    await new Promise((r) => setTimeout(r, 600));

    lastSong = { provider: 'sng', title, artist, artwork: art, _file: file };
    $('hud-song').textContent =
      `${title} — ${artist}` + (meta.charter ? ` [chart: ${stripTags(meta.charter)}]` : '') + ` (${diffLabel})`;
    $('m-song').textContent = `${title} — ${artist}`;
    show('hud');
    game.start(audioCtx, buffer, chart, { title, artist });
  } catch (err) {
    show('menu');
    $('search-status').textContent = `Couldn't load that .sng: ${err.message}`;
  }
}

// Chorus charter names sometimes embed <color=…> rich-text tags.
function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '').trim();
}

function albumArtUrl(sng) {
  const name = sng.fileList.find((n) => /^album\.(jpe?g|png)$/i.test(n.split('/').pop()));
  if (!name) return '';
  const bytes = sng.getFile(name);
  const mime = /\.png$/i.test(name) ? 'image/png' : 'image/jpeg';
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

// Prefer notes.chart (simpler), fall back to notes.mid.
function pickAndParseChart(sng, want, audioDuration) {
  const text = sng.findFile((n) => /(^|\/)notes\.chart$/i.test(n)) ||
               sng.findFile((n) => /\.chart$/i.test(n));
  if (text) return parseChart(text, 'chart', want, audioDuration);
  const mid = sng.findFile((n) => /(^|\/)notes\.mid$/i.test(n)) ||
              sng.findFile((n) => /\.midi?$/i.test(n));
  if (mid) return parseChart(mid, 'mid', want, audioDuration);
  return { notes: [], bpm: 120, duration: audioDuration || 0 };
}

// Clone Hero charts play every audio file at once: `song.*` carries whatever
// isn't in a dedicated stem, and `guitar.*`, `bass.*`, `drums_N.*`, `vocals.*`,
// etc. carry the rest. (Some charts even ship a near-silent `song.*` and put
// all the real audio in stems.) So we decode them all and sum-mix into one
// buffer — picking a single file would drop instruments or play silence.
// `preview.*` is deliberately excluded (it's just a 30s sampler clip).
const AUDIO_FILE_RE =
  /^(song|guitar|guitar_coop|rhythm|bass|keys?|drums?(_\d+)?|vocals?(_\d+)?|crowd)\.(opus|ogg|mp3|wav)$/i;

async function decodeOne(bytes) {
  // decodeAudioData needs its own ArrayBuffer, not a Uint8Array view
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return audioCtx.decodeAudioData(ab);
}

async function decodeSngAudio(sng) {
  const names = sng.fileList.filter((n) => AUDIO_FILE_RE.test(n.split('/').pop()));
  if (!names.length) throw new Error('No audio found inside the .sng.');

  const buffers = [];
  for (const name of names) {
    try { buffers.push(await decodeOne(sng.getFile(name))); } catch { /* skip undecodable stem */ }
  }
  if (!buffers.length) {
    throw new Error('Browser couldn\'t decode this chart\'s audio — Safari can\'t play ' +
      '.opus/.ogg, so try Chrome or Firefox.');
  }
  return buffers.length === 1 ? buffers[0] : mixBuffers(buffers);
}

function mixBuffers(buffers) {
  const sampleRate = buffers[0].sampleRate;
  const channels = Math.min(2, Math.max(...buffers.map((b) => b.numberOfChannels)));
  const frames = Math.max(...buffers.map((b) => b.length));
  const out = audioCtx.createBuffer(channels, frames, sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const dst = out.getChannelData(ch);
    for (const b of buffers) {
      const src = b.getChannelData(Math.min(ch, b.numberOfChannels - 1));
      const n = Math.min(dst.length, src.length);
      for (let i = 0; i < n; i++) dst[i] += src[i];
    }
  }
  let peak = 0;
  for (let ch = 0; ch < channels; ch++) {
    const d = out.getChannelData(ch);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  if (peak > 0.95) {
    const g = 0.95 / peak;
    for (let ch = 0; ch < channels; ch++) {
      const d = out.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
  }
  return out;
}

// ------------------------------------------------------ drag & drop a .sng
(() => {
  const overlay = $('drop-overlay');
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.classList.add('show');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.remove('show');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('show');
    const files = Array.from(e.dataTransfer?.files || []);
    const sng = files.find((f) => /\.sng$/i.test(f.name));
    if (sng) {
      playSngFile(sng);
    } else if (files.length) {
      show('menu');
      $('search-status').textContent = 'That isn\'t a .sng file — drop a chart package from enchor.us.';
    }
  });
})();

// --------------------------------------------------------------- results
function showResults(stats) {
  if (stats.aborted) {
    show('menu');
    return;
  }
  const verdict = $('results-verdict');
  if (stats.failed) {
    verdict.textContent = 'YOU GOT BOOED OFF';
    verdict.classList.add('failed');
  } else {
    verdict.textContent = 'SONG COMPLETE!';
    verdict.classList.remove('failed');
  }

  const acc = stats.accuracy;
  const starCount = stats.failed ? 0 : acc >= 0.97 ? 5 : acc >= 0.9 ? 4 : acc >= 0.75 ? 3 : acc >= 0.55 ? 2 : 1;
  $('results-stars').textContent =
    '★'.repeat(starCount) + '☆'.repeat(5 - starCount);
  $('results-song').textContent = lastSong ? `${lastSong.title} — ${lastSong.artist}` : '';
  $('stat-score').textContent = stats.score.toLocaleString();
  $('stat-streak').textContent = stats.maxStreak;
  $('stat-hits').textContent = `${stats.hits} / ${stats.total}`;
  $('stat-acc').textContent = `${Math.round(acc * 100)}%`;
  show('results');
}

$('retry-btn').addEventListener('click', () => {
  if (!lastSong) return;
  if (lastSong.provider === 'sng' && lastSong._file) playSngFile(lastSong._file);
  else playItunes(lastSong);
});
$('menu-btn').addEventListener('click', () => show('menu'));

// ---- Terms of Service modal
const tosOverlay = $('tos-overlay');
function openTos() {
  tosOverlay.hidden = false;
  tosOverlay.classList.remove('hidden');
}
function closeTos() {
  tosOverlay.hidden = true;
  tosOverlay.classList.add('hidden');
}
$('tos-link').addEventListener('click', openTos);
$('tos-close').addEventListener('click', closeTos);
tosOverlay.addEventListener('click', (e) => {
  if (e.target === tosOverlay) closeTos(); // click backdrop to dismiss
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !tosOverlay.hidden) {
    e.stopPropagation();
    closeTos();
  }
}, true);

show('menu');
