// Full-screen procedural lightning for the menu.
//
// Bolts are generated with recursive midpoint displacement and then *grow*
// downward from the top edge of the screen — a leader tip races toward the
// ground over a few frames instead of the whole bolt popping in at once.
// Each frame's draw is faded (not cleared) so the descending tip leaves a
// glowing trail behind it, then the spent bolt decays into afterglow.

const BOLT_COLORS = ['#b14cff', '#3ef0ff', '#cdb4ff', '#9d6bff', '#7ad7ff'];

// Recursive midpoint displacement. Returns a bolt whose points carry a
// cumulative arc-length `d` so we can reveal it progressively, plus branches
// that each know the arc-length at which they sprout off the parent.
function makeBolt(x0, y0, x1, y1, jitter, branchChance, depth = 0) {
  let points = [
    { x: x0, y: y0 },
    { x: x1, y: y1 },
  ];
  let offset = jitter;
  for (let iter = 0; iter < 7; iter++) {
    const next = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      // displace perpendicular to the segment for natural-looking kinks
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const disp = (Math.random() * 2 - 1) * offset;
      next.push(
        { x: (a.x + b.x) / 2 + nx * disp, y: (a.y + b.y) / 2 + ny * disp },
        b
      );
    }
    points = next;
    offset *= 0.55;
  }

  // cumulative arc length along the bolt
  let total = 0;
  points[0].d = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    points[i].d = total;
  }

  const branches = [];
  if (depth < 2) {
    for (let i = 4; i < points.length - 4; i += 3) {
      if (Math.random() < branchChance) {
        const p = points[i];
        const baseAng = Math.atan2(y1 - y0, x1 - x0);
        const ang = baseAng + (Math.random() * 2 - 1) * 0.9;
        const blen = (Math.random() * 0.28 + 0.14) * Math.hypot(x1 - x0, y1 - y0);
        const br = makeBolt(
          p.x, p.y,
          p.x + Math.cos(ang) * blen, p.y + Math.sin(ang) * blen,
          jitter * 0.45, branchChance * 0.5, depth + 1
        );
        br.startLen = p.d; // sprout once the leader has descended this far
        branches.push(br);
      }
    }
  }
  return { points, branches, total, depth };
}

// Stroke a bolt but only up to `revealLen` of its arc length.
function tracePartial(ctx, points, revealLen) {
  if (revealLen <= 0) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.d <= revealLen) {
      ctx.lineTo(p.x, p.y);
    } else {
      const prev = points[i - 1];
      const seg = p.d - prev.d;
      const t = seg > 0 ? (revealLen - prev.d) / seg : 0;
      ctx.lineTo(prev.x + (p.x - prev.x) * t, prev.y + (p.y - prev.y) * t);
      break;
    }
  }
  ctx.stroke();
}

// Three additive passes: wide soft glow, mid halo, white-hot core.
function drawBolt(ctx, bolt, color, alpha, coreW, revealLen) {
  const passes = [
    { width: coreW * 8, stroke: color, blur: 26, a: 0.18 * alpha },
    { width: coreW * 2.8, stroke: color, blur: 10, a: 0.5 * alpha },
    { width: coreW, stroke: '#ffffff', blur: 4, a: alpha },
  ];
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pass of passes) {
    ctx.strokeStyle = pass.stroke;
    ctx.shadowColor = pass.stroke;
    ctx.shadowBlur = pass.blur;
    ctx.globalAlpha = pass.a;
    ctx.lineWidth = pass.width;
    tracePartial(ctx, bolt.points, revealLen);
    for (const br of bolt.branches) {
      if (revealLen <= br.startLen) continue;
      ctx.lineWidth = pass.width * 0.55;
      tracePartial(ctx, br.points, revealLen - br.startLen);
      for (const br2 of br.branches) {
        if (revealLen - br.startLen <= br2.startLen) continue;
        ctx.lineWidth = pass.width * 0.3;
        tracePartial(ctx, br2.points, revealLen - br.startLen - br2.startLen);
      }
    }
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

export function initLightning(canvas, logoImg, isVisible) {
  const ctx = canvas.getContext('2d');
  const bolts = []; // { bolt, color, life, growDur, maxLife, coreW }
  let nextStrike = 0.4;
  let flash = 0; // full-screen brightness flash, decays each frame
  let last = performance.now();

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return true;
  }

  function strike(forkOfMain) {
    const w = canvas.width, h = canvas.height;
    const color = BOLT_COLORS[(Math.random() * BOLT_COLORS.length) | 0];
    // always born at the very top edge, descending into / past the logo band
    const x0 = w * (0.08 + Math.random() * 0.84);
    const y0 = 0;
    const drop = h * (0.55 + Math.random() * 0.45);
    const x1 = x0 + (Math.random() * 2 - 1) * w * 0.26;
    const y1 = Math.min(h, drop);
    const jitter = Math.hypot(x1 - x0, y1 - y0) * 0.14;

    const span = Math.hypot(x1 - x0, y1 - y0);
    bolts.push({
      bolt: makeBolt(x0, y0, x1, y1, jitter, 0.62),
      color,
      life: 0,
      // descent speed roughly constant — taller bolts take a touch longer
      growDur: 0.05 + (span / Math.max(1, h)) * 0.06,
      maxLife: 0.34 + Math.random() * 0.2,
      coreW: (1.3 + Math.random() * 1.3) * (w / 1400),
    });

    // strike-synced flash + logo brightness pop
    flash = Math.max(flash, 0.28 + Math.random() * 0.22);
    if (logoImg) {
      logoImg.classList.add('flash');
      setTimeout(() => logoImg.classList.remove('flash'), 100 + Math.random() * 80);
    }

    // occasional rapid restrike down (roughly) the same channel
    if (!forkOfMain && Math.random() < 0.32) {
      setTimeout(() => isVisible() && strike(true), 55 + Math.random() * 90);
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!isVisible() || !resize()) return;

    // fade the previous frame instead of clearing -> descending tip leaves a
    // glowing trail, dead bolts melt into afterglow.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(0,0,0,${1 - Math.pow(0.0015, dt)})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // full-screen flash bloom
    if (flash > 0.001) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
      g.addColorStop(0, `rgba(150,120,255,${flash})`);
      g.addColorStop(0.5, `rgba(90,70,180,${flash * 0.35})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      flash *= Math.pow(0.0008, dt); // fast decay
    }

    ctx.globalCompositeOperation = 'lighter';

    nextStrike -= dt;
    if (nextStrike <= 0) {
      strike(false);
      nextStrike = 0.7 + Math.random() * 2.0;
    }

    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      b.life += dt;
      if (b.life >= b.maxLife) {
        bolts.splice(i, 1);
        continue;
      }
      const grown = Math.min(1, b.life / b.growDur);
      const revealLen = b.bolt.total * grown;
      let alpha;
      if (b.life < b.growDur) {
        alpha = 0.85 + Math.random() * 0.15; // bright descending leader
      } else {
        const afterT = (b.life - b.growDur) / (b.maxLife - b.growDur);
        alpha = (1 - afterT) * (0.5 + Math.random() * 0.5); // flicker + decay
      }
      drawBolt(ctx, b.bolt, b.color, alpha, b.coreW, revealLen);
    }

    ctx.globalCompositeOperation = 'source-over';
  }
  requestAnimationFrame(frame);
}
