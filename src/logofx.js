// Procedural lightning for the menu logo: midpoint-displacement bolts with
// branches, drawn in three additive passes (glow / mid / white-hot core),
// flickering for a few frames and decaying into afterglow trails.

const BOLT_COLORS = ['#b14cff', '#3ef0ff', '#ff3da6'];

function makeBolt(x0, y0, x1, y1, jitter, branchChance, depth = 0) {
  // recursive midpoint displacement
  let points = [
    { x: x0, y: y0 },
    { x: x1, y: y1 },
  ];
  let offset = jitter;
  for (let iter = 0; iter < 6; iter++) {
    const next = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const mx = (a.x + b.x) / 2 + (Math.random() * 2 - 1) * offset;
      const my = (a.y + b.y) / 2 + (Math.random() * 2 - 1) * offset;
      next.push({ x: mx, y: my }, b);
    }
    points = next;
    offset *= 0.52;
  }

  const branches = [];
  if (depth < 2) {
    for (let i = 4; i < points.length - 4; i += 3) {
      if (Math.random() < branchChance) {
        const p = points[i];
        const ang = Math.atan2(y1 - y0, x1 - x0) + (Math.random() * 2 - 1) * 1.2;
        const len = (Math.random() * 0.25 + 0.12) * Math.hypot(x1 - x0, y1 - y0);
        branches.push(
          makeBolt(
            p.x, p.y,
            p.x + Math.cos(ang) * len, p.y + Math.sin(ang) * len,
            jitter * 0.5, branchChance * 0.5, depth + 1
          )
        );
      }
    }
  }
  return { points, branches, depth };
}

function drawBolt(ctx, bolt, color, alpha, coreW) {
  const trace = (pts) => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  };
  const passes = [
    { width: coreW * 7, stroke: color, blur: 24, a: 0.22 * alpha },
    { width: coreW * 2.6, stroke: color, blur: 8, a: 0.55 * alpha },
    { width: coreW, stroke: '#ffffff', blur: 0, a: alpha },
  ];
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pass of passes) {
    ctx.strokeStyle = pass.stroke;
    ctx.shadowColor = pass.stroke;
    ctx.shadowBlur = pass.blur;
    ctx.globalAlpha = pass.a;
    ctx.lineWidth = pass.width;
    trace(bolt.points);
    for (const br of bolt.branches) {
      ctx.lineWidth = pass.width * 0.55;
      trace(br.points);
      for (const br2 of br.branches) {
        ctx.lineWidth = pass.width * 0.3;
        trace(br2.points);
      }
    }
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

export function initLogoLightning(canvas, logoImg, isVisible) {
  const ctx = canvas.getContext('2d');
  let bolts = []; // { bolt, color, life, maxLife, coreW }
  let nextStrike = 0.6;
  let nextCrackle = 0.2;
  let last = performance.now();

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return true;
  }

  function strike() {
    const w = canvas.width, h = canvas.height;
    const color = BOLT_COLORS[(Math.random() * BOLT_COLORS.length) | 0];
    // strike from the top edge down to somewhere in the logo's band,
    // or arc across behind the lettering
    const arc = Math.random() < 0.35;
    let x0, y0, x1, y1;
    if (arc) {
      const side = Math.random() < 0.5 ? 0 : 1;
      x0 = side ? w * 0.04 : w * 0.96;
      y0 = h * (0.25 + Math.random() * 0.5);
      x1 = side ? w * (0.55 + Math.random() * 0.4) : w * (0.05 + Math.random() * 0.4);
      y1 = h * (0.25 + Math.random() * 0.5);
    } else {
      x0 = w * (0.12 + Math.random() * 0.76);
      y0 = 0;
      x1 = x0 + (Math.random() * 2 - 1) * w * 0.22;
      y1 = h * (0.45 + Math.random() * 0.45);
    }
    const jitter = Math.hypot(x1 - x0, y1 - y0) * 0.16;
    bolts.push({
      bolt: makeBolt(x0, y0, x1, y1, jitter, 0.6),
      color,
      life: 0,
      maxLife: 0.24 + Math.random() * 0.18,
      coreW: (1.2 + Math.random() * 1.2) * (canvas.width / 700),
    });
    // logo flash, synced to the strike
    logoImg.classList.add('flash');
    setTimeout(() => logoImg.classList.remove('flash'), 110 + Math.random() * 80);
    // occasional double strike
    if (Math.random() < 0.3) setTimeout(strike, 60 + Math.random() * 90);
  }

  // small electric arcs crawling around the lettering, always active
  function crackle() {
    const w = canvas.width, h = canvas.height;
    const color = BOLT_COLORS[(Math.random() * BOLT_COLORS.length) | 0];
    const x0 = w * (0.1 + Math.random() * 0.8);
    const y0 = h * (0.22 + Math.random() * 0.56);
    const ang = Math.random() * Math.PI * 2;
    const len = w * (0.05 + Math.random() * 0.1);
    bolts.push({
      bolt: makeBolt(x0, y0, x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len, len * 0.3, 0.35, 1),
      color,
      life: 0,
      maxLife: 0.1 + Math.random() * 0.12,
      coreW: (0.6 + Math.random() * 0.6) * (canvas.width / 700),
    });
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!isVisible() || !resize()) return;

    // decay previous frame into afterglow trails
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(0,0,0,${1 - Math.pow(0.004, dt)})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'lighter';

    nextStrike -= dt;
    if (nextStrike <= 0) {
      strike();
      nextStrike = 0.5 + Math.random() * 1.4;
    }
    nextCrackle -= dt;
    if (nextCrackle <= 0) {
      crackle();
      nextCrackle = 0.12 + Math.random() * 0.3;
    }

    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      b.life += dt;
      if (b.life >= b.maxLife) {
        bolts.splice(i, 1);
        continue;
      }
      // flicker: alpha jumps frame to frame while alive
      const k = 1 - b.life / b.maxLife;
      const flicker = 0.55 + Math.random() * 0.45;
      drawBolt(ctx, b.bolt, b.color, k * flicker, b.coreW);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  requestAnimationFrame(frame);
}
