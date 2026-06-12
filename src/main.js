import './style.css';
import { searchSongs, fetchPreview } from './itunes.js';
import { generateChart } from './analysis.js';
import { renderDemoTrack } from './demo.js';
import { Game } from './game.js';

const $ = (id) => document.getElementById(id);

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
}

let audioCtx = null;
let difficulty = 'medium';
let lastSong = null; // for retry

// ------------------------------------------------------------------ HUD
let judgeTimer = 0;
const hud = {
  onScore(score, mult, streak) {
    $('hud-score').textContent = score.toLocaleString();
    const badge = $('hud-mult');
    badge.textContent = `x${mult}`;
    badge.className = 'mult-badge' +
      (game && game.spActive ? ' sp' : mult >= 4 ? ' m4' : mult >= 3 ? ' m3' : mult >= 2 ? ' m2' : '');
    const sc = $('hud-streak');
    sc.classList.toggle('hidden', streak < 5);
    $('hud-streak-n').textContent = streak;
  },
  onRock(v) {
    $('hud-rock').style.width = `${v}%`;
  },
  onSP(v, active) {
    const fill = $('hud-sp');
    fill.style.width = `${v}%`;
    fill.classList.toggle('ready', !active && v >= 50);
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

// ------------------------------------------------------------------ menu
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('selected'));
    chip.classList.add('selected');
    difficulty = chip.dataset.diff;
  });
}

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const term = $('search-input').value.trim();
  if (!term) return;
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
      const card = document.createElement('div');
      card.className = 'song-card';
      card.innerHTML = `
        <img src="${song.artwork}" alt="" loading="lazy" />
        <div class="meta">
          <div class="t"></div>
          <div class="a"></div>
        </div>`;
      card.querySelector('.t').textContent = song.title;
      card.querySelector('.a').textContent = song.artist;
      card.addEventListener('click', () => playSong(song));
      results.appendChild(card);
    }
  } catch (err) {
    status.textContent = `Search failed: ${err.message}. Try the demo track below.`;
  }
});

$('demo-btn').addEventListener('click', () => {
  playSong({
    title: 'Neon Overdrive',
    artist: 'The Claudetones (built-in)',
    artwork: '',
    demo: true,
  });
});

// ------------------------------------------------------------------ play
async function playSong(song) {
  lastSong = song;
  show('loading');
  $('loading-art').src = song.artwork || '';
  $('loading-title').textContent = `${song.title} — ${song.artist}`;
  const status = $('loading-status');
  const step = async (msg) => {
    status.textContent = msg;
    await new Promise((r) => setTimeout(r, 30)); // let the UI paint
  };

  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    let buffer;
    if (song.demo) {
      await step('Synthesizing demo track…');
      buffer = await renderDemoTrack();
    } else {
      await step('Downloading 30s preview…');
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
    show('hud');
    game.start(audioCtx, buffer, chart, song);
  } catch (err) {
    show('menu');
    $('search-status').textContent = `Couldn't load that track: ${err.message}`;
  }
}

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
  if (lastSong) playSong(lastSong);
});
$('menu-btn').addEventListener('click', () => show('menu'));

show('menu');
