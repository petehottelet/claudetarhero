// Three.js gameplay: tilted note highway, gem notes with sustain trails,
// strike-line frets, particle bursts, stage spotlights, starfield, bloom.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const LANES = 5;
const LANE_W = 2;
const HIGHWAY_W = LANES * LANE_W;
const HIGHWAY_LEN = 70;
const SPEED = 26; // world units per second
const HIT_Z = 0;

const HIT_WINDOW = 0.14;
const PERFECT_WINDOW = 0.055;
const LEAD_IN = 3.0;

const FRET_COLORS = [0x3fe34a, 0xff3b30, 0xffd60a, 0x2f7cff, 0xff9500];
const KEYS = { KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyG: 4, Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4 };

const laneX = (lane) => (lane - (LANES - 1) / 2) * LANE_W;

// ---------------------------------------------------------------- shaders
const highwayVert = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const highwayFrag = /* glsl */ `
  varying vec3 vWorld;
  uniform float uScroll;
  uniform float uBeat;
  uniform vec3 uLineColor;
  uniform float uPulse;

  void main() {
    float x = vWorld.x;
    float z = vWorld.z;

    vec3 col = vec3(0.018, 0.012, 0.045);

    // lane dividers every 2 units, edges brightest
    float fx = fract((x + 5.0) / 2.0);
    float dDiv = min(fx, 1.0 - fx) * 2.0;
    float divider = smoothstep(0.10, 0.0, dDiv);
    float edgeD = min(abs(x + 5.0), abs(x - 5.0));
    float edge = smoothstep(0.22, 0.0, edgeD);

    // beat lines scrolling toward the player
    float wz = z - uScroll;
    float fb = fract(wz / uBeat);
    float dBeat = min(fb, 1.0 - fb) * uBeat;
    float beatLine = smoothstep(0.16, 0.0, dBeat);

    // fade with distance
    float fade = smoothstep(-62.0, -8.0, z) * 0.85 + 0.15;

    col += uLineColor * divider * 0.55 * fade;
    col += uLineColor * 1.6 * edge * fade;
    col += uLineColor * beatLine * (0.22 + uPulse * 0.25) * fade;

    // subtle center sheen
    col += vec3(0.05, 0.02, 0.1) * smoothstep(5.0, 0.0, abs(x)) * 0.25 * fade;

    gl_FragColor = vec4(col, 1.0);
  }
`;

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ================================================================= Game
export class Game {
  constructor(canvas, hud) {
    this.canvas = canvas;
    this.hud = hud; // { onScore, onRock, onSP, onJudge, onBanner, onCountdown, onEnd }
    this.running = false;
    this._raf = 0;
    this._initThree();
  }

  // ------------------------------------------------------------ three.js
  _initThree() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x06030f);
    this.scene.fog = new THREE.Fog(0x06030f, 32, 78);

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 200);
    this.camera.position.set(0, 7.8, 9.5);
    this.camera.lookAt(0, 0, -16);

    this.scene.add(new THREE.AmbientLight(0x8866ff, 0.5));
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(4, 12, 6);
    this.scene.add(dir);

    this.glowTex = makeGlowTexture();

    this._buildHighway();
    this._buildFrets();
    this._buildBackground();
    this._buildPools();

    // bloom
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight), 0.9, 0.55, 0.12
    );
    this.composer.addPass(this.bloom);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.composer.setSize(window.innerWidth, window.innerHeight);
    });

    this._onKeyDown = (e) => this._keyDown(e);
    this._onKeyUp = (e) => this._keyUp(e);

    // idle render so the menu has a live background
    this._idleLoop();
  }

  _buildHighway() {
    this.highwayUniforms = {
      uScroll: { value: 0 },
      uBeat: { value: SPEED * 0.5 },
      uLineColor: { value: new THREE.Color(0x8a2be2) },
      uPulse: { value: 0 },
    };
    const geo = new THREE.PlaneGeometry(HIGHWAY_W, HIGHWAY_LEN);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.highwayUniforms,
      vertexShader: highwayVert,
      fragmentShader: highwayFrag,
    });
    const plane = new THREE.Mesh(geo, mat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(0, 0, -HIGHWAY_LEN / 2 + 5);
    this.scene.add(plane);

    // glowing side rails
    const railGeo = new THREE.BoxGeometry(0.18, 0.3, HIGHWAY_LEN);
    const railMat = new THREE.MeshBasicMaterial({ color: 0xb14cff });
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.position.set(s * (HIGHWAY_W / 2 + 0.1), 0.15, -HIGHWAY_LEN / 2 + 5);
      this.scene.add(rail);
    }
    this.railMat = railMat;
  }

  _buildFrets() {
    this.frets = [];
    for (let i = 0; i < LANES; i++) {
      const group = new THREE.Group();
      group.position.set(laneX(i), 0.12, HIT_Z);

      const ringMat = new THREE.MeshStandardMaterial({
        color: FRET_COLORS[i],
        emissive: FRET_COLORS[i],
        emissiveIntensity: 0.5,
        roughness: 0.35,
        metalness: 0.6,
      });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.09, 12, 32), ringMat);
      ring.rotation.x = -Math.PI / 2;
      group.add(ring);

      const discMat = new THREE.MeshBasicMaterial({
        color: FRET_COLORS[i],
        transparent: true,
        opacity: 0.0,
      });
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.6, 28), discMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.01;
      group.add(disc);

      this.scene.add(group);
      this.frets.push({ group, ringMat, discMat, press: 0 });
    }
  }

  _buildBackground() {
    // starfield
    const starGeo = new THREE.BufferGeometry();
    const N = 1400;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 60 + Math.random() * 90;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.9;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = Math.abs(r * Math.cos(phi)) - 8;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta) - 30;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xbbaaff, size: 0.35, map: this.glowTex,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(starGeo, starMat);
    this.scene.add(this.stars);

    // horizon glow disc
    const sun = new THREE.Mesh(
      new THREE.CircleGeometry(20, 48),
      new THREE.MeshBasicMaterial({ color: 0x5a2bd4, transparent: true, opacity: 0.35 })
    );
    sun.position.set(0, 6, -85);
    this.scene.add(sun);

    // rotating spotlight cones at the horizon
    this.spots = [];
    const coneGeo = new THREE.ConeGeometry(4.2, 46, 18, 1, true);
    const spotColors = [0xb14cff, 0x3ef0ff, 0xff3da6, 0xffd24a, 0x3ef0ff, 0xb14cff];
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: spotColors[i],
        transparent: true, opacity: 0.06,
        side: THREE.DoubleSide, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const cone = new THREE.Mesh(coneGeo, mat);
      const pivot = new THREE.Group();
      cone.position.y = -23; // apex at pivot
      pivot.add(cone);
      pivot.position.set((i - 2.5) * 9, 26, -72);
      this.scene.add(pivot);
      this.spots.push({ pivot, phase: i * 1.3, speed: 0.4 + (i % 3) * 0.18 });
    }
  }

  _buildPools() {
    // --- note gems
    this.gemPool = [];
    this.activeNotes = [];
    const baseGeo = new THREE.CylinderGeometry(0.62, 0.7, 0.26, 24);
    const capGeo = new THREE.CylinderGeometry(0.4, 0.46, 0.3, 24);
    for (let i = 0; i < 72; i++) {
      const group = new THREE.Group();
      const baseMat = new THREE.MeshStandardMaterial({ color: 0x222230, roughness: 0.3, metalness: 0.9 });
      const capMat = new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.6, roughness: 0.2,
      });
      const base = new THREE.Mesh(baseGeo, baseMat);
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.y = 0.12;
      group.add(base, cap);
      group.visible = false;
      this.scene.add(group);
      this.gemPool.push({ group, capMat, baseMat, inUse: false });
    }

    // --- sustain tails
    this.tailPool = [];
    const tailGeo = new THREE.BoxGeometry(0.4, 0.12, 1); // scaled in z
    for (let i = 0; i < 24; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 });
      const mesh = new THREE.Mesh(tailGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.tailPool.push({ mesh, mat, inUse: false });
    }

    // --- hit particles (sprites grouped by lane color)
    this.particles = [];
    for (let lane = 0; lane < LANES; lane++) {
      const mat = new THREE.SpriteMaterial({
        map: this.glowTex, color: FRET_COLORS[lane],
        transparent: true, opacity: 0.95,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
      for (let i = 0; i < 40; i++) {
        const sprite = new THREE.Sprite(mat);
        sprite.visible = false;
        this.scene.add(sprite);
        this.particles.push({ sprite, lane, vel: new THREE.Vector3(), life: 0, maxLife: 1 });
      }
    }

    // --- shockwave rings
    this.rings = [];
    const ringGeo = new THREE.TorusGeometry(0.7, 0.05, 8, 36);
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      this.scene.add(mesh);
      this.rings.push({ mesh, mat, life: 0 });
    }
  }

  // -------------------------------------------------------------- idle bg
  _idleLoop() {
    if (this.running) return;
    this._raf = requestAnimationFrame(() => this._idleLoop());
    const t = performance.now() / 1000;
    this._animateBackground(t, 1 / 60);
    this.highwayUniforms.uScroll.value = t * SPEED * 0.25;
    this.composer.render();
  }

  _animateBackground(t, dt) {
    this.stars.rotation.y = t * 0.008;
    for (const s of this.spots) {
      s.pivot.rotation.z = Math.sin(t * s.speed + s.phase) * 0.55;
      s.pivot.rotation.x = Math.cos(t * s.speed * 0.7 + s.phase) * 0.18;
    }
  }

  // ================================================================ start
  start(audioCtx, audioBuffer, chart, meta) {
    cancelAnimationFrame(this._raf);
    this.audioCtx = audioCtx;
    this.buffer = audioBuffer;
    this.chart = chart;
    this.meta = meta;
    this.duration = audioBuffer.duration;

    // audio graph: source -> lowpass (miss muffle) -> gain -> out
    this.lowpass = audioCtx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 20000;
    this.gain = audioCtx.createGain();
    this.gain.gain.value = 1;
    this.lowpass.connect(this.gain).connect(audioCtx.destination);

    this.source = audioCtx.createBufferSource();
    this.source.buffer = audioBuffer;
    this.source.connect(this.lowpass);
    this.startCtxTime = audioCtx.currentTime + LEAD_IN;
    this.source.start(this.startCtxTime);

    // state
    this.score = 0;
    this.streak = 0;
    this.maxStreak = 0;
    this.hits = 0;
    this.misses = 0;
    this.rock = 60;
    this.sp = 0;
    this.spActive = false;
    this.failed = false;
    this.ended = false;
    this.nextSpawn = 0;
    this.heldLanes = new Array(LANES).fill(false);
    this.activeSustains = [];
    this.lastCountdown = null;
    this.beatDur = 60 / (chart.bpm || 120);
    this.highwayUniforms.uBeat.value = SPEED * this.beatDur;

    for (const n of chart.notes) {
      n.hit = false; n.missed = false; n.spawned = false; n.gem = null; n.tail = null;
    }
    // reset pools
    for (const g of this.gemPool) { g.inUse = false; g.group.visible = false; }
    for (const t of this.tailPool) { t.inUse = false; t.mesh.visible = false; }

    this._missNoise = this._makeMissNoise();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    this.running = true;
    this.hud.onScore(0, 1, 0);
    this.hud.onRock(this.rock);
    this.hud.onSP(0, false);
    this._lastFrame = performance.now();
    this._loop();
  }

  _makeMissNoise() {
    const sr = this.audioCtx.sampleRate;
    const buf = this.audioCtx.createBuffer(1, sr * 0.09, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.015)) * 0.5;
    }
    return buf;
  }

  _playClank() {
    const s = this.audioCtx.createBufferSource();
    s.buffer = this._missNoise;
    const f = this.audioCtx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 300; f.Q.value = 1.5;
    const g = this.audioCtx.createGain();
    g.gain.value = 0.9;
    s.connect(f).connect(g).connect(this.audioCtx.destination);
    s.start();
  }

  _muffle() {
    const now = this.audioCtx.currentTime;
    this.lowpass.frequency.cancelScheduledValues(now);
    this.lowpass.frequency.setValueAtTime(700, now);
    this.lowpass.frequency.exponentialRampToValueAtTime(20000, now + 0.35);
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0.45, now);
    this.gain.gain.linearRampToValueAtTime(1, now + 0.3);
  }

  get songTime() {
    return this.audioCtx.currentTime - this.startCtxTime;
  }

  get multiplier() {
    const base = Math.min(4, 1 + Math.floor(this.streak / 10));
    return this.spActive ? base * 2 : base;
  }

  // ================================================================ input
  _keyDown(e) {
    if (e.repeat) return;
    if (e.code === 'Escape') { this._finish(true); return; }
    if (e.code === 'Space') {
      e.preventDefault();
      if (!this.spActive && this.sp >= 50) {
        this.spActive = true;
        this.hud.onBanner('STAR POWER!');
        this.hud.onSP(this.sp, true);
        this.hud.onScore(this.score, this.multiplier, this.streak);
      }
      return;
    }
    const lane = KEYS[e.code];
    if (lane === undefined) return;
    this.heldLanes[lane] = true;
    this.frets[lane].press = 1;
    this._tryHit(lane);
  }

  _keyUp(e) {
    const lane = KEYS[e.code];
    if (lane === undefined) return;
    this.heldLanes[lane] = false;
    // release any sustain in this lane
    this.activeSustains = this.activeSustains.filter((s) => {
      if (s.lane === lane) { this._endSustain(s); return false; }
      return true;
    });
  }

  _tryHit(lane) {
    const t = this.songTime;
    if (t < -0.5 || this.ended) return;
    let best = null, bestDt = Infinity;
    for (const n of this.chart.notes) {
      if (n.lane !== lane || n.hit || n.missed) continue;
      const dt = n.t - t;
      if (dt > HIT_WINDOW + 0.05) break; // notes sorted by time
      if (Math.abs(dt) <= HIT_WINDOW && Math.abs(dt) < bestDt) {
        best = n; bestDt = Math.abs(dt);
      }
    }
    if (!best) {
      // overstrum: break streak
      if (this.streak > 4) this.hud.onJudge('MISS', 'miss');
      this.streak = 0;
      this._playClank();
      this.hud.onScore(this.score, this.multiplier, this.streak);
      return;
    }
    this._hitNote(best, bestDt);
  }

  _hitNote(note, absDt) {
    note.hit = true;
    this.hits++;
    this.streak++;
    this.maxStreak = Math.max(this.maxStreak, this.streak);
    const perfect = absDt <= PERFECT_WINDOW;
    const base = perfect ? 75 : 50;
    this.score += base * this.multiplier;
    this.rock = Math.min(100, this.rock + 1.3);
    if (!this.spActive) this.sp = Math.min(100, this.sp + 1.6);

    this.hud.onJudge(perfect ? 'PERFECT' : 'GOOD', perfect ? 'perfect' : 'good');
    this.hud.onScore(this.score, this.multiplier, this.streak);
    this.hud.onRock(this.rock);
    this.hud.onSP(this.sp, this.spActive);
    if (this.streak > 0 && this.streak % 50 === 0) {
      this.hud.onBanner(`${this.streak} NOTE STREAK!`);
    }

    this._burst(note.lane, perfect ? 16 : 10);
    this._shockwave(note.lane);

    if (note.gem) this._recycleGem(note);
    if (note.len > 0) {
      this.activeSustains.push({ note, lane: note.lane, lastTick: this.songTime });
    } else if (note.tail) {
      this._recycleTail(note);
    }
  }

  _endSustain(s) {
    if (s.note.tail) this._recycleTail(s.note);
  }

  // ================================================================ loop
  _loop() {
    if (!this.running) return;
    this._raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    const dt = Math.min(0.05, (now - this._lastFrame) / 1000);
    this._lastFrame = now;
    const t = this.songTime;

    // countdown
    if (t < 0) {
      const n = Math.ceil(-t);
      const label = n <= 3 ? String(n) : '';
      if (label !== this.lastCountdown) {
        this.lastCountdown = label;
        this.hud.onCountdown(label);
      }
    } else if (this.lastCountdown !== 'ROCK!') {
      this.lastCountdown = 'ROCK!';
      this.hud.onCountdown('ROCK!');
      setTimeout(() => this.hud.onCountdown(''), 700);
    }

    this._spawnNotes(t);
    this._updateNotes(t);
    this._updateSustains(t, dt);
    this._updateFrets(dt);
    this._updateParticles(dt);
    this._updateRings(dt);
    this._animateBackground(now / 1000, dt);

    // highway scroll + beat pulse
    this.highwayUniforms.uScroll.value = t * SPEED;
    const beatPhase = (t / this.beatDur) % 1;
    this.highwayUniforms.uPulse.value = Math.max(0, 1 - beatPhase * 4);

    // star power drain + visuals
    if (this.spActive) {
      this.sp -= dt * 12.5;
      if (this.sp <= 0) {
        this.sp = 0;
        this.spActive = false;
        this.hud.onScore(this.score, this.multiplier, this.streak);
      }
      this.hud.onSP(this.sp, this.spActive);
    }
    const targetColor = this.spActive ? 0x3ef0ff : 0x8a2be2;
    this.highwayUniforms.uLineColor.value.lerp(new THREE.Color(targetColor), dt * 5);
    this.railMat.color.lerp(new THREE.Color(this.spActive ? 0x3ef0ff : 0xb14cff), dt * 5);
    this.bloom.strength += ((this.spActive ? 1.5 : 0.9) - this.bloom.strength) * dt * 5;

    // camera sway for life
    this.camera.position.x = Math.sin(now / 4200) * 0.35;
    this.camera.lookAt(0, 0, -16);

    this.composer.render();

    if (!this.ended && t > this.duration + 1.2) this._finish(false);
  }

  _spawnNotes(t) {
    const horizon = (HIGHWAY_LEN - 8) / SPEED; // seconds of look-ahead
    const notes = this.chart.notes;
    while (this.nextSpawn < notes.length && notes[this.nextSpawn].t - t < horizon) {
      const n = notes[this.nextSpawn++];
      const gem = this.gemPool.find((g) => !g.inUse);
      if (gem) {
        gem.inUse = true;
        n.gem = gem;
        const color = new THREE.Color(FRET_COLORS[n.lane]);
        gem.capMat.color.copy(color);
        gem.capMat.emissive.copy(color);
        gem.capMat.emissiveIntensity = 1.6;
        gem.group.visible = true;
        gem.group.position.set(laneX(n.lane), 0.2, -999);
        this.activeNotes.push(n);
      }
      if (n.len > 0) {
        const tail = this.tailPool.find((x) => !x.inUse);
        if (tail) {
          tail.inUse = true;
          n.tail = tail;
          tail.mat.color.set(FRET_COLORS[n.lane]);
          tail.mesh.visible = true;
        }
      }
    }
  }

  _updateNotes(t) {
    for (let i = this.activeNotes.length - 1; i >= 0; i--) {
      const n = this.activeNotes[i];
      const z = HIT_Z - (n.t - t) * SPEED;

      if (n.gem) {
        n.gem.group.position.z = z;
        n.gem.group.rotation.y += 0.02;
        if (!n.hit && !n.missed && t - n.t > HIT_WINDOW + 0.02) {
          // missed
          n.missed = true;
          this.misses++;
          this.streak = 0;
          this.rock = Math.max(0, this.rock - 5);
          this.hud.onJudge('MISS', 'miss');
          this.hud.onScore(this.score, this.multiplier, this.streak);
          this.hud.onRock(this.rock);
          this._muffle();
          n.gem.capMat.color.set(0x555560);
          n.gem.capMat.emissive.set(0x222228);
          n.gem.capMat.emissiveIntensity = 0.3;
          if (n.tail) this._recycleTail(n);
          if (this.rock <= 0 && !this.failed) {
            this.failed = true;
            this._finish(false);
            return;
          }
        }
        if (z > 7) {
          this._recycleGem(n);
          this.activeNotes.splice(i, 1);
          continue;
        }
      }

      if (n.tail && !n.hit) {
        // tail from note head to head + len
        const z0 = z;
        const z1 = HIT_Z - (n.t + n.len - t) * SPEED;
        const mid = (z0 + z1) / 2;
        n.tail.mesh.position.set(laneX(n.lane), 0.1, mid);
        n.tail.mesh.scale.set(1, 1, Math.abs(z0 - z1));
      }
    }
  }

  _updateSustains(t, dt) {
    for (let i = this.activeSustains.length - 1; i >= 0; i--) {
      const s = this.activeSustains[i];
      const n = s.note;
      const end = n.t + n.len;
      if (t >= end) {
        this._endSustain(s);
        this.activeSustains.splice(i, 1);
        continue;
      }
      // score trickle while held
      this.score += Math.round(30 * this.multiplier * dt);
      this.hud.onScore(this.score, this.multiplier, this.streak);
      // tail shrinks from strike line outward
      if (n.tail) {
        const z1 = HIT_Z - (end - t) * SPEED;
        const mid = (HIT_Z + z1) / 2;
        n.tail.mesh.position.set(laneX(n.lane), 0.1, mid);
        n.tail.mesh.scale.set(1, 1, Math.max(0.01, Math.abs(HIT_Z - z1)));
      }
      // sparkle at the fret while holding
      if (Math.random() < dt * 22) this._burst(n.lane, 1, 0.5);
    }
  }

  _recycleGem(n) {
    if (!n.gem) return;
    n.gem.inUse = false;
    n.gem.group.visible = false;
    n.gem = null;
  }

  _recycleTail(n) {
    if (!n.tail) return;
    n.tail.inUse = false;
    n.tail.mesh.visible = false;
    n.tail = null;
  }

  _updateFrets(dt) {
    for (let i = 0; i < LANES; i++) {
      const f = this.frets[i];
      const target = this.heldLanes[i] ? 1 : 0;
      f.press += (target - f.press) * Math.min(1, dt * 18);
      f.ringMat.emissiveIntensity = 0.5 + f.press * 2.2;
      f.discMat.opacity = f.press * 0.55;
      f.group.scale.setScalar(1 + f.press * 0.12);
    }
  }

  _burst(lane, count, scale = 1) {
    let spawned = 0;
    for (const p of this.particles) {
      if (spawned >= count) break;
      if (p.lane !== lane || p.life > 0) continue;
      spawned++;
      p.life = p.maxLife = 0.45 + Math.random() * 0.3;
      p.sprite.visible = true;
      p.sprite.position.set(laneX(lane), 0.3, HIT_Z);
      const a = Math.random() * Math.PI * 2;
      const v = (2 + Math.random() * 5) * scale;
      p.vel.set(Math.cos(a) * v, 3 + Math.random() * 5 * scale, Math.sin(a) * v * 0.5);
      p.sprite.scale.setScalar((0.5 + Math.random() * 0.5) * scale);
    }
  }

  _updateParticles(dt) {
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.sprite.visible = false; continue; }
      p.vel.y -= 16 * dt;
      p.sprite.position.addScaledVector(p.vel, dt);
      const k = p.life / p.maxLife;
      p.sprite.scale.setScalar(Math.max(0.01, k * 0.9));
    }
  }

  _shockwave(lane) {
    const r = this.rings.find((x) => x.life <= 0);
    if (!r) return;
    r.life = 0.35;
    r.mesh.visible = true;
    r.mesh.position.set(laneX(lane), 0.15, HIT_Z);
    r.mesh.scale.setScalar(0.4);
    r.mat.color.set(FRET_COLORS[lane]);
    r.mat.opacity = 0.9;
  }

  _updateRings(dt) {
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.mesh.visible = false; r.mat.opacity = 0; continue; }
      const k = 1 - r.life / 0.35;
      r.mesh.scale.setScalar(0.4 + k * 2.4);
      r.mat.opacity = 0.9 * (1 - k);
    }
  }

  // ================================================================ finish
  _finish(aborted) {
    if (this.ended) return;
    this.ended = true;
    this.running = false;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    try { this.source.stop(); } catch { /* already stopped */ }

    // clear the board
    for (const g of this.gemPool) { g.inUse = false; g.group.visible = false; }
    for (const t of this.tailPool) { t.inUse = false; t.mesh.visible = false; }
    for (const p of this.particles) { p.life = 0; p.sprite.visible = false; }
    this.activeNotes = [];
    this.activeSustains = [];

    const total = this.chart.notes.length;
    const acc = total > 0 ? this.hits / total : 0;
    this._idleLoop();
    this.hud.onEnd({
      aborted,
      failed: this.failed,
      score: this.score,
      maxStreak: this.maxStreak,
      hits: this.hits,
      total,
      accuracy: acc,
    });
  }
}
