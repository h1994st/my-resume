// The film's camera: it frames a target in the film's viewport by moving the world under it.
//
// createCamera(viewport, world, { insets }) → camera
//   camera.frame(target, { padding, instant, signal, duration, maxScale }) → Promise
//     Fits `target` (an element inside the world, or a rect { x, y, w, h } in world units) into the
//     viewport's free area, centred, with `padding` px around it (default: 5% of the area's
//     shorter side, 12–56 px), and at most `maxScale` (default 2.5). The world gets a transform
//     translate(tx, ty) scale(s) (origin at its top left), so one world unit is s px on screen.
//     The move is a WAAPI animation (eased in and out; duration by distance, 700–1200 ms, unless
//     `duration` is given); a long pan pulls back a little on the way, as a camera operator would.
//     `instant`, reduced motion, or a target already in frame: the transform lands at once.
//     The promise resolves when the camera has arrived (or a newer frame() replaced the move) and
//     rejects with the signal's reason if `signal` aborts (the camera stays where it was then).
//   camera.rectOf(el) → el's layout box in world units (offsets, so actor and camera transforms
//     don't move it; a scrolled positioned ancestor, the terminal's log, does),
//     camera.scaleFor(rect, { padding, maxScale }) → the scale frame() would use for it,
//     camera.room({ padding }) → the free area less the padding (viewport px),
//     camera.toClient(rect) → where a world rect is on screen now (client px),
//     camera.area() → the free area in viewport px, camera.view → { x, y, s } (the world point
//     at the area's centre and the scale), camera.moving → whether a move is in flight.
// insets() → { top, right, bottom, left }: viewport px kept clear of the target (the caption and
// the controls overlay the bottom of the film). Everything is computed from the live viewport
// size, so the same shots work in landscape and portrait windows.

const EASE = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const SAMPLES = 32;
const MIN_MS = 700;
const MAX_MS = 1200;

// el's border box relative to `ancestor`'s padding box, from layout offsets (transform-free;
// Chrome reports the visual position of an element inside a multi-column flow), less the scroll
// of the offset parents in between (a scroll container must be positioned to count).
export function offsetRect(el, ancestor) {
  let x = 0;
  let y = 0;
  let node = el;
  while (node && node !== ancestor) {
    x += node.offsetLeft;
    y += node.offsetTop;
    const parent = node.offsetParent;
    if (parent && parent !== ancestor) {
      x += parent.clientLeft - parent.scrollLeft;
      y += parent.clientTop - parent.scrollTop;
    }
    node = parent;
  }
  if (node !== ancestor) throw new Error("offsetRect: the element is not inside its ancestor");
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

export function createCamera(viewport, world, { insets = () => ({}) } = {}) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let view = { x: 0, y: 0, s: 1 };
  let move = null; // { anim, done } of the move in flight

  function area() {
    const i = { top: 0, right: 0, bottom: 0, left: 0, ...insets() };
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    return {
      x: i.left,
      y: i.top,
      w: Math.max(1, w - i.left - i.right),
      h: Math.max(1, h - i.top - i.bottom),
    };
  }

  const transform = (v, a = area()) =>
    `translate(${a.x + a.w / 2 - v.x * v.s}px, ${a.y + a.h / 2 - v.y * v.s}px) scale(${v.s})`;

  function rectOf(el) {
    return offsetRect(el, world);
  }

  function toRect(target) {
    return target instanceof Element ? rectOf(target) : target;
  }

  function room({ padding } = {}) {
    const a = area();
    const pad = padding ?? Math.round(Math.min(56, Math.max(12, Math.min(a.w, a.h) * 0.05)));
    return { w: a.w - 2 * pad, h: a.h - 2 * pad };
  }

  function fit(r, { padding, maxScale = 2.5 } = {}) {
    const free = room({ padding });
    const s = Math.min(free.w / r.w, free.h / r.h, maxScale);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2, s: Math.max(0.02, s) };
  }

  // The view on screen right now, mid-move included.
  function current() {
    if (!move) return view;
    const m = new DOMMatrix(getComputedStyle(world).transform);
    const a = area();
    const s = m.a || view.s;
    return { x: (a.x + a.w / 2 - m.e) / s, y: (a.y + a.h / 2 - m.f) / s, s };
  }

  function settle(v) {
    view = v;
    world.style.transform = transform(v);
  }

  // Stops the move in flight where it is now.
  function halt() {
    if (!move) return;
    const here = current();
    const { anim, done } = move;
    move = null;
    anim.cancel();
    settle(here);
    done();
  }

  function frame(target, opts = {}) {
    const { instant = false, signal, duration } = opts;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const to = fit(toRect(target), opts);
    halt();
    const from = view;
    const a = area();
    // Distance in screen widths of the wider view, and the zoom in stops.
    const span = Math.max(a.w / from.s, a.w / to.s);
    const pan = Math.hypot(to.x - from.x, to.y - from.y) / span;
    const zoom = Math.abs(Math.log2(to.s / from.s));
    if (instant || reduced.matches || (pan < 0.002 && zoom < 0.01)) {
      settle(to);
      return Promise.resolve();
    }
    const ms = duration ?? Math.round(Math.min(MAX_MS, MIN_MS + 300 * pan + 220 * zoom));
    const dip = Math.min(0.3, 0.18 * Math.max(0, pan - 0.6)); // pull back on a long pan
    const keyframes = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const e = EASE(t);
      const s = from.s * (to.s / from.s) ** e * (1 - dip * Math.sin(Math.PI * t));
      // Keep the pan in step with the zoom: interpolate the centre on the eased curve.
      const v = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, s };
      keyframes.push({ transform: transform(v, a) });
    }
    return new Promise((resolve, reject) => {
      const anim = world.animate(keyframes, { duration: ms, easing: "linear", fill: "forwards" });
      const onAbort = () => {
        if (move?.anim !== anim) return;
        const here = current();
        move = null;
        anim.cancel();
        settle(here);
        reject(signal.reason);
      };
      const done = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      move = { anim, done };
      signal?.addEventListener("abort", onAbort, { once: true });
      anim.finished.then(
        () => {
          if (move?.anim !== anim) return;
          move = null;
          settle(to);
          anim.cancel();
          done();
        },
        () => {}, // cancelled: halt() or onAbort settled it
      );
    });
  }

  function toClient(r) {
    const v = current();
    const a = area();
    const box = viewport.getBoundingClientRect();
    const left = box.left + a.x + a.w / 2 + (r.x - v.x) * v.s;
    const top = box.top + a.y + a.h / 2 + (r.y - v.y) * v.s;
    const width = r.w * v.s;
    const height = r.h * v.s;
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  settle(view);
  return {
    frame,
    rectOf,
    scaleFor: (r, opts) => fit(r, opts).s,
    room,
    toClient,
    area,
    get view() {
      return current();
    },
    get moving() {
      return Boolean(move);
    },
  };
}
