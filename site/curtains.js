/* understudy.cc - the curtains.
   Verlet cloth rendered as dithered pixel-art velvet.
   The whole performance is the opening: heavy fabric drags, the hem
   slides along the stage floor, the tieback catches and cinches the
   waist, a tassel drops and swings. Then - like a real theater - the
   curtains hang still. The simulation freezes a few seconds after the
   open completes and costs nothing from then on. */
(() => {
  "use strict";
  const canvas = document.getElementById("curtains");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const PX = 4;        // css px per art pixel
  const OPEN_MS = 2000;
  const SETTLE_MS = 2600;

  // ---- palette (banner reds, ABGR for little-endian Uint32) ----
  const hex = (s) => {
    const n = parseInt(s.slice(1), 16);
    return ((255 << 24) | ((n & 255) << 16) | (n & 0xff00) | (n >>> 16)) >>> 0;
  };
  const RAMP = ["#3c060b", "#5b0a10", "#7c1014", "#9d151d", "#bb2029", "#d8443a"].map(hex);
  const OUT = hex("#26030a");
  const GOLD = hex("#f5b301"), GOLD_D = hex("#b8860b"), GOLD_L = hex("#ffd95c"), GOLD_O = hex("#5f4304");

  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const bay = (x, y) => BAYER[((y & 3) << 2) | (x & 3)];
  const slub = (x, y) => ((((x * 73856093) ^ (y * 19349663)) >>> 13) & 7) === 0 ? -0.45 : 0;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
  const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

  let W = 0, H = 0, img, buf;

  const shade = (v, x, y) => {
    v = clamp(v + slub(x, y), 0, RAMP.length - 1.001);
    const i = v | 0;
    return RAMP[i + (v - i > bay(x, y) ? 1 : 0)];
  };

  // ---- ambient drift; only audible while the curtain is in motion ----
  let T = 0;
  const windBase = (seed) => Math.sin(T * 0.9 + seed * 1.9) * 0.6 + Math.sin(T * 0.41 + seed * 0.7) * 0.4;

  // ---- verlet chain ----
  function makeChain(n, x0, len) {
    const c = { n, seg: len / (n - 1), x: new Float32Array(n), y: new Float32Array(n), px: new Float32Array(n), py: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      c.x[i] = c.px[i] = x0;
      c.y[i] = c.py[i] = i * c.seg;
    }
    return c;
  }

  function profile(keys, p) {
    let i = 1;
    while (i < keys.length - 1 && keys[i][0] < p) i++;
    const [p0, v0] = keys[i - 1], [p1, v1] = keys[i];
    const t = clamp((p - p0) / (p1 - p0), 0, 1);
    return lerp(v0, v1, (1 - Math.cos(Math.PI * t)) / 2);
  }

  // ---- one curtain; x is distance-from-own-edge, mirrored at draw ----
  const WING_KEYS = [[0, 0.98], [0.16, 1.12], [0.56, 0.40], [0.8, 0.62], [1, 0.92]];
  const LEG_KEYS = [[0, 1], [0.5, 0.88], [1, 1.05]];

  function makeCurtain(side) {
    const unit = clamp(innerWidth * 0.07, 34, 118) / PX;
    const cinched = unit >= 12;
    const K = clamp(Math.round(unit / 4.5), 3, 7);
    const fr = [];
    for (let k = 0; k < K; k++) {
      let f = Math.pow((k + 1) / K, 0.85);
      if (k < K - 1) f += (((k * 2654435761) >>> 8) % 100 / 100 - 0.5) * 0.07;
      fr.push(clamp(f, 0.12, 1));
    }
    fr[K - 1] = 1;
    const c = {
      side, unit, cinched, K, fr,
      yTie: Math.floor(H * 0.56),
      panelW: W * 0.535,
      chains: [], rx: [], hemAt: new Float32Array(Math.ceil(W * 0.56) + 4),
      lift: 0, ibx: 0, // smoothed hem state: inner-corner lift + position
      tassel: makeChain(6, 0, 10), tasselLive: false,
    };
    // just enough slack to pool slightly; the gentle mid-drag lift comes
    // from the elastic lower segments, not from spare cloth
    const len = H * 1.045;
    for (let k = 0; k < K; k++) {
      c.chains.push(makeChain(26, fr[k] * c.panelW, len));
      c.rx.push(new Float32Array(H));
    }
    return c;
  }

  function restX(c, k, y, open) {
    const wing = c.fr[k] * c.unit * profile(c.cinched ? WING_KEYS : LEG_KEYS, y / H);
    return lerp(c.fr[k] * c.panelW, wing, open);
  }

  const cinchAmount = (c, open) => (c.cinched ? smooth01((open - 0.88) / 0.12) : 0);

  function stepCurtain(c, open, windAmp, damp) {
    const cinchT = cinchAmount(c, open);
    for (let k = 0; k < c.K; k++) {
      const ch = c.chains[k];
      const seed = k * 1.9 + (c.side < 0 ? 2.7 : 0);
      for (let i = 1; i < ch.n; i++) {
        const y = ch.y[i];
        const free = (0.25 + 0.75 * (y / H)) * (1 - cinchT * (y < c.yTie ? 0.85 : 0.25));
        // the cinch ramps in smoothly - a hard switch here is exactly
        // the hem kink seen at three quarters through the open
        const spring = y < c.yTie ? lerp(0.07, 0.22, cinchT) : lerp(0.07, 0.06, cinchT);
        const fx = windBase(seed) * 0.05 * windAmp * free + (restX(c, k, y, open) - ch.x[i]) * spring;
        const fy = 0.22;
        let vx = (ch.x[i] - ch.px[i]) * damp, vy = (ch.y[i] - ch.py[i]) * damp;
        const sp = Math.hypot(vx, vy);
        if (sp > 1.8) { vx *= 1.8 / sp; vy *= 1.8 / sp; }
        const nx = ch.x[i] + vx + fx;
        const ny = ch.y[i] + vy + fy;
        ch.px[i] = ch.x[i]; ch.py[i] = ch.y[i];
        ch.x[i] = nx; ch.y[i] = ny;
      }
      // constraints; the lower quarter resolves softly, so when the
      // cloth runs out of slack mid-drag the hem stretches and lifts
      // gradually instead of snapping off the floor
      const softFrom = (ch.n * 0.72) | 0;
      ch.x[0] = restX(c, k, 0, open); ch.y[0] = 0;
      for (let r = 0; r < 4; r++) {
        for (let i = 1; i < ch.n; i++) {
          let dx = ch.x[i] - ch.x[i - 1], dy = ch.y[i] - ch.y[i - 1];
          const d = Math.hypot(dx, dy) || 1e-4;
          const off = ((d - ch.seg) / d) * (i > softFrom ? 0.75 : 1);
          const w0 = i === 1 ? 0 : 0.5, w1 = i === 1 ? 1 : 0.5;
          ch.x[i - 1] += dx * off * w0; ch.y[i - 1] += dy * off * w0;
          ch.x[i] -= dx * off * w1; ch.y[i] -= dy * off * w1;
        }
        ch.x[0] = restX(c, k, 0, open); ch.y[0] = 0;
        // the hem may lie flat but never fold back upward; excess cloth
        // spreads sideways into a train instead of buckling into a pile
        for (let i = softFrom; i < ch.n; i++) {
          if (ch.y[i] < ch.y[i - 1] - 0.4) ch.y[i] = ch.y[i - 1] - 0.4;
        }
      }
      for (let i = 1; i < ch.n; i++) {
        if (!isFinite(ch.x[i]) || !isFinite(ch.y[i])) {
          ch.x[i] = ch.px[i] = restX(c, k, i * ch.seg, open);
          ch.y[i] = ch.py[i] = Math.min(i * ch.seg, H - 1.5);
          continue;
        }
        if (ch.y[i] > H - 1.5) { ch.y[i] = H - 1.5; ch.px[i] = lerp(ch.px[i], ch.x[i], 0.7); }
        ch.x[i] = clamp(ch.x[i], 1.5, W * 0.56);
      }
    }
    // folds resist crossing - softly, and never at the pooled hem,
    // or the edge clamp turns the pushes into a slow net drift
    for (let k = 0; k + 1 < c.K; k++) {
      const a = c.chains[k], b = c.chains[k + 1];
      for (let i = 1; i < a.n; i++) {
        if (a.y[i] > H - 4) continue;
        const gap = b.x[i] - a.x[i];
        if (gap < 0.8) { const push = (0.8 - gap) * 0.3; a.x[i] -= push; b.x[i] += push; }
      }
    }
    // the tassel drops in when the cord catches the fabric
    if (cinchT > 0.85) {
      const knotX = sampleRow(c, c.K - 1, c.yTie) + 3.5;
      const t = c.tassel;
      if (!c.tasselLive) { for (let i = 0; i < t.n; i++) { t.x[i] = t.px[i] = knotX; t.y[i] = t.py[i] = c.yTie + 1; } c.tasselLive = true; }
      stepTassel(t, knotX, c.yTie + 1, windAmp);
    }
  }

  function stepTassel(t, pinX, pinY, windAmp) {
    for (let i = 1; i < t.n; i++) {
      const fx = windBase(i) * 0.032 * windAmp;
      const nx = t.x[i] + (t.x[i] - t.px[i]) * 0.94 + fx;
      const ny = t.y[i] + (t.y[i] - t.py[i]) * 0.94 + 0.3;
      t.px[i] = t.x[i]; t.py[i] = t.y[i];
      t.x[i] = nx; t.y[i] = ny;
    }
    t.x[0] = pinX; t.y[0] = pinY;
    for (let r = 0; r < 3; r++) {
      for (let i = 1; i < t.n; i++) {
        let dx = t.x[i] - t.x[i - 1], dy = t.y[i] - t.y[i - 1];
        const d = Math.hypot(dx, dy) || 1e-4;
        const off = (d - t.seg) / d;
        const w0 = i === 1 ? 0 : 0.5, w1 = i === 1 ? 1 : 0.5;
        t.x[i - 1] += dx * off * w0; t.y[i - 1] += dy * off * w0;
        t.x[i] -= dx * off * w1; t.y[i] -= dy * off * w1;
      }
      t.x[0] = pinX; t.y[0] = pinY;
    }
  }

  function sampleRow(c, k, row) {
    return c.rx[k][clamp(row, 0, H - 1)];
  }

  function sampleCurtain(c) {
    // fold ridge x per row; below the freeze line the ridges run straight
    // down, so raw chain endpoints never reach the renderer - they are
    // where every hem artifact has come from
    const yF = Math.max(0, H - Math.max(12, H * 0.1)) | 0;
    for (let k = 0; k < c.K; k++) {
      const ch = c.chains[k], rx = c.rx[k];
      let i = 1;
      for (let row = 0; row <= yF; row++) {
        while (i < ch.n - 1 && ch.y[i] < row) i++;
        if (ch.y[i] < row) { rx[row] = ch.x[ch.n - 1]; continue; }
        const y0 = ch.y[i - 1], y1 = ch.y[i];
        rx[row] = y1 > y0 ? lerp(ch.x[i - 1], ch.x[i], clamp((row - y0) / (y1 - y0), 0, 1)) : ch.x[i];
      }
      for (let row = yF + 1; row < H; row++) rx[row] = rx[yF];
    }
    // the hem is one analytic curve: flat on the floor, then a single
    // smooth rise to the inner corner. Physics drives it through two
    // low-pass-filtered scalars, so it can never tear or kink.
    const ch = c.chains[c.K - 1];
    let deep = 0;
    for (let i = ch.n - 7; i < ch.n; i++) deep = Math.max(deep, ch.y[i]);
    c.lift += (clamp(H - 1.5 - deep, 0, H) - c.lift) * 0.12;
    const ibxNow = c.rx[c.K - 1][yF] + 3;
    c.ibx = c.ibx ? c.ibx + (ibxNow - c.ibx) * 0.3 : ibxNow;
    const hem = c.hemAt, maxX = hem.length;
    const liftY = H - 1.5 - c.lift;
    const curveW = Math.max(6, c.lift * 1.4);
    const x0 = c.ibx - curveW;
    for (let x = 0; x < maxX; x++) {
      hem[x] = x >= c.ibx ? liftY : lerp(H - 1.5, liftY, smooth01((x - x0) / curveW));
    }
  }

  function pset(xd, y, color, side) {
    const sx = side > 0 ? xd : W - 1 - xd;
    if (sx >= 0 && sx < W && y >= 0 && y < H) buf[y * W + sx] = color;
  }

  function drawCurtain(c, open) {
    const side = c.side;
    for (let y = 0; y < H; y++) {
      const ie = Math.round(c.rx[c.K - 1][y]) + 3;
      for (let xd = 0; xd <= ie; xd++) {
        const hy = c.hemAt[Math.min(xd, c.hemAt.length - 1)];
        const onFloor = hy > H - 2.6;
        if (!onFloor && y > hy) continue;
        let col;
        if (!onFloor && y > hy - 1) col = OUT;
        else if (!onFloor && y > hy - 3) col = shade(0.7, xd, y);
        else if (xd === ie) col = OUT;
        else if (xd >= ie - 2) col = bay(xd, y) > 0.5 ? GOLD : GOLD_D;
        else {
          let k = 0;
          while (k + 1 < c.K && c.rx[k + 1][y] < xd) k++;
          const r0 = k === 0 ? 0 : c.rx[k][y];
          const r1 = c.rx[Math.min(k + 1, c.K - 1)][y];
          const span = Math.max(r1 - r0, 0.001);
          let b;
          if (xd < c.rx[0][y]) b = 0.25;
          else if (span < 2.5) b = 0.3;
          else b = 0.5 + 0.5 * Math.cos(2 * Math.PI * (clamp((xd - r0) / span, 0, 1) - 0.1));
          const g = 0.5 + 0.8 * Math.pow(xd / ie, 1.1);
          let v = (0.25 + 0.75 * b) * g * 5.2;
          if (!onFloor && y > hy - 6) v *= 0.85;
          if (onFloor && y >= H - 2) v *= 0.8; // floor contact shadow
          col = shade(v, xd, y);
        }
        pset(xd, y, col, side);
      }
    }
    if (cinchAmount(c, open) > 0.85) {
      const knotX = Math.round(sampleRow(c, c.K - 1, c.yTie)) + 2;
      for (let xd = 0; xd <= knotX; xd++) {
        const yc = c.yTie + 1 - Math.round((1 - xd / knotX) * 3);
        pset(xd, yc, GOLD_D, side);
        pset(xd, yc + 1, GOLD, side);
      }
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          pset(knotX + dx, c.yTie + 1 + dy, (dx + dy) & 1 ? GOLD_D : GOLD, side);
      if (c.tasselLive) drawTassel(c.tassel, side);
    }
  }

  function drawTassel(t, side) {
    for (let i = 1; i < 3; i++) {
      pset(Math.round(t.x[i]), Math.round(t.y[i]), GOLD_D, side);
      pset(Math.round((t.x[i] + t.x[i - 1]) / 2), Math.round((t.y[i] + t.y[i - 1]) / 2), GOLD_D, side);
    }
    const hx = Math.round(t.x[2]), hy2 = Math.round(t.y[2]);
    for (let dy = 0; dy < 2; dy++) for (let dx = -1; dx < 2; dx++) {
      pset(hx + dx, hy2 + dy, dy === 0 && dx === 0 ? GOLD_L : GOLD, side);
    }
    const sx = Math.round(t.x[4]), sy = Math.round(t.y[4]);
    const widths = [5, 5, 4, 4, 3];
    for (let r = 0; r < widths.length; r++) {
      const w = widths[r], x0 = sx - (w >> 1);
      pset(x0 - 1, sy + r, OUT, side);
      pset(x0 + w, sy + r, OUT, side);
      for (let dx = 0; dx < w; dx++) {
        const colr = r === widths.length - 1 ? GOLD_O : (dx + r) & 1 ? GOLD_D : GOLD;
        pset(x0 + dx, sy + r, colr, side);
      }
    }
    for (let dx = -1; dx <= widths[4]; dx++) pset(sx - (widths[4] >> 1) + dx, sy + widths.length, OUT, side);
  }

  // ---- valance: swagged drapes across the top, tassels at the cusps ----
  let valTassels = [], swagN = 3;
  function buildValance() {
    const n = Math.max(3, Math.round((W * PX) / 300));
    valTassels = [];
    for (let i = 1; i < n; i++) valTassels.push({ chain: makeChain(5, (i * W) / n, 7) });
    return n;
  }

  function drawValance(windAmp) {
    const sw = W / swagN;
    for (let x = 0; x < W; x++) {
      const idx = Math.min(swagN - 1, Math.floor(x / sw));
      const u = x / sw - idx;
      const ripple = Math.sin(T * 1.1 + idx * 2.1) * 0.6 * windAmp;
      const yb = 4 + 8 * Math.pow(Math.sin(Math.PI * u), 0.85) + ripple * Math.sin(Math.PI * u);
      for (let y = 0; y <= yb + 1; y++) {
        let col;
        if (y === 0) col = OUT;
        else if (y > yb) col = (x & 1) ? GOLD_D : 0;
        else if (y > yb - 1) col = GOLD;
        else {
          const d = y / Math.max(yb, 1);
          const fan = 0.5 + 0.5 * Math.cos(2 * Math.PI * (u * 4.5 + d * 0.8 * (u - 0.5)));
          let v = (0.3 + 0.7 * fan) * (0.55 + 0.55 * d) * 5.2;
          if (u < 0.04 || u > 0.96) v = 0.6;
          col = shade(v, x, y);
        }
        if (col) buf[y * W + x] = col;
      }
    }
    for (const t of valTassels) {
      stepTassel(t.chain, t.chain.x[0], 4, windAmp);
      drawTassel(t.chain, 1);
    }
  }

  // ---- orchestration ----
  let curtains = [], openStart = 0, raf = 0, last = 0, acc = 0, frozen = false;

  function rebuild() {
    W = Math.ceil(innerWidth / PX);
    H = Math.ceil(innerHeight / PX);
    canvas.width = W; canvas.height = H;
    img = ctx.createImageData(W, H);
    buf = new Uint32Array(img.data.buffer);
    curtains = [makeCurtain(1), makeCurtain(-1)];
    swagN = buildValance();
  }

  function render(open, windAmp) {
    buf.fill(0);
    for (const c of curtains) { sampleCurtain(c); drawCurtain(c, open); }
    drawValance(windAmp);
    ctx.putImageData(img, 0, 0);
  }

  // run the sim to rest and paint a single settled frame
  function settleSync() {
    for (let i = 0; i < 320; i++) { T += 1 / 60; for (const c of curtains) stepCurtain(c, 1, 0, 0.92); }
    render(1, 0);
  }

  function frame(now) {
    if (frozen) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(now - last, 100); last = now;
    acc += dt;
    const open = ease((now - openStart) / OPEN_MS);
    const fade = clamp((now - openStart - OPEN_MS) / 1400, 0, 1);
    let steps = 0;
    while (acc >= 1000 / 60 && steps < 3) {
      T += 1 / 60;
      for (const c of curtains) stepCurtain(c, open, 1 - fade, lerp(0.94, 0.90, fade));
      acc -= 1000 / 60; steps++;
    }
    if (acc >= 1000 / 60) acc = 0;
    render(open, 1 - fade);
    if (open >= 1 && now > openStart + OPEN_MS + SETTLE_MS) {
      frozen = true;
      cancelAnimationFrame(raf);
    }
  }

  function start() {
    rebuild();
    if (REDUCED) { settleSync(); return; }
    openStart = performance.now() + 350;
    last = performance.now();
    raf = requestAnimationFrame(frame);
    document.addEventListener("visibilitychange", () => {
      if (frozen) return;
      cancelAnimationFrame(raf);
      if (!document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); }
    });
  }

  addEventListener("resize", () => {
    const opened = REDUCED || frozen || performance.now() > openStart + OPEN_MS;
    rebuild();
    if (opened) {
      settleSync(); // jump straight to the settled tableau at the new size
      if (!frozen) { cancelAnimationFrame(raf); frozen = true; }
    }
    // mid-open: rebuilt closed; the running loop carries it from here
  });

  start();
})();
