// The pen: hand-drawn marks and handwritten notes over the page, in the bundled Caveat font.
//
// mark(target, kind, opts) → Promise<SVGSVGElement> draws a circle, underline, strike, or arrow over
//   `target` (an element, or a rect { x, y, w, h } in the layer's units) with a draw-on animation,
//   and resolves when it is drawn.
// note(text, at, opts) → Promise<HTMLElement> writes `text` ("\n" breaks lines) at `at`: a point
//   { x, y } (the note's top left), or an element or rect with `side` ("right", "left", "above",
//   "below") and `gap`.
// markInstant / noteInstant: the same, drawn at once (end frames). With reduced motion, mark and
//   note are instant too. clearPen(layer) removes a layer's marks and notes.
//
// Options: layer (the positioned element the mark is placed in; default: the target's closest
// [data-pen-layer], else its offset parent, else <body>), signal (an AbortSignal: aborting stops
// the drawing, removes the mark, and rejects with the signal's reason), ink ("paper", "desk", or "term" for page.js's dark mini terminal;
// default: "paper" inside a [data-paper] element: for a note, the layer it is written in; for a
// mark, its target element, else its layer), duration (ms). Marks also take pad, seed (the
// hand-drawn wobble is seeded, so the same call draws the same mark), and for arrows `from` (a
// point in layer units). Notes take size (px, default 26), rotate (deg, default -2), and weight.
// Coordinates are in the layer's own units: a scaled layer (the film's world) is measured
// unscaled, so marks stay put when the camera moves. Emoji in notes are aria-hidden.

const SVG = "http://www.w3.org/2000/svg";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const EMOJI = /(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/u;

function layerFor(target, layer) {
  if (layer) return layer;
  if (target instanceof Element) {
    return target.closest("[data-pen-layer]") ?? target.offsetParent ?? document.body;
  }
  return document.body;
}

// "paper" when `on` is inside a [data-paper] element, else "desk".
function inkFor(on, ink) {
  return ink ?? (on.closest("[data-paper]") ? "paper" : "desk");
}

// The target's box in the layer's unscaled coordinates.
function rectIn(target, layer) {
  if (!(target instanceof Element)) return { x: target.x, y: target.y, w: target.w, h: target.h };
  const t = target.getBoundingClientRect();
  const l = layer.getBoundingClientRect();
  const sx = layer.offsetWidth ? l.width / layer.offsetWidth : 1;
  const sy = layer.offsetHeight ? l.height / layer.offsetHeight : 1;
  return {
    x: (t.left - l.left) / sx - layer.clientLeft + layer.scrollLeft,
    y: (t.top - l.top) / sy - layer.clientTop + layer.scrollTop,
    w: t.width / sx,
    h: t.height / sy,
  };
}

// A small seeded generator (mulberry32), so a mark's wobble is the same on every draw.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(kind, r) {
  let h = 2166136261;
  for (const c of `${kind}:${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.w)}`) {
    h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  }
  return h;
}

const f = (n) => Math.round(n * 10) / 10;

// A smooth path through points (Catmull-Rom as cubic Béziers).
function smooth(points) {
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [
      points[i - 1] ?? points[i],
      points[i],
      points[i + 1],
      points[i + 2] ?? points[i + 1],
    ];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

// The strokes of each kind of mark, in layer units, drawn in order: [{ points, d, ms }] (ms: the
// stroke's draw-on time).
const SHAPES = {
  // A loop around the target that overshoots its start, slightly tilted, as by hand.
  circle(r, rnd, { pad = Math.max(6, r.h * 0.18) } = {}) {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const rx = r.w / 2 + pad + 2;
    const ry = r.h / 2 + pad;
    const tilt = ((rnd() - 0.5) * 4 * Math.PI) / 180;
    const start = (-2.2 + rnd() * 0.3) * Math.PI * 0.5;
    const sweep = 2 * Math.PI * 1.1;
    const points = [];
    const n = 28;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const a = start + sweep * t;
      const grow = 1 + 0.06 * t + (rnd() - 0.5) * 0.025; // a spiral: the end misses the start
      const x = Math.cos(a) * rx * grow;
      const y = Math.sin(a) * ry * grow;
      points.push([
        cx + x * Math.cos(tilt) - y * Math.sin(tilt),
        cy + x * Math.sin(tilt) + y * Math.cos(tilt),
      ]);
    }
    return [{ points, d: smooth(points), ms: 700 }];
  },
  underline(r, rnd) {
    const y = r.y + r.h + Math.max(2, r.h * 0.08);
    const points = [
      [r.x - 3, y + (rnd() - 0.5) * 2],
      [r.x + r.w * 0.5, y + 1.5 + rnd() * 1.5],
      [r.x + r.w + 4, y - 1 - rnd() * 2],
    ];
    return [{ points, d: smooth(points), ms: 380 }];
  },
  strike(r, rnd) {
    const y = r.y + r.h * 0.55;
    const points = [
      [r.x - 4, y + 1 + rnd()],
      [r.x + r.w * 0.5, y - 0.5 + (rnd() - 0.5) * 2],
      [r.x + r.w + 4, y - 1.5 - rnd()],
    ];
    return [{ points, d: smooth(points), ms: 380 }];
  },
  // A curved shaft from `from` to just outside the target, then the head.
  arrow(r, rnd, { from = { x: r.x + r.w + 70, y: r.y - 46 } } = {}) {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    // The point where the line from the target's centre to `from` leaves the box, plus a gap.
    const dx = from.x - cx;
    const dy = from.y - cy;
    const s = Math.min(
      dx ? r.w / 2 / Math.abs(dx) : Infinity,
      dy ? r.h / 2 / Math.abs(dy) : Infinity,
    );
    const len = Math.hypot(dx, dy) || 1;
    const tip = [cx + dx * s + (dx / len) * 6, cy + dy * s + (dy / len) * 6];
    const mx = (from.x + tip[0]) / 2;
    const my = (from.y + tip[1]) / 2;
    // Bowed sideways (along the shaft's normal) by about a tenth of its length.
    const shaftLen = Math.hypot(tip[0] - from.x, tip[1] - from.y) || 1;
    const bow = (0.09 + rnd() * 0.03) * shaftLen;
    const nx = -(tip[1] - from.y) / shaftLen;
    const ny = (tip[0] - from.x) / shaftLen;
    const shaft = [[from.x, from.y], [mx + nx * bow, my + ny * bow], tip];
    // The head follows the shaft's direction at the tip.
    const [px, py] = shaft[1];
    const a = Math.atan2(tip[1] - py, tip[0] - px);
    const head = 12;
    const wing = (sign) => [
      tip[0] - head * Math.cos(a + sign * 0.5),
      tip[1] - head * Math.sin(a + sign * 0.5),
    ];
    const headPts = [wing(1), tip, wing(-1)];
    return [
      { points: shaft, d: smooth(shaft), ms: 450 },
      { points: headPts, d: `M${headPts.map((p) => `${f(p[0])} ${f(p[1])}`).join(" L")}`, ms: 180 },
    ];
  },
};

function buildMark(target, kind, opts) {
  const shape = SHAPES[kind];
  if (!shape) throw new Error(`unknown pen mark: ${kind}`);
  const layer = layerFor(target, opts.layer);
  const r = rectIn(target, layer);
  const strokes = shape(r, random(opts.seed ?? seedOf(kind, r)), opts);
  const all = strokes.flatMap((s) => s.points);
  const pad = 6;
  const x0 = Math.min(...all.map((p) => p[0])) - pad;
  const y0 = Math.min(...all.map((p) => p[1])) - pad;
  const x1 = Math.max(...all.map((p) => p[0])) + pad;
  const y1 = Math.max(...all.map((p) => p[1])) + pad;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "pen-mark");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", `${f(x0)} ${f(y0)} ${f(x1 - x0)} ${f(y1 - y0)}`);
  svg.dataset.kind = kind;
  // A mark lies over its target, so an element target decides; a rect goes by the layer.
  svg.dataset.ink = inkFor(target instanceof Element ? target : layer, opts.ink);
  Object.assign(svg.style, {
    left: `${f(x0)}px`,
    top: `${f(y0)}px`,
    width: `${f(x1 - x0)}px`,
    height: `${f(y1 - y0)}px`,
  });
  const paths = strokes.map((s) => {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", s.d);
    path.setAttribute("pathLength", "1");
    svg.append(path);
    return path;
  });
  layer.append(svg);
  return { svg, paths, strokes };
}

export function markInstant(target, kind, opts = {}) {
  const { svg, paths } = buildMark(target, kind, opts);
  for (const p of paths) p.style.strokeDashoffset = "0";
  return svg;
}

// Runs the draw-on animations one after another, keeping each one's end state when `keep`; on
// abort, removes `el` and rejects.
async function play(el, steps, { signal, keep }) {
  let current;
  const stop = () => current?.cancel();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    for (const step of steps) {
      if (signal?.aborted) break;
      current = step();
      await current.finished;
      if (keep) current.commitStyles();
      current.cancel();
    }
    if (signal?.aborted) throw signal.reason;
  } catch (err) {
    el.remove();
    throw signal?.aborted ? signal.reason : err;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  return el;
}

export async function mark(target, kind, opts = {}) {
  const { signal, duration } = opts;
  if (signal?.aborted) throw signal.reason;
  if (reducedMotion.matches) return markInstant(target, kind, opts);
  const { svg, paths, strokes } = buildMark(target, kind, opts);
  const total = strokes.reduce((sum, s) => sum + s.ms, 0);
  const scale = duration ? duration / total : 1;
  const steps = paths.map(
    (path, i) => () =>
      path.animate([{ strokeDashoffset: 1.05 }, { strokeDashoffset: 0 }], {
        duration: strokes[i].ms * scale,
        easing: "cubic-bezier(0.45, 0.05, 0.35, 1)",
        fill: "forwards",
      }),
  );
  return play(svg, steps, { signal, keep: true });
}

// --- Notes ---------------------------------------------------------------------------------

function buildNote(text, at, opts) {
  const { size = 26, rotate = -2, weight = 600, side = "right", gap = 10 } = opts;
  const anchor = at instanceof Element ? at : null;
  const layer = layerFor(anchor ?? at, opts.layer);
  const note = document.createElement("p");
  note.className = "pen-note";
  // A note lies where it is written: the layer decides, not the anchor (a note beside the paper
  // is on the desk).
  note.dataset.ink = inkFor(layer, opts.ink);
  note.style.fontSize = `${size}px`;
  note.style.fontWeight = String(weight);
  note.style.rotate = `${rotate}deg`;
  for (const [i, part] of String(text).split(EMOJI).entries()) {
    if (!part) continue;
    if (i % 2) {
      const span = document.createElement("span");
      span.setAttribute("aria-hidden", "true");
      span.textContent = part;
      note.append(span);
    } else {
      note.append(part);
    }
  }
  layer.append(note);
  let x;
  let y;
  if ("w" in at || anchor) {
    const r = rectIn(at, layer);
    const w = note.offsetWidth;
    const h = note.offsetHeight;
    x = { right: r.x + r.w + gap, left: r.x - gap - w }[side] ?? r.x;
    y = { above: r.y - gap - h, below: r.y + r.h + gap }[side] ?? r.y + r.h / 2 - h / 2;
  } else {
    ({ x, y } = at);
  }
  note.style.left = `${f(x)}px`;
  note.style.top = `${f(y)}px`;
  return note;
}

export function noteInstant(text, at, opts = {}) {
  return buildNote(text, at, opts);
}

export async function note(text, at, opts = {}) {
  const { signal, duration } = opts;
  if (signal?.aborted) throw signal.reason;
  if (reducedMotion.matches) return noteInstant(text, at, opts);
  const el = buildNote(text, at, opts);
  // Written left to right, at a pace that suits handwriting.
  const ms = duration ?? Math.min(1400, Math.max(320, String(text).length * 45));
  const step = () =>
    el.animate([{ clipPath: "inset(-20% 100% -20% 0)" }, { clipPath: "inset(-20% -2% -20% 0)" }], {
      duration: ms,
      easing: "linear",
    });
  return play(el, [step], { signal, keep: false });
}

export function clearPen(layer) {
  for (const el of layer.querySelectorAll(".pen-mark, .pen-note")) el.remove();
}
