// The launch film's scenes (played by film.js): the actors on the desk, the cue kinds, and the
// storyline as data. film.js documents the contract (scene, step, shot, cue, and actor shapes);
// this file fills it. Adding a scene is data, plus a cue or actor kind if it needs a new one.
//
// World units are CSS px of the desk at scale 1: a resume page is 816 × 1056. Positions `at` are
// { x, y, w?, h?, r? (deg), z? }. The pen writes in the world (desk ink) or, with `on: actorId`,
// in an actor's own layer (a paper actor: paper ink, and the mark moves with the paper).
//
// Actor kinds (ACTORS): cat { name, pose, label }, copy { file, headline } (a stray resume copy;
// its file name starts empty for a type cue), resume { state, highlight } (the replica, both
// pages; `el.resume` is its createResume API, `el.dataset.state` its state; a kept replica is
// updated to exactly what create + mount would build), posting (the Granary & Sons job), paws { from,
// to } (a trail of prints, in world units), terminal (a desk card around createTerminal; Task 3
// styles it).
//
// Cue kinds (CUES), each with an animated `run` and an `instant` end state:
//   enter { id, kind, at, from?, props?, fresh? }  puts an actor on the desk; `from` { dx, dy,
//       r, s, o } is where it comes from (default: fades in). A kept actor (see film.js) moves
//       to `at` instead (a cat walks); `fresh: true` lets it go and enters it anew.
//   exit { id, to? }                     takes it off (`to` as `from`)
//   move { id, at, walk?, duration? }    moves it (FLIP); `walk` hops like a cat
//   pose { id, pose }                    a cat's pose (resolves after one cycle; use wait: false)
//   type { target, text, cps? }          types text into an element, a caret while typing
//   mark { target, kind, on?, from?, grow?, ink?, pad?, seed?, duration? }   a pen mark, in the target's
//       pen layer unless `on` names an actor or "world"; `from` (arrows) is a point in the
//       layer's units or a target (the arrow starts at its edge facing the mark's target);
//       `grow` (world units, or { top, right, bottom, left }; negative shrinks) widens the target
//       (an arrow then stops short of it; an underline with a negative bottom sits closer)
//   note { id?, text, at, side?, gap?, size?, rotate?, weight?, on?, ink? }   a pen note; `at` is
//       a point { x, y } (top left) or a target with `side`
//   resume { id, state, highlight?, animate? }   the replica's state (resume-data.js keys)
//   proof { id, show }                   crossfades the replica's page 1 to img/tailored-1.png
//   terminal { id, lines }               plays terminal lines (terminal.js) in a terminal actor
//   wait { ms }
// Left for the scenes that need them (Task 3): stamp, confetti.

import { createCat } from "./cast.js";
import { clearPen, mark, markInstant, note, noteInstant } from "./pen.js";
import { createResume } from "./resume.js";
import { createTerminal } from "./terminal.js";

const EASE_OUT = "cubic-bezier(0.2, 0.75, 0.25, 1)";
const EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)";

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

function h(tag, className, html) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (html !== undefined) el.innerHTML = html;
  return el;
}

// Resolves when the animation finishes; rejects (and cancels it) when the signal aborts.
function finish(anim, signal) {
  return new Promise((resolve, reject) => {
    const reason = () => signal?.reason ?? new DOMException("Animation cancelled", "AbortError");
    if (signal?.aborted) {
      anim.cancel();
      return reject(reason());
    }
    const stop = () => anim.cancel();
    signal?.addEventListener("abort", stop, { once: true });
    anim.finished.then(
      () => {
        signal?.removeEventListener("abort", stop);
        resolve();
      },
      () => reject(reason()),
    );
  });
}

const rotOf = (el) => parseFloat(el.style.rotate) || 0;
// Where an actor is (its inline place, as film.js sets it).
const placeOf = (el) => ({
  x: parseFloat(el.style.left) || 0,
  y: parseFloat(el.style.top) || 0,
  r: rotOf(el),
});

function slide(el, { dx = 0, dy = 0, r = 0, s = 1, o = 0 } = {}, signal, out = false) {
  const base = rotOf(el);
  const away = {
    translate: `${dx}px ${dy}px`,
    rotate: `${base + r}deg`,
    scale: String(s),
    opacity: o,
  };
  const home = { translate: "0px 0px", rotate: `${base}deg`, scale: "1", opacity: 1 };
  const anim = el.animate(out ? [home, away] : [away, home], {
    duration: out ? 420 : 760,
    easing: out ? "cubic-bezier(0.5, 0, 0.75, 0)" : EASE_OUT,
    fill: out ? "forwards" : "none",
  });
  return finish(anim, signal);
}

// FLIP from `before` to the element's current place; `walk` hops along the way.
function glide(el, before, at, signal, { walk = false, duration } = {}) {
  const dx = (before.x ?? 0) - (at.x ?? 0);
  const dy = (before.y ?? 0) - (at.y ?? 0);
  const r0 = before.r ?? 0;
  const r1 = at.r ?? 0;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5 && Math.abs(r1 - r0) < 0.1) return Promise.resolve();
  const ms = duration ?? Math.round(Math.min(1800, Math.max(600, 420 + dist * 0.85)));
  let keyframes;
  if (walk) {
    const hops = Math.max(2, Math.round(dist / 110));
    keyframes = Array.from({ length: hops * 2 + 1 }, (_, i) => {
      const t = i / (hops * 2);
      const lift = i % 2 ? -18 : 0;
      return {
        translate: `${dx * (1 - t)}px ${dy * (1 - t) + lift}px`,
        rotate: `${r0 + (r1 - r0) * t}deg`,
      };
    });
  } else {
    keyframes = [
      { translate: `${dx}px ${dy}px`, rotate: `${r0}deg` },
      { translate: "0px 0px", rotate: `${r1}deg` },
    ];
  }
  return finish(
    el.animate(keyframes, { duration: ms, easing: walk ? "linear" : EASE_IN_OUT }),
    signal,
  );
}

// --- Actors --------------------------------------------------------------------------------

// A paw print, toes up, in a 40 × 40 box.
const PAW = `<svg viewBox="0 0 40 40" aria-hidden="true" focusable="false"><ellipse cx="20" cy="27" rx="9.5" ry="8"/><ellipse cx="8.5" cy="16" rx="4" ry="5.2" transform="rotate(-18 8.5 16)"/><ellipse cx="16" cy="8.5" rx="4" ry="5.4" transform="rotate(-6 16 8.5)"/><ellipse cx="24" cy="8.5" rx="4" ry="5.4" transform="rotate(6 24 8.5)"/><ellipse cx="31.5" cy="16" rx="4" ry="5.2" transform="rotate(18 31.5 16)"/></svg>`;

// A wheat ear, for the Granary & Sons logo.
const WHEAT = `<svg viewBox="0 0 24 24" focusable="false"><path d="M11.3 23V9h1.4v14z"/><ellipse cx="12" cy="4.5" rx="2" ry="3.4"/><ellipse cx="8.6" cy="9" rx="1.8" ry="3.1" transform="rotate(-32 8.6 9)"/><ellipse cx="15.4" cy="9" rx="1.8" ry="3.1" transform="rotate(32 15.4 9)"/><ellipse cx="8.6" cy="14" rx="1.8" ry="3.1" transform="rotate(-32 8.6 14)"/><ellipse cx="15.4" cy="14" rx="1.8" ry="3.1" transform="rotate(32 15.4 14)"/></svg>`;

function skeleton(widths) {
  return widths.map((w) => `<i class="copy-l" style="width:${w}%"></i>`).join("");
}

export const ACTORS = {
  cat: {
    create({ name = "duna", pose = "sit", label = "" }) {
      return createCat(name, { pose, label });
    },
    update(el, { pose = "sit" }) {
      el.pose(pose).catch(() => {});
    },
  },

  // A stray copy of the resume: a sheet with the look of the template, and its file name below.
  copy: {
    create({ headline = "" }) {
      const el = h("div", "copy");
      el.innerHTML = `<div class="copy-sheet" data-paper>
          <div class="copy-top">
            <div><div class="copy-name">Duna Feline</div><div class="copy-headline">${esc(headline)}</div></div>
            <div class="copy-contact">${skeleton([100, 80, 90])}</div>
          </div>
          <div class="copy-bar"></div>
          <div class="copy-sec"><span class="copy-tab">Summary</span><span class="copy-rule"></span></div>
          ${skeleton([100, 97, 100, 64])}
          <div class="copy-sec"><span class="copy-tab">Experience</span><span class="copy-rule"></span></div>
          <div class="copy-role">${skeleton([62])}<span class="copy-pill"></span></div>
          ${skeleton([96, 100, 78, 92, 58])}
          <div class="copy-role">${skeleton([54])}<span class="copy-pill"></span></div>
          ${skeleton([100, 88, 70])}
          <div class="copy-sec"><span class="copy-tab">Projects</span><span class="copy-rule"></span></div>
          ${skeleton([90, 100, 46])}
        </div>
        <p class="copy-file"><span class="copy-file-name"></span></p>`;
      return el;
    },
  },

  // The resume replica, both pages, at full size. One per id, reused across end frames (the
  // replica is costly to build).
  resume: {
    create(props, ctx, id) {
      const key = `resume:${id}`;
      let el = ctx.cache.get(key);
      if (!el) {
        el = h("div", "sheet-stack");
        el.dataset.paper = "";
        el.dataset.penLayer = "";
        el.resume = createResume(el);
        el.resume.onPagesChange(() => sizeResume(el));
        ctx.cache.set(key, el);
      }
      clearPen(el);
      delete el.dataset.proof;
      return el;
    },
    mount(el, { state = "canonical", highlight = [] }) {
      el.resume.render(state);
      el.dataset.state = state;
      el.resume.highlight(highlight);
      sizeResume(el);
    },
    // Kept from the scene before: the same replica create + mount would build (no pen marks
    // but those still fading out, no real-PDF page, `state` and `highlight` as given).
    update(el, { state = "canonical", highlight = [] }) {
      for (const m of el.querySelectorAll(".pen-mark, .pen-note")) {
        if (!("ghost" in m.dataset)) m.remove();
      }
      if ("proof" in el.dataset) setProof(el, false, false);
      if (el.dataset.state !== state) {
        el.resume.render(state);
        el.dataset.state = state;
      }
      el.resume.highlight(highlight);
      sizeResume(el);
    },
  },

  // The job posting (applications/2026-09-granary-senior-mouser/jd.md, abridged).
  posting: {
    create() {
      const el = h("article", "posting");
      el.dataset.paper = "";
      el.dataset.penLayer = "";
      el.innerHTML = `<p class="posting-org"><span class="posting-logo" aria-hidden="true">${WHEAT}</span>Granary &amp; Sons · Careers</p>
        <h3 class="posting-title">Senior Mouser, Rodent Operations</h3>
        <p class="posting-meta">On-site (grain warehouse) · Night shifts · Reports to the Head Farmer</p>
        <h4>Responsibilities</h4>
        <ul>
          <li>Patrol the warehouse at night and <span data-ask="detect">detect rodent activity early</span>.</li>
          <li>Respond to sightings quickly and report incidents to the farm staff.</li>
          <li>Keep the loading dock box inventory inspected and occupied.</li>
          <li><span data-ask="train">Train the barn’s younger cats</span> in patrol routes.</li>
        </ul>
        <h4>Preferred</h4>
        <ul>
          <li><span data-ask="research">Published research on rodent detection.</span></li>
          <li>Mentoring experience with kittens.</li>
        </ul>
        <h4>Perks</h4>
        <ul><li>Unlimited cardboard boxes after every grain delivery.</li></ul>`;
      return el;
    },
  },

  // Paw prints from `from` to `to` (world units), left and right in turn.
  paws: {
    create({ from, to, gap = 70 }) {
      const el = h("div", "paws");
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const n = Math.max(2, Math.floor(len / gap));
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90; // toes point along the walk
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const side = i % 2 ? 1 : -1;
        const x = from.x + dx * t + (-dy / len) * side * 15;
        const y = from.y + dy * t + (dx / len) * side * 15;
        const paw = h("span", "paw", PAW);
        paw.style.left = `${Math.round(x - 17)}px`;
        paw.style.top = `${Math.round(y - 17)}px`;
        paw.style.rotate = `${Math.round(deg + side * 8)}deg`;
        el.append(paw);
      }
      return el;
    },
    // The prints appear one after another.
    enter(el, props, signal) {
      const prints = [...el.querySelectorAll(".paw svg")];
      return Promise.all(
        prints.map((svg, i) =>
          finish(
            svg.animate(
              [
                { opacity: 0, scale: "0.6" },
                { opacity: 1, scale: "1" },
              ],
              {
                duration: 260,
                delay: i * 110,
                easing: EASE_OUT,
                fill: "backwards",
              },
            ),
            signal,
          ),
        ),
      );
    },
  },

  // A terminal card on the desk (terminal.js); `el.term` is its API.
  terminal: {
    create() {
      const el = h("div", "term-card");
      const inner = h("div");
      el.append(inner);
      el.term = createTerminal(inner);
      return el;
    },
  },
};

function sizeResume(el) {
  const { width, height } = el.resume.spreadSize();
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
}

// --- Cues ----------------------------------------------------------------------------------

const isPoint = (p) => p && typeof p === "object" && "x" in p && !("w" in p);

// The point on rect `a`'s edge facing rect `b`'s centre, `gap` beyond it.
function edgeToward(a, b, gap = 12) {
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  const dx = b.x + b.w / 2 - cx;
  const dy = b.y + b.h / 2 - cy;
  const s = Math.min(
    dx ? a.w / 2 / Math.abs(dx) : Infinity,
    dy ? a.h / 2 / Math.abs(dy) : Infinity,
  );
  const len = Math.hypot(dx, dy) || 1;
  return { x: cx + dx * s + (dx / len) * gap, y: cy + dy * s + (dy / len) * gap };
}

function markArgs(cue, ctx) {
  const el = cue.target.x === undefined ? ctx.el(cue.target) : null;
  const layer =
    cue.on === "world"
      ? ctx.world
      : cue.on
        ? ctx.el(cue.on)
        : (el?.closest("[data-pen-layer]") ?? ctx.world);
  const r = ctx.rect(el ?? cue.target, layer);
  const n = typeof cue.grow === "number" ? cue.grow : 0;
  const g = {
    top: n,
    right: n,
    bottom: n,
    left: n,
    ...(typeof cue.grow === "object" ? cue.grow : {}),
  };
  const rect = {
    x: r.x - g.left,
    y: r.y - g.top,
    w: r.w + g.left + g.right,
    h: r.h + g.top + g.bottom,
  };
  const opts = {
    layer,
    ink:
      cue.ink ??
      (el?.closest("[data-paper]") ? "paper" : layer.closest("[data-paper]") ? "paper" : "desk"),
    pad: cue.pad,
    seed: cue.seed,
  };
  if (cue.from)
    opts.from = isPoint(cue.from) ? cue.from : edgeToward(ctx.rect(cue.from, layer), rect);
  return [rect, cue.kind, opts];
}

function noteArgs(cue, ctx) {
  const layer = cue.on ? ctx.el(cue.on) : ctx.world;
  const at = isPoint(cue.at) ? cue.at : ctx.rect(cue.at, layer);
  const opts = {
    layer,
    side: cue.side,
    gap: cue.gap,
    size: cue.size,
    rotate: cue.rotate,
    weight: cue.weight,
    ink: cue.ink,
  };
  return [cue.text, at, opts];
}

// pen.js appends a note to its layer at once; tag it so shots and arrows can find it.
function tagNote(cue, layer) {
  const el = layer.lastElementChild;
  if (cue.id && el?.classList.contains("pen-note")) el.dataset.note = cue.id;
}

function proofOf(el) {
  let img = el.querySelector(".sheet-proof");
  if (!img) {
    img = h("img", "sheet-proof");
    img.src = "img/tailored-1.png";
    img.alt = "";
    img.width = 816;
    img.height = 1056;
    el.append(img);
  }
  return img;
}

function setProof(el, show, animate) {
  const img = proofOf(el);
  if (!animate) img.style.transition = "none";
  if (show) el.dataset.proof = "";
  else delete el.dataset.proof;
  if (!animate) {
    void img.offsetWidth;
    img.style.transition = "";
  }
}

export const CUES = {
  enter: {
    run(cue, ctx, signal) {
      const { el, kept, before } = ctx.add(cue);
      if (kept) {
        const walk = cue.kind === "cat";
        if (!walk) return glide(el, before, cue.at, signal);
        const pose = cue.props?.pose ?? "sit";
        const moved =
          Math.hypot((before.x ?? 0) - (cue.at.x ?? 0), (before.y ?? 0) - (cue.at.y ?? 0)) > 1;
        if (moved && !ctx.reduced) el.pose("tap").catch(() => {});
        return glide(el, before, cue.at, signal, { walk: true }).finally(() => {
          if (!signal.aborted) el.pose(pose).catch(() => {});
        });
      }
      const custom = ACTORS[cue.kind].enter;
      if (custom) return custom(el, cue.props ?? {}, signal, ctx);
      return slide(el, cue.from, signal);
    },
    instant(cue, ctx) {
      ctx.add(cue);
    },
  },

  exit: {
    async run(cue, ctx, signal) {
      const el = ctx.actor(cue.id);
      if (!el) return;
      await slide(el, cue.to, signal, true);
      ctx.remove(cue.id);
    },
    instant(cue, ctx) {
      ctx.remove(cue.id);
    },
  },

  move: {
    run(cue, ctx, signal) {
      const { el, before, at } = moveTo(cue, ctx);
      return glide(el, before, at, signal, { walk: cue.walk, duration: cue.duration });
    },
    instant(cue, ctx) {
      moveTo(cue, ctx);
    },
  },

  pose: {
    run(cue, ctx, signal) {
      return ctx.el(cue.id).pose(cue.pose, { signal });
    },
    instant(cue, ctx) {
      ctx
        .el(cue.id)
        .pose(cue.pose)
        .catch(() => {});
    },
  },

  type: {
    async run({ target, text, cps = 20 }, ctx, signal) {
      const el = ctx.el(target);
      el.textContent = "";
      el.classList.add("is-typing");
      try {
        for (let i = 1; i <= text.length; i++) {
          await ctx.wait(1000 / cps, signal);
          el.textContent = text.slice(0, i);
        }
        await ctx.wait(240, signal);
      } finally {
        el.classList.remove("is-typing");
      }
    },
    instant({ target, text }, ctx) {
      ctx.el(target).textContent = text;
    },
  },

  mark: {
    async run(cue, ctx, signal) {
      const [target, kind, opts] = markArgs(cue, ctx);
      await mark(target, kind, { ...opts, signal, duration: cue.duration });
    },
    instant(cue, ctx) {
      markInstant(...markArgs(cue, ctx));
    },
  },

  note: {
    async run(cue, ctx, signal) {
      const [text, at, opts] = noteArgs(cue, ctx);
      const done = note(text, at, { ...opts, signal, duration: cue.duration });
      tagNote(cue, opts.layer);
      await done;
    },
    instant(cue, ctx) {
      const [text, at, opts] = noteArgs(cue, ctx);
      noteInstant(text, at, opts);
      tagNote(cue, opts.layer);
    },
  },

  resume: {
    async run({ id, state, highlight = [], animate = true }, ctx, signal) {
      const el = ctx.el(id);
      el.resume.render(state, { animate });
      el.dataset.state = state;
      el.resume.highlight(highlight);
      if (animate && !ctx.reduced) await ctx.wait(900, signal);
    },
    instant({ id, state, highlight = [] }, ctx) {
      const el = ctx.el(id);
      el.resume.render(state, { animate: false });
      el.dataset.state = state;
      el.resume.highlight(highlight);
    },
  },

  proof: {
    async run({ id, show = true }, ctx, signal) {
      setProof(ctx.el(id), show, !ctx.reduced);
      if (!ctx.reduced) await ctx.wait(650, signal);
    },
    instant({ id, show = true }, ctx) {
      setProof(ctx.el(id), show, false);
    },
  },

  terminal: {
    run({ id, lines }, ctx, signal) {
      return ctx.el(id).term.play(lines, { signal });
    },
    instant({ id, lines }, ctx) {
      ctx.el(id).term.renderInstant(lines);
    },
  },

  wait: {
    run({ ms }, ctx, signal) {
      return ctx.reduced ? Promise.resolve() : ctx.wait(ms, signal);
    },
    instant() {},
  },
};

// Moves an actor to `cue.at` (merged into where it is); returns { el, before, at }.
function moveTo(cue, ctx) {
  const el = ctx.el(cue.id);
  const before = placeOf(el);
  const at = {
    x: before.x,
    y: before.y,
    r: before.r,
    w: el.style.width ? parseFloat(el.style.width) : undefined,
    h: el.style.height ? parseFloat(el.style.height) : undefined,
    z: el.style.zIndex === "" ? undefined : +el.style.zIndex,
    ...cue.at,
  };
  ctx.place(el, at);
  return { el, before, at };
}

// --- The storyline -------------------------------------------------------------------------

// Where things sit on the desk (world units). Scene 1's pile and scene 2's resume share the
// left of the desk; the posting lies further right, so the camera travels to it.
const CAT = { w: 300, h: 407 }; // the cat symbol is 140 × 190
const COPY = { w: 470, h: 700 }; // a 470 × 608 sheet, its file name below
const PILE = { x: 600, y: 380 }; // where the copies fan out from
const DUNA_1 = { x: 1290, y: 440, ...CAT, z: 5 };
const DUNA_2 = { x: -480, y: 660, ...CAT, z: 5 };
const POSTING = { x: 2560, y: 0, w: 780, h: 880, r: -1.2, z: 2 };
const DUNA_3 = { x: 3200, y: 590, ...CAT, z: 5 };
const RESUME = { x: 0, y: 0, w: 1680, h: 1056, z: 1 };

const copy = (n, file, headline, at) => [
  {
    do: "enter",
    id: `copy-${n}`,
    kind: "copy",
    at: { ...COPY, ...at, z: n },
    from: { dx: PILE.x - at.x, dy: PILE.y - at.y, r: -at.r, o: 0 },
    props: { headline },
    wait: false,
  },
  {
    do: "type",
    target: { actor: `copy-${n}`, sel: ".copy-file-name" },
    text: file,
    cps: 26,
    delay: 380,
  },
];

// The role header the camera pushes onto in scene 2 (its title line), and the title itself.
const ROLE = { actor: "resume", sel: '[data-id="windowsill"] .r-title' };
const ROLE_TITLE = { actor: "resume", sel: '[data-id="windowsill"] .r-title b' };

export const SCENES = [
  {
    id: "problem",
    name: "The problem",
    caption: "Every job wants a *different* resume.",
    transcript: [
      "Three copies of one resume lie on the desk: resume_v2.pdf, resume_final.pdf, and resume_FINAL_v3.pdf, each with a different headline.",
      "A pen note asks: which one is true? Duna, a gray tabby, swats the newest copy off the pile.",
    ],
    steps: [
      {
        shot: {
          target: { x: 40, y: -60, w: 1610, h: 960 },
          portrait: { x: 440, y: -150, w: 1170, h: 1160 },
        },
        cues: [
          {
            do: "enter",
            id: "duna",
            kind: "cat",
            at: DUNA_1,
            from: { dy: -30, o: 0 },
            props: { name: "duna" },
            wait: false,
          },
          ...copy(1, "resume_v2.pdf", "Professional Napper", { x: 110, y: 130, r: -8 }),
          ...copy(2, "resume_final.pdf", "Senior Box Inspector", { x: 460, y: 70, r: -1.5 }),
          ...copy(3, "resume_FINAL_v3.pdf", "Head of Windowsill Operations", {
            x: 810,
            y: 110,
            r: 5.5,
          }),
        ],
        hold: 400,
      },
      {
        // A slow push while the pen asks.
        shot: {
          target: { x: 110, y: -150, w: 1490, h: 960 },
          portrait: { x: 470, y: -170, w: 1130, h: 1100 },
          duration: 2600,
        },
        cues: [
          {
            do: "note",
            id: "which",
            text: "which one is true? 🙀",
            at: { x: 640, y: -128 },
            size: 76,
            rotate: -3,
            delay: 300,
          },
          { do: "pose", id: "duna", pose: "tap", wait: false },
        ],
        hold: 700,
      },
      {
        // Duna swats the newest copy off the pile; the camera eases back to take it in.
        shot: {
          target: { x: 80, y: -160, w: 1560, h: 1110 },
          portrait: { x: 450, y: -180, w: 1180, h: 1240 },
          duration: 900,
        },
        cues: [
          { do: "pose", id: "duna", pose: "wave", wait: false },
          { do: "move", id: "copy-3", at: { x: 930, y: 250, r: 15 }, duration: 520, delay: 500 },
          { do: "pose", id: "duna", pose: "blink", wait: false },
        ],
        hold: 1800,
      },
    ],
  },
  {
    id: "meet",
    name: "Meet Duna",
    caption: "Meet Duna.",
    transcript: [
      "Duna’s canonical resume: two pages with every role, project, paper, and award she has, each fact written once and cited by key.",
      "She waves: hi, I’m Duna. The camera moves in on one role header, Head of Windowsill Operations at Sunbeam Estates.",
    ],
    steps: [
      {
        // Pull back: both pages, and Duna.
        shot: {
          target: { x: -620, y: -190, w: 2320, h: 1280 },
          portrait: { x: -620, y: -190, w: 1450, h: 1280 },
        },
        cues: [
          {
            do: "enter",
            id: "paws-2",
            kind: "paws",
            at: { z: 0 },
            props: { from: { x: 1400, y: 1000 }, to: { x: -280, y: 1090 } },
            wait: false,
          },
          {
            do: "enter",
            id: "resume",
            kind: "resume",
            at: RESUME,
            from: { dy: 140, o: 0 },
            props: { state: "canonical" },
            wait: false,
          },
          {
            do: "enter",
            id: "duna",
            kind: "cat",
            at: DUNA_2,
            from: { dx: -120, o: 0 },
            props: { name: "duna", pose: "wave" },
          },
          {
            do: "note",
            id: "hi",
            text: "hi, I’m Duna 👋",
            at: { x: -590, y: 556 },
            size: 68,
            rotate: -4,
          },
        ],
        hold: 900,
      },
      {
        cues: [
          {
            do: "note",
            id: "complete",
            text: "one complete resume",
            at: { x: 520, y: -160 },
            size: 80,
            rotate: -1.5,
          },
          { do: "mark", target: { note: "complete" }, kind: "underline", ink: "desk" },
        ],
        hold: 1300,
      },
      {
        // A short push onto one role header, with Duna beside it.
        shot: {
          target: [ROLE, "duna"],
          grow: { left: 140, top: 150, right: 40, bottom: 20 },
          portrait: {
            target: ["duna", { actor: "resume", sel: '[data-id="windowsill"] .r-node' }],
            grow: { left: 140, top: 150, right: 300, bottom: 20 },
          },
          duration: 1100,
        },
        cues: [
          { do: "pose", id: "duna", pose: "sit", wait: false },
          // Underlined, not ringed: a ring around one line of the page crosses its neighbours.
          {
            do: "mark",
            target: ROLE_TITLE,
            kind: "underline",
            grow: { bottom: -4 },
            after: "camera",
          },
          {
            do: "note",
            id: "once",
            text: "every fact\nwritten once",
            at: ROLE,
            side: "left",
            gap: 170,
            size: 64,
            rotate: -3,
          },
          {
            do: "mark",
            target: ROLE_TITLE,
            kind: "arrow",
            on: "world",
            from: { note: "once" },
            grow: 12,
            ink: "desk",
          },
        ],
        hold: 2200,
      },
    ],
  },
  {
    id: "job",
    name: "The job",
    caption: "Then the *dream job* shows up.",
    transcript: [
      "A posting: Senior Mouser, Rodent Operations, at Granary & Sons. Night patrol, early detection, box inspection, and training the barn’s younger cats; published research on rodent detection preferred.",
      "The pen circles what it asks for, and Duna jumps for joy: THE dream job.",
    ],
    steps: [
      {
        shot: { target: { x: 2540, y: -40, w: 1000, h: 1060 } },
        cues: [
          { do: "enter", id: "resume", kind: "resume", at: RESUME, wait: false },
          {
            do: "enter",
            id: "posting",
            kind: "posting",
            at: POSTING,
            from: { dx: 900, dy: -60, r: 9, o: 0 },
            wait: false,
          },
          {
            do: "enter",
            id: "paws-3",
            kind: "paws",
            at: { z: 0 },
            props: { from: { x: 3960, y: 1010 }, to: { x: 3380, y: 990 } },
            wait: false,
            delay: 300,
          },
          {
            // She bounds in from the right (not the long way round from the last scene).
            do: "enter",
            id: "duna",
            kind: "cat",
            fresh: true,
            at: DUNA_3,
            from: { dx: 420, dy: -40, o: 0 },
            props: { name: "duna" },
            delay: 500,
          },
        ],
        hold: 300,
      },
      {
        cues: [
          { do: "mark", target: { actor: "posting", sel: '[data-ask="detect"]' }, kind: "circle" },
          { do: "mark", target: { actor: "posting", sel: '[data-ask="train"]' }, kind: "circle" },
          {
            do: "mark",
            target: { actor: "posting", sel: '[data-ask="research"]' },
            kind: "underline",
          },
        ],
        hold: 500,
      },
      {
        cues: [
          { do: "pose", id: "duna", pose: "jump", wait: false },
          {
            do: "note",
            id: "dream",
            text: "THE dream job 😻",
            at: { x: 2590, y: 912 },
            size: 78,
            rotate: -3,
          },
        ],
        hold: 2600,
      },
    ],
  },
];
