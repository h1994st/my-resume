// The product page below the film (index.html: The template, How it works, Credits): the cast,
// and pen marks that draw once, when they first come into view.
//
// A pen group is an element with [data-pen-group]. What it draws, marks first, then notes, each
// in document order (nested groups draw their own):
//   [data-pen="circle|underline|strike|arrow"] marks that element; an arrow starts at
//     data-pen-from="dx dy", an offset from the element's right edge and middle; data-pen-ink
//     overrides the ink (pen.js: paper, desk, term, for marks on a terminal card).
//   [data-note="text"] writes a note beside that element: data-note-side is right, left, above, or
//     below (pen.js), or "from" (above an arrow's start); a note is kept inside its layer's width.
//   A close-up (.closeup) marks a box on a crop of the real page (.closeup-crop, inside its
//     layer): data-mark="kind x y w h" and data-crop="x y w h" are in PDF points (style.css draws
//     the crop from --x/--y/--w/--h; data-pad pads a circle, in points).
// Marks and notes go in the closest [data-pen-layer]. A group's data-pen-state is waiting, then
// drawing, then drawn. A resize redraws a drawn group at once. With reduced motion every group is
// drawn at once on load.
// [data-cast="name"] slots get a decorative cat (data-pose, default sit), idle unless reduced
// motion (style.css).
//
// initPage() → Promise, resolved once everything is set up (window.__page = { ready: true }).

import { createCat } from "./cast.js";
import { mark, markInstant, note, noteInstant } from "./pen.js";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const nums = (s) => s.trim().split(/\s+/).map(Number);
const own = (group, sel) =>
  [...group.querySelectorAll(sel)].filter((el) => el.closest("[data-pen-group]") === group);
const layerOf = (el) => el.closest("[data-pen-layer]");

// A note's top left: pen.js places it beside `at`; then it is moved left, if need be, to keep
// inside its layer's width.
function notePoint(text, at, layer, opts) {
  const probe = noteInstant(text, at, { ...opts, layer });
  const w = probe.offsetWidth;
  const x = Math.max(0, Math.min(parseFloat(probe.style.left), layer.clientWidth - w - 6));
  const y = parseFloat(probe.style.top);
  probe.remove();
  return { x, y };
}

// The group's strokes, in order: functions of (pen, { signal }) → the drawn element (or a promise
// of it), where pen is { mark, note }, animated or instant.
function strokes(group) {
  const out = [];
  if (group.matches(".closeup")) {
    const layer = group.querySelector("[data-pen-layer]");
    const crop = group.querySelector(".closeup-crop");
    const [kind, ...box] = group.dataset.mark.trim().split(/\s+/);
    const [x, y, w, h] = box.map(Number);
    const [cx, cy, cw] = nums(group.dataset.crop);
    const pad = group.dataset.pad ? Number(group.dataset.pad) : null;
    out.push((pen, opts) => {
      const k = crop.offsetWidth / cw; // px per point
      const rect = {
        x: crop.offsetLeft + (x - cx) * k,
        y: crop.offsetTop + (y - cy) * k,
        w: w * k,
        h: h * k,
      };
      return pen.mark(rect, kind, { ...opts, layer, ...(pad === null ? {} : { pad: pad * k }) });
    });
  }
  const froms = new Map();
  for (const el of own(group, "[data-pen]")) {
    const kind = el.dataset.pen;
    out.push((pen, opts) => {
      const layer = layerOf(el);
      const extra = el.dataset.penInk ? { ink: el.dataset.penInk } : {};
      if (kind === "arrow") {
        const r = el.getBoundingClientRect();
        const l = layer.getBoundingClientRect();
        const [dx, dy] = nums(el.dataset.penFrom ?? "60 -40");
        extra.from = { x: r.right - l.left + dx, y: r.top + r.height / 2 - l.top + dy };
        froms.set(el, extra.from);
      }
      return pen.mark(el, kind, { ...opts, layer, ...extra });
    });
  }
  for (const el of own(group, "[data-note]")) {
    out.push((pen, opts) => {
      const layer = layerOf(el);
      const side = el.dataset.noteSide ?? "right";
      const style = {
        size: Number(el.dataset.noteSize ?? 24),
        rotate: Number(el.dataset.noteRotate ?? -2),
      };
      let at;
      if (side === "from" && froms.has(el)) {
        const from = froms.get(el);
        const probe = noteInstant(el.dataset.note, { x: 0, y: 0 }, { ...style, layer });
        const h = probe.offsetHeight;
        probe.remove();
        at = notePoint(el.dataset.note, { x: from.x - 14, y: from.y - h - 2 }, layer, style);
      } else {
        at = notePoint(el.dataset.note, el, layer, { ...style, side, gap: 8 });
      }
      return pen.note(el.dataset.note, at, { ...opts, ...style, layer });
    });
  }
  return out;
}

const ANIMATED = { mark, note };
const INSTANT = { mark: markInstant, note: noteInstant };

function createGroup(el) {
  const steps = strokes(el);
  let drawn = []; // the marks and notes on the page
  let abort = null;
  el.dataset.penState = "waiting";

  const clear = () => {
    abort?.abort();
    abort = null;
    for (const node of drawn) node.remove();
    drawn = [];
  };
  const draw = async (animate) => {
    clear();
    if (!animate) {
      for (const step of steps) drawn.push(step(INSTANT, {}));
      el.dataset.penState = "drawn";
      return;
    }
    const ctrl = new AbortController();
    abort = ctrl;
    el.dataset.penState = "drawing";
    try {
      for (const step of steps) drawn.push(await step(ANIMATED, { signal: ctrl.signal }));
      el.dataset.penState = "drawn";
    } catch (err) {
      if (!ctrl.signal.aborted) throw err;
      // Aborted: a redraw took over.
    } finally {
      if (abort === ctrl) abort = null;
    }
  };
  return { el, draw, seen: () => el.dataset.penState !== "waiting" };
}

async function fontsReady() {
  try {
    await Promise.all([
      document.fonts.load("400 24px Caveat"),
      document.fonts.load("600 24px Caveat"),
      document.fonts.ready,
    ]);
  } catch {
    // Fallback handwriting still draws.
  }
}

export async function initPage() {
  for (const slot of document.querySelectorAll("[data-cast]")) {
    slot.append(createCat(slot.dataset.cast, { pose: slot.dataset.pose ?? "sit", label: "" }));
  }
  // Marks measure text: wait for its final fonts.
  await fontsReady();
  const groups = [...document.querySelectorAll("[data-pen-group]")].map(createGroup);
  const byEl = new Map(groups.map((g) => [g.el, g]));

  if (reducedMotion.matches) {
    for (const g of groups) g.draw(false);
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          io.unobserve(entry.target);
          byEl.get(entry.target).draw(true);
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    for (const g of groups) io.observe(g.el);
  }

  // A drawn group whose box changes size is redrawn at once; so is every drawn group when the
  // window changes size (its text may have moved inside it).
  const sizes = new Map();
  const redraw = (g) => {
    if (g.seen()) g.draw(false);
  };
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const size = `${entry.contentRect.width}×${entry.contentRect.height}`;
      const before = sizes.get(entry.target);
      sizes.set(entry.target, size);
      if (before !== undefined && before !== size) redraw(byEl.get(entry.target));
    }
  });
  for (const g of groups) ro.observe(g.el);
  let pending = 0;
  addEventListener("resize", () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => groups.forEach(redraw));
  });

  window.__page = { ready: true };
}
