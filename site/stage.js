/* understudy.cc - the stage.
   Floorboards, footlights, and marquee bulbs, painted as dithered
   pixel art in the same language as the curtains: 4px art pixels,
   Bayer dithering, banner palette. Everything renders once and sits
   still - except the marquee bulbs, which are allowed to chase. */
(() => {
  "use strict";
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const PX = 4;

  const hex = (s, a = 255) => {
    const n = parseInt(s.slice(1), 16);
    return ((a << 24) | ((n & 255) << 16) | (n & 0xff00) | (n >>> 16)) >>> 0;
  };
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const bay = (x, y) => BAYER[((y & 3) << 2) | (x & 3)];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const hash = (a, b) => {
    let h = (a * 73856093) ^ (b * 19349663);
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  };

  // banner woods: plank browns rising into spotlit amber
  const WOOD = ["#1a0d05", "#2b1a0c", "#3c2512", "#4d2f18", "#5e3a1e", "#714724", "#8a572b", "#a86c33", "#c98a3c"].map((c) => hex(c));
  const SEAM = hex("#140a04");
  const GOLD = hex("#f5b301"), GOLD_L = hex("#ffd95c"), GOLD_D = hex("#b8860b"), GOLD_O = hex("#4a3404");
  const DIM = hex("#6b4f12"), DIM_O = hex("#352607");
  const GLOW1 = hex("#ffc850", 92), GLOW2 = hex("#ffc850", 52), GLOW3 = hex("#ffc850", 26);

  function makeLayer(host, overCss) {
    const cv = document.createElement("canvas");
    cv.setAttribute("aria-hidden", "true");
    cv.style.cssText = "position:absolute;left:0;top:" + -overCss + "px;width:100%;height:calc(100% + " + overCss + "px);image-rendering:pixelated;pointer-events:none;";
    host.prepend(cv);
    return cv;
  }

  function surface(cv, host, overCss) {
    const W = Math.max(1, Math.ceil(host.clientWidth / PX));
    const H = Math.max(1, Math.ceil((host.clientHeight + overCss) / PX));
    cv.width = W; cv.height = H;
    const img = cv.getContext("2d").createImageData(W, H);
    return { cv, W, H, img, buf: new Uint32Array(img.data.buffer) };
  }
  const blit = (s) => s.cv.getContext("2d").putImageData(s.img, 0, 0);

  // ---------- the floor: planks, spotlight pool, footlights ----------
  const GLOWB = 8; // art rows of lamp glow above the stage lip

  function renderFloor(s) {
    const { W, H, buf } = s;
    buf.fill(0);
    const lipY = GLOWB, plankTop = GLOWB + 2;
    const lampN = Math.max(4, Math.round((W * PX) / 230));
    const lamps = [];
    for (let i = 0; i < lampN; i++) lamps.push((((i + 0.5) * W) / lampN) | 0);
    // the spotlight pool sits stage right, opposite the robot,
    // and away from the text in the middle
    const poolCx = W * 0.84, poolCy = plankTop + (H - plankTop) * 0.55;

    const light = (x, y) => {
      let l = 1 - Math.hypot((x - poolCx) / (W * 0.18), (y - poolCy) / ((H - plankTop) * 0.95));
      l = l > 0 ? l * l * 1.4 : 0;
      for (const lx of lamps) {
        const d = 1 - Math.hypot((x - lx) / 10, (y - lipY) / 8);
        if (d > 0) l += d * 0.6;
      }
      return l;
    };

    // planks, in perspective: shallow boards at the back of the stage,
    // deepening toward the front, lit brighter as they near the house
    const bounds = [];
    let ph = 3.2, yy = plankTop;
    while (yy < H) { bounds.push(yy | 0); yy += ph; ph = Math.min(ph * 1.25, 11); }
    bounds.push(H + 2);
    let p = 0;
    for (let y = plankTop; y < H; y++) {
      while (y >= bounds[p + 1]) p++;
      const stagger = (hash(p, 7) * 90) | 0;
      const segLen = 22 + p * 5; // longer boards up front, too
      const depth = (y - plankTop) / (H - plankTop);
      for (let x = 0; x < W; x++) {
        const seg = ((x + stagger) / segLen) | 0;
        if ((x + stagger) % segLen === 0 || y === bounds[p + 1] - 1) { buf[y * W + x] = SEAM; continue; }
        let v = 1.7 + hash(p, seg) * 1.7;               // per-plank base tone
        if (y === bounds[p]) v += 0.7;                  // top edge catches light
        v += depth * 1.5;                               // nearer boards are brighter
        if (hash(x >> 2, y * 5 + p) < 0.07) v -= 1.1;   // grain flecks
        v += light(x, y) * 3.6;
        v += (bay(x, y) - 0.5) * 1.3;                   // dithered blend
        buf[y * W + x] = WOOD[clamp(Math.round(v), 0, WOOD.length - 1)];
      }
    }
    // stage lip: a lit rim, then the dark front edge
    for (let x = 0; x < W; x++) {
      let near = 0;
      for (const lx of lamps) near = Math.max(near, 1 - Math.abs(x - lx) / 14);
      const v = 4 + near * 3 + (bay(x, lipY) - 0.5) * 1.4;
      buf[lipY * W + x] = WOOD[clamp(Math.round(v), 0, WOOD.length - 1)];
      buf[(lipY + 1) * W + x] = SEAM;
    }
    // lamp glow rising above the lip, dithered to haze
    for (let y = 0; y < lipY; y++) {
      for (let x = 0; x < W; x++) {
        let a = 0;
        for (const lx of lamps) {
          const d = 1 - Math.hypot((x - lx) / 7, (y - lipY) / 7.5);
          if (d > a) a = d;
        }
        if (a <= 0 || a < bay(x, y)) continue;
        buf[y * W + x] = a > 0.62 ? GLOW1 : a > 0.38 ? GLOW2 : GLOW3;
      }
    }
    // the fixtures themselves: little brass domes on the lip
    for (const lx of lamps) {
      for (let dx = -2; dx <= 2; dx++) buf[(lipY - 1) * W + lx + dx] = Math.abs(dx) === 2 ? GOLD_O : GOLD;
      for (let dx = -1; dx <= 1; dx++) buf[(lipY - 2) * W + lx + dx] = dx === 0 ? GOLD_L : GOLD;
      buf[(lipY - 3) * W + lx] = GOLD_D;
      for (let dx = -2; dx <= 2; dx++) buf[lipY * W + lx + dx] = GOLD_O;
    }
    blit(s);
  }

  // ---------- marquee bulbs: round, spaced like a real sign ----------
  const B = 7, GAP = 13; // sprite size and spacing, art px

  function bulbSpots(W, H) {
    const spots = [];
    const nx = Math.max(2, Math.round((W - B) / GAP)), sx = (W - B) / nx;
    const ny = Math.max(1, Math.round((H - B) / GAP)), sy = (H - B) / ny;
    for (let i = 0; i < nx; i++) spots.push([Math.round(i * sx), 0]);
    for (let i = 0; i < ny; i++) spots.push([W - B, Math.round(i * sy)]);
    for (let i = nx; i > 0; i--) spots.push([Math.round(i * sx), H - B]);
    for (let i = ny; i > 0; i--) spots.push([0, Math.round(i * sy)]);
    return spots;
  }

  function drawBulb(s, x0, y0, lit) {
    const { W, H, buf } = s;
    const px = (dx, dy, c) => {
      const x = x0 + dx, y = y0 + dy;
      if (x >= 0 && x < W && y >= 0 && y < H) buf[y * W + x] = c;
    };
    const ring = lit ? GOLD_O : DIM_O;
    const body = lit ? GOLD : DIM;
    // round outline
    for (let i = 2; i <= 4; i++) { px(i, 0, ring); px(i, 6, ring); px(0, i, ring); px(6, i, ring); }
    px(1, 1, ring); px(5, 1, ring); px(1, 5, ring); px(5, 5, ring);
    // body, corners rounded off
    for (let dy = 1; dy <= 5; dy++)
      for (let dx = 1; dx <= 5; dx++)
        if (!((dx === 1 || dx === 5) && (dy === 1 || dy === 5))) px(dx, dy, body);
    if (lit) {
      px(2, 2, GOLD_L); px(3, 2, GOLD_L); px(2, 3, GOLD_L); // gleam
      px(4, 4, GOLD_D);
      px(3, -1, GLOW2); px(3, 7, GLOW2); px(-1, 3, GLOW2); px(7, 3, GLOW2);
      px(0, 0, GLOW3); px(6, 0, GLOW3); px(0, 6, GLOW3); px(6, 6, GLOW3);
    } else {
      px(4, 4, DIM_O);
    }
  }

  function renderMarquee(s, spots, phase) {
    s.buf.fill(0);
    spots.forEach(([x, y], i) => drawBulb(s, x, y, (i + phase) % 2 === 0));
    blit(s);
  }

  // ---------- wiring ----------
  const floorEl = document.querySelector(".floor");
  const marqueeEls = [...document.querySelectorAll(".marquee")];
  const floorCv = floorEl && makeLayer(floorEl, GLOWB * PX);
  const marquees = marqueeEls.map((el) => ({ el, cv: makeLayer(el, 0), spots: [], s: null }));
  let phase = 0;

  function renderAll() {
    if (floorCv) renderFloor(surface(floorCv, floorEl, GLOWB * PX));
    for (const m of marquees) {
      m.s = surface(m.cv, m.el, 0);
      m.spots = bulbSpots(m.s.W, m.s.H);
      renderMarquee(m.s, m.spots, phase);
    }
  }

  renderAll();
  addEventListener("load", renderAll);
  addEventListener("resize", renderAll);

  // the robot peeks out from stage left once you reach the bottom
  const robot = document.querySelector(".stage-robot");
  if (robot && floorEl) {
    new IntersectionObserver((entries, obs) => {
      if (entries[0].isIntersecting) { robot.classList.add("on-stage"); obs.disconnect(); }
    }, { threshold: 0.45 }).observe(floorEl);
  }

  if (!REDUCED) {
    setInterval(() => {
      if (document.hidden) return;
      phase ^= 1;
      for (const m of marquees) if (m.s) renderMarquee(m.s, m.spots, phase);
    }, 470);
  }
})();
