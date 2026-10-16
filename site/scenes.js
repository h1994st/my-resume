// The launch film's scenes (played by film.js): the actors on the desk, the cue kinds, and the
// storyline as data. film.js documents the contract (scene, step, shot, cue, and actor shapes);
// this file fills it. Adding a scene is data, plus a cue or actor kind if it needs a new one.
// The words are in i18n.js: a scene's name, caption, and transcript (by its id), and the notes,
// Claude's replies, and the links, read through getters, so a frame built again after a
// language change (film.relang) is in the new language. The documents on the desk (the replica,
// the copies, the posting, the stamp) and the commands in the terminal stay English.
//
// World units are CSS px of the desk at scale 1: a resume page is 816 × 1056. Positions `at` are
// { x, y, w?, h?, r? (deg), z? }. The pen writes in the world (desk ink) or, with `on: actorId`,
// in an actor's own layer (a paper actor: paper ink, and the mark moves with the paper).
//
// Actor kinds (ACTORS): cat { name, pose, label }, copy { file, headline } (a stray resume copy;
// its file name starts empty for a type cue), resume { state, highlight } (the replica, both
// pages; `el.resume` is its createResume API, `el.dataset.state` its state; a kept replica is
// updated to exactly what create + mount would build), posting (the Granary & Sons job), paws { from,
// to } (a trail of prints, in world units), terminal { lines } (a desk card around createTerminal,
// sized by style.css: wide in a landscape window, narrow and tall in a portrait one, so its text
// stays readable; `lines` is what it already shows, its history), stamp { text } (a rubber stamp:
// a paw print and lines of text).
//
// Cue kinds (CUES), each with an animated `run` and an `instant` end state:
//   enter { id, kind, at, from?, props?, fresh? }  puts an actor on the desk; `from` { dx, dy,
//       r, s, o } is where it comes from (default: fades in). A kept actor (see film.js) moves
//       to `at` instead (a cat walks); `fresh: true` lets it go and enters it anew.
//   exit { id, to? }                     takes it off (`to` as `from`)
//   move { id, at, walk?, duration? }    moves it (FLIP); `walk` hops like a cat
//   pose { id, pose }                    a cat's pose (resolves after one cycle; use wait: false)
//   type { target, text, cps? }          types text into an element, a caret while typing
//   mark { target, kind, on?, from?, grow?, text?, ink?, pad?, seed?, duration? }   a pen mark,
//       in the target's pen layer unless `on` names an actor or "world"; `from` (arrows) is a
//       point in the layer's units or a target (the arrow starts at its edge facing the mark's
//       target); `grow` (world units, or { top, right, bottom, left }; negative shrinks) widens
//       the target (an arrow then stops short of it; an underline with a negative bottom sits
//       closer); `text: true` marks the target's text, not its box (a strike as long as the line)
//   note { id?, text, at, side?, gap?, size?, rotate?, weight?, on?, ink? }   a pen note; `at` is
//       a point { x, y } (top left) or a target with `side`
// `enter`, `move`, `note`, and `mark` cues also take `portrait` { ...fields }: used instead while
// the film's free area is portrait (ctx.portrait()), so a phone held upright can keep a note or a
// cat inside a cropped zoom.
//   resume { id, state, highlight?, animate?, clear? }   the replica's state (resume-data.js
//       keys); `clear` first wipes the pen marks on it (they would point at the old layout)
//   proof { id, show }                   crossfades the replica's page 1 to img/tailored-1.png
//   terminal { id, lines }               plays terminal lines (terminal.js) in a terminal actor
//   stamp { id, at, text, jolt? }        a stamp actor lands at `at` with an impact (`jolt`: an
//       actor that jumps under it)
//   confetti { at, n?, ms?, seed? }      confetti falls over `at` (a world rect) and is gone at
//       the end: the end state is no confetti, and with reduced motion none falls at all
//   cta { links: [{ text, href, primary? }] }   real links in the film's overlay (not aria-hidden;
//       style.css lays them out under the caption of the scene with the id "cta")
//   wait { ms }

import { createCat } from "./cast.js";
import { t } from "./i18n.js";
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
      el.lang = "en";
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
        el.lang = "en";
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
      el.lang = "en";
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

  // A terminal card on the desk (terminal.js); `el.term` is its API. `lines` is its history:
  // what it shows when it enters (a kept card shows it again, so a scene that goes on from the
  // last one starts where it left off).
  terminal: {
    create() {
      const el = h("div", "term-card");
      el.append(
        h(
          "div",
          "term-bar",
          '<i></i><i></i><i></i><span class="term-title">claude — ~/my-resume</span>',
        ),
      );
      const inner = h("div");
      el.append(inner);
      el.term = createTerminal(inner);
      return el;
    },
    mount(el, { lines = [] }) {
      el.term.renderInstant(lines);
    },
    update(el, { lines = [] }) {
      el.term.reset();
      el.term.renderInstant(lines);
    },
  },

  // A rubber stamp, inked on paper: a paw print and its lines of text.
  stamp: {
    create({ text = [] }) {
      const el = h("div", "stamp");
      el.lang = "en";
      el.innerHTML = `<span class="stamp-paw">${PAW}</span><span class="stamp-text">${text
        .map((t) => `<span>${esc(t)}</span>`)
        .join("")}</span>`;
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

function markArgs(drawn, ctx) {
  const cue = oriented(drawn, ctx);
  const el = cue.target.x === undefined ? ctx.el(cue.target) : null;
  const layer =
    cue.on === "world"
      ? ctx.world
      : cue.on
        ? ctx.el(cue.on)
        : (el?.closest("[data-pen-layer]") ?? ctx.world);
  const r = cue.text && el ? textRect(el, layer, ctx) : ctx.rect(el ?? cue.target, layer);
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

// The box of el's text (its line, not its block) in `layer`'s units: where el is laid out
// (offsets: no transform moves it), plus where its text sits inside it, measured on screen
// relative to el itself (so a camera move or an animation moving el changes nothing). Rounded
// to whole units, so an end frame and a played frame agree.
function textRect(el, layer, ctx) {
  const base = ctx.rect(el, layer);
  const range = document.createRange();
  range.selectNodeContents(el);
  const t = range.getBoundingClientRect();
  const e = el.getBoundingClientRect();
  const s = e.width / el.offsetWidth || 1;
  const x = Math.round(base.x + (t.left - e.left) / s);
  const y = Math.round(base.y + (t.top - e.top) / s);
  return { x, y, w: Math.round(t.width / s), h: Math.round(t.height / s) };
}

function noteArgs(written, ctx) {
  const cue = oriented(written, ctx);
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
    run(entry, ctx, signal) {
      const cue = oriented(entry, ctx);
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
      ctx.add(oriented(cue, ctx));
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
    async run({ id, state, highlight = [], animate = true, clear = false }, ctx, signal) {
      const el = ctx.el(id);
      if (clear) clearPen(el);
      el.resume.render(state, { animate });
      el.dataset.state = state;
      el.resume.highlight(highlight);
      if (animate && !ctx.reduced) await ctx.wait(900, signal);
    },
    instant({ id, state, highlight = [], clear = false }, ctx) {
      const el = ctx.el(id);
      if (clear) clearPen(el);
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

  stamp: {
    run(cue, ctx, signal) {
      const el = stampOn(cue, ctx);
      if (ctx.reduced) return Promise.resolve();
      const r = rotOf(el);
      const landing = el.animate(
        [
          { scale: "2.3", rotate: `${r - 9}deg`, opacity: 0 },
          { scale: "0.93", rotate: `${r}deg`, opacity: 1, offset: 0.55 },
          { scale: "1.03", rotate: `${r}deg`, opacity: 1, offset: 0.78 },
          { scale: "1", rotate: `${r}deg`, opacity: 1 },
        ],
        { duration: 560, easing: "cubic-bezier(0.55, 0, 0.6, 1)" },
      );
      const done = [finish(landing, signal)];
      // The impact jolts the paper and the ink on it together.
      const under = cue.jolt && ctx.actor(cue.jolt);
      for (const it of under ? [under, el] : []) {
        const jolt = it.animate(
          [
            { translate: "0 0" },
            { translate: "0 7px" },
            { translate: "0 -2px" },
            { translate: "0 0" },
          ],
          { duration: 260, delay: 300, easing: "ease-out" },
        );
        done.push(finish(jolt, signal));
      }
      return Promise.all(done);
    },
    instant(cue, ctx) {
      stampOn(cue, ctx);
    },
  },

  // Fire and forget: whatever happens, the confetti is gone when the cue ends.
  confetti: {
    run({ at, n = 80, ms = 2600, seed = 11 }, ctx, signal) {
      if (ctx.reduced) return Promise.resolve();
      const box = h("div", "confetti");
      ctx.place(box, { x: at.x, y: at.y, z: 30 });
      ctx.world.append(box);
      const rnd = random(seed);
      const falls = [];
      for (let i = 0; i < n; i++) {
        const bit = h("i");
        const w = 9 + rnd() * 7;
        Object.assign(bit.style, {
          left: `${Math.round(rnd() * at.w)}px`,
          top: `${Math.round(-rnd() * 160)}px`,
          width: `${Math.round(w)}px`,
          height: `${Math.round(w * (1.4 + rnd() * 0.6))}px`,
          background: CONFETTI[i % CONFETTI.length],
        });
        box.append(bit);
        const drift = (rnd() - 0.5) * 220;
        const spin = (rnd() < 0.5 ? -1 : 1) * (360 + rnd() * 540);
        const fall = at.h + 160 + rnd() * 120;
        falls.push(
          finish(
            bit.animate(
              [
                { translate: "0 0", rotate: "0deg", opacity: 1 },
                {
                  translate: `${drift * 0.6}px ${fall * 0.5}px`,
                  rotate: `${spin * 0.5}deg`,
                  opacity: 1,
                  offset: 0.5,
                },
                {
                  translate: `${drift}px ${fall * 0.82}px`,
                  rotate: `${spin * 0.82}deg`,
                  opacity: 1,
                  offset: 0.82,
                },
                { translate: `${drift * 1.1}px ${fall}px`, rotate: `${spin}deg`, opacity: 0 },
              ],
              {
                duration: ms * (0.65 + rnd() * 0.35),
                delay: rnd() * 520,
                easing: "cubic-bezier(0.3, 0.45, 0.6, 1)",
                fill: "backwards",
              },
            ),
            signal,
          ),
        );
      }
      return Promise.all(falls).finally(() => box.remove());
    },
    instant(cue, ctx) {
      for (const el of ctx.world.querySelectorAll(".confetti")) el.remove();
    },
  },

  cta: {
    async run(cue, ctx, signal) {
      const el = ctaOf(cue, ctx);
      if (ctx.reduced) return;
      await finish(
        el.animate(
          [
            { opacity: 0, translate: "0 12px" },
            { opacity: 1, translate: "0 0" },
          ],
          { duration: 600, easing: EASE_OUT },
        ),
        signal,
      );
    },
    instant(cue, ctx) {
      ctaOf(cue, ctx);
    },
  },

  wait: {
    run({ ms }, ctx, signal) {
      return ctx.reduced ? Promise.resolve() : ctx.wait(ms, signal);
    },
    instant() {},
  },
};

// A cue with its `portrait` fields applied while the free area is portrait.
function oriented(cue, ctx) {
  return cue.portrait && ctx.portrait() ? { ...cue, ...cue.portrait } : cue;
}

// Puts a stamp cue's stamp on the desk (an actor, so the next scene clears it).
function stampOn({ id, at, text }, ctx) {
  return ctx.add({ id, kind: "stamp", at, props: { text } }).el;
}

// The call to action's links, in the overlay (replacing any there).
function ctaOf({ links }, ctx) {
  for (const old of ctx.overlay.querySelectorAll(".film-cta")) old.remove();
  const el = h("div", "film-cta");
  el.dataset.noSwipe = "";
  for (const { text, href, primary } of links) {
    const a = h("a", primary ? "cta-primary" : "cta-secondary");
    a.href = href;
    a.textContent = text;
    el.append(a);
  }
  ctx.overlay.append(el);
  return el;
}

const CONFETTI = ["#f59e0b", "#10b981", "#6366f1", "#ef4444", "#ec4899", "#0ea5e9", "#c2410c"];

// A small seeded generator (mulberry32): the same confetti every time.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Moves an actor to `cue.at` (merged into where it is); returns { el, before, at }.
function moveTo(moved, ctx) {
  const cue = oriented(moved, ctx);
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
const RESUME_1 = { ...RESUME, w: 816 }; // one page (the Granary variant)

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

// Scene 2's note on an upright phone: on the desk above the page, over the role's column.
const ONCE_NOTE_PORTRAIT = { x: 70, y: -190, w: 300, h: 140 };
// The role header the camera pushes onto in scene 2 (its title line), and the title itself.
const ROLE = { actor: "resume", sel: '[data-id="windowsill"] .r-title' };
const ROLE_TITLE = { actor: "resume", sel: '[data-id="windowsill"] .r-title b' };

// Scenes 4 and 5: a terminal card right of the posting, Duna between them. The card's size
// comes from style.css (it depends on the window's shape), so shots on it name its parts.
const TERM_A = { x: 3720, y: 0, z: 3 };
const TERM_A_AREA = { x: 3360, y: -40, w: 1840, h: 840 }; // the card (landscape) and Duna
const TERM_A_AREA_PORTRAIT = { x: 3700, y: -40, w: 680, h: 1320 }; // the card (portrait)
const DUNA_4 = { x: 3400, y: 350, ...CAT, z: 5 };
const INPUT_A = { actor: "term", sel: ".t-input" };
const TABLE = { actor: "term", sel: ".t-grid" };
// Scenes 6 to 9: Duna sits left of the replica; scene 8's card lies further left.
const DUNA_L = { x: -400, y: 480, ...CAT, z: 5 };
const NANGNANG = { x: 800, y: 640, ...CAT, z: 7 };
const NANGNANG_PORTRAIT = { x: 500, y: 1010, ...CAT, z: 7 }; // under the stamp, below the page
const STAMP_AT = { x: 214, y: 900, r: -6, z: 6 };
const STAMP_AREA = { x: 196, y: 850, w: 620, h: 190 }; // where it lands, tilt included
// Scene 8's celebration: Duna and Dudu on the desk left of the page, level with the new role,
// clear of the page's text. An upright phone crops to the role's title and has no room beside
// the page: there they sit on the page, under the role.
const DUNA_8 = { x: -360, y: 110, ...CAT, z: 5 };
const DUDU_8 = { x: -640, y: 160, ...CAT, z: 4 };
const DUNA_8_PORTRAIT = { x: 150, y: 610, ...CAT, z: 5 };
const DUDU_8_PORTRAIT = { x: 0, y: 640, ...CAT, z: 4 };
const TERM_B = { x: -2040, y: 0, z: 3 };

const bullet = (id) => ({ actor: "resume", sel: `[data-id="${id}"]` });
const head = (id) => ({ actor: "resume", sel: `[data-id="sec:${id}"] .r-tab` });
const SUNBEAM = { actor: "resume", sel: '[data-id="windowsill"]' };
const NEW_ROLE = { actor: "resume", sel: '[data-id="granary"]' };
const NEW_ROLE_TITLE = { actor: "resume", sel: '[data-id="granary"] .r-title b' };
const NEW_ROLE_NODE = { actor: "resume", sel: '[data-id="granary"] .r-node' };
const PAGE_1 = { x: 0, y: 0, w: 816, h: 1056 };
const SPREAD = { x: -560, y: -60, w: 2290, h: 1170 }; // both pages, and Duna
// Pen notes beside the replica (their top left; the rect is about the note's size).
const UP_NOTE = { x: 836, y: 262, w: 210, h: 80 };
const REAL_NOTE = { x: -590, y: 160, w: 540, h: 160 };
// A phone held upright crops a zoom to the start of the lines: its notes go on the desk above
// the page, in the cropped column.
const DOG_NOTE = { x: -560, y: 290, w: 380, h: 130 }; // above Duna, level with the bullets
const DOG_NOTE_PORTRAIT = { x: 70, y: -190, w: 360, h: 130 };
const REAL_NOTE_PORTRAIT = { x: 30, y: -210, w: 540, h: 160 };
const UP_NOTE_PORTRAIT = { x: 110, y: -150, w: 240, h: 80 };
// The least scale of a zoom on the replica's lines (14 px text → 11.5 px on screen).
const READ = 0.82;

// Terminal lines (terminal.js), as the real commands and skills print them (copied from the
// repo: the justfile, the two skills, and applications/2026-09-granary-senior-mouser/).
const APP = "applications/2026-09-granary-senior-mouser";
const HELLO = [{ t: "welcome" }];
const PROMPT = [
  { t: "prompt", text: "/customize-resume https://example.com/careers/senior-mouser" },
];
const SETUP = [
  { t: "spin", text: "Sniffing", ms: 1000 },
  { t: "tool", name: "Fetch", arg: "example.com/careers/senior-mouser" },
  { t: "result", text: "Received 2.1KB (200 OK)" },
  { t: "tool", name: "Bash", arg: "just new granary senior-mouser" },
  { t: "result", text: `Created ${APP} — fill in jd.md, then ask Claude to customize.` },
  { t: "tool", name: "Write", arg: "…/jd.md" },
  { t: "result", text: "Wrote 37 lines to …/jd.md" },
];
// Claude's replies (and Duna's answer) follow the page's language; the evidence column quotes
// her resume, which stays English.
const EVIDENCE = [
  "Monitored 400+ birds a day (Sunbeam)",
  "Chirping alerts in under 2 seconds",
  "Inspected 1,200 boxes (Cardboard)",
  "Mentored two younger cats",
  "ACWS 2019, Best Paper",
];
const PLAN = [
  {
    t: "say",
    get text() {
      return t("term.plan.intro");
    },
  },
  {
    t: "table",
    get head() {
      return t("term.plan.head");
    },
    get rows() {
      return EVIDENCE.map((e, i) => [
        t(`term.plan.signal.${i + 1}`),
        e,
        t(`term.plan.change.${i + 1}`),
      ]);
    },
  },
  {
    t: "say",
    get text() {
      return t("term.plan.fit");
    },
  },
];
const APPROVE = [
  {
    t: "ask",
    get question() {
      return t("term.approve.question");
    },
    get options() {
      return t("term.approve.options");
    },
    pick: 0,
  },
];
// Scene 8 (a demo step: this role is not in the repo). Claude asks for every date it writes.
const UPDATE_ASK = [
  { t: "prompt", text: "/update-resume Got the job: Senior Mouser at Granary & Sons" },
  { t: "spin", text: "Purring", ms: 1000 },
  {
    t: "say",
    get text() {
      return t("term.update.ask");
    },
  },
];
// Her answer is free text, in her language (the bullet is for the English resume).
const UPDATE_ANSWER = [
  {
    t: "prompt",
    get text() {
      return t("term.update.answer");
    },
  },
];
const UPDATE_WRITE = [
  { t: "tool", name: "Update", arg: "common/facts/roles.tex" },
  { t: "result", text: "Updated common/facts/roles.tex with 7 additions and 1 removal" },
  { t: "tool", name: "Update", arg: "canonical/resume.tex" },
  { t: "result", text: "Updated canonical/resume.tex with 3 additions" },
];

// A scene's name, caption, and transcript, from i18n.js by its id, in the page's language.
function localized(scene) {
  for (const field of ["name", "caption", "transcript"]) {
    Object.defineProperty(scene, field, {
      get: () => t(`scene.${scene.id}.${field}`),
      enumerable: true,
    });
  }
  return scene;
}

export const SCENES = [
  {
    id: "problem",
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
            get text() {
              return t("note.which");
            },
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
            get text() {
              return t("note.hi");
            },
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
            get text() {
              return t("note.complete");
            },
            at: { x: 520, y: -160 },
            // Upright: under page 1, inside the pull-back and off the push onto the role.
            portrait: { at: { x: 120, y: 1110 } },
            size: 80,
            rotate: -1.5,
          },
          { do: "mark", target: { note: "complete" }, kind: "underline", ink: "desk" },
        ],
        hold: 1300,
      },
      {
        // A short push onto one role header and its note, with Duna beside them when the
        // text stays readable (an upright phone: the title's start, the note above it).
        shot: {
          target: ROLE,
          grow: { left: 480, top: 80, right: 16, bottom: 80 },
          context: "duna",
          legible: READ,
          minScale: READ,
          anchor: "start",
          portrait: {
            target: [ONCE_NOTE_PORTRAIT, ROLE],
            grow: { left: 16, top: 16, right: 16, bottom: 30 },
            minScale: READ,
            anchor: "start",
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
            get text() {
              return t("note.once");
            },
            at: ROLE,
            side: "left",
            gap: 170,
            portrait: { at: { x: ONCE_NOTE_PORTRAIT.x, y: ONCE_NOTE_PORTRAIT.y } },
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
            get text() {
              return t("note.dream");
            },
            at: { x: 2590, y: 912 },
            size: 78,
            rotate: -3,
          },
        ],
        hold: 2600,
      },
    ],
  },
  {
    id: "prompt",
    steps: [
      {
        // The camera travels on to a terminal card beside the posting.
        shot: {
          target: { x: 2520, y: -60, w: 2700, h: 940 },
          portrait: { x: 3340, y: -60, w: 1060, h: 1380 },
        },
        cues: [
          { do: "enter", id: "resume", kind: "resume", at: RESUME, wait: false },
          { do: "enter", id: "posting", kind: "posting", at: POSTING, wait: false },
          {
            do: "enter",
            id: "paws-4",
            kind: "paws",
            at: { z: 0 },
            props: { from: { x: 3330, y: 990 }, to: { x: 3560, y: 830 } },
            wait: false,
          },
          {
            do: "enter",
            id: "term",
            kind: "terminal",
            at: TERM_A,
            from: { dy: 90, o: 0 },
            props: { lines: HELLO },
            wait: false,
            delay: 200,
          },
          { do: "enter", id: "duna", kind: "cat", at: DUNA_4, props: { name: "duna" } },
        ],
        hold: 500,
      },
      {
        // Zoom in on the prompt as she types it.
        shot: {
          target: INPUT_A,
          grow: { top: 40, bottom: 150 },
          context: "duna",
          legible: 0.62,
        },
        cues: [
          { do: "pose", id: "duna", pose: "tap", wait: false },
          { do: "terminal", id: "term", lines: PROMPT },
          { do: "pose", id: "duna", pose: "sit", wait: false },
          {
            do: "note",
            id: "paw",
            get text() {
              return t("note.paw");
            },
            at: INPUT_A,
            side: "below",
            gap: 34,
            size: 64,
            rotate: -2,
          },
        ],
        hold: 900,
      },
      {
        // Claude gets to work: the posting, a new application folder, jd.md.
        shot: {
          target: INPUT_A,
          grow: { top: 330, bottom: 20 },
          context: ["term", "duna", { note: "paw" }],
          legible: 0.5,
        },
        cues: [{ do: "terminal", id: "term", lines: SETUP }],
        hold: 2200,
      },
    ],
  },
  {
    id: "plan",
    steps: [
      {
        // Duna and the card (a rect: after a jump the card isn't on the desk yet).
        shot: { target: TERM_A_AREA, portrait: TERM_A_AREA_PORTRAIT },
        cues: [
          { do: "enter", id: "resume", kind: "resume", at: RESUME, wait: false },
          { do: "enter", id: "posting", kind: "posting", at: POSTING, wait: false },
          {
            do: "enter",
            id: "term",
            kind: "terminal",
            at: TERM_A,
            props: { lines: [...HELLO, ...PROMPT, ...SETUP] },
            wait: false,
          },
          {
            do: "enter",
            id: "duna",
            kind: "cat",
            at: DUNA_4,
            props: { name: "duna" },
            wait: false,
          },
          { do: "terminal", id: "term", lines: PLAN },
        ],
        hold: 400,
      },
      {
        // Zoom on the table: every change has evidence behind it.
        shot: { target: TABLE, grow: 16 },
        cues: [{ do: "wait", ms: 900 }],
        hold: 2600,
      },
      {
        // ... and on the question: nothing changes without her yes.
        shot: {
          target: INPUT_A,
          grow: { top: 210, bottom: 150 },
          context: "duna",
          legible: 0.62,
        },
        cues: [
          { do: "terminal", id: "term", lines: APPROVE },
          { do: "pose", id: "duna", pose: "blink", wait: false },
          {
            do: "note",
            id: "fibs",
            get text() {
              return t("note.fibs");
            },
            at: INPUT_A,
            side: "below",
            gap: 34,
            size: 64,
            rotate: -2,
          },
        ],
        hold: 2400,
      },
    ],
  },
  {
    id: "tailor",
    steps: [
      {
        // Back to the replica; Duna bounds in to watch.
        shot: {
          target: SPREAD,
          portrait: { x: -500, y: -40, w: 1340, h: 1130 },
        },
        cues: [
          {
            do: "enter",
            id: "resume",
            kind: "resume",
            at: RESUME,
            props: { state: "canonical" },
            wait: false,
          },
          {
            do: "enter",
            id: "paws-6",
            kind: "paws",
            at: { z: 0 },
            props: { from: { x: -820, y: 760 }, to: { x: -330, y: 735 } },
            wait: false,
          },
          {
            do: "enter",
            id: "duna",
            kind: "cat",
            fresh: true,
            at: DUNA_L,
            from: { dx: -380, dy: -30, o: 0 },
            props: { name: "duna" },
          },
        ],
        hold: 300,
      },
      {
        // Zoom in on Sunbeam: two bullets don't fit the job.
        shot: {
          target: [DOG_NOTE, SUNBEAM, bullet("w-dog")],
          grow: { left: 16, right: 16, top: 16, bottom: 16 },
          context: "duna",
          legible: 1.1,
          minScale: READ,
          anchor: "start",
          duration: 1100,
          // Upright phone: the start of the lines, big enough to read, the note above them.
          portrait: {
            target: [DOG_NOTE_PORTRAIT, SUNBEAM, bullet("w-dog")],
            grow: { left: 16, top: 16, bottom: 16 },
            minScale: READ,
            anchor: "start",
          },
        },
        cues: [
          {
            do: "mark",
            target: bullet("w-breakfast"),
            kind: "strike",
            text: true,
            after: "camera",
          },
          { do: "mark", target: bullet("w-dog"), kind: "strike", text: true },
          // On the desk above Duna, but in the replica's pen layer: the rewrite wipes it.
          {
            do: "note",
            id: "dog",
            get text() {
              return t("note.dog");
            },
            at: { x: DOG_NOTE.x, y: DOG_NOTE.y },
            portrait: { at: { x: DOG_NOTE_PORTRAIT.x, y: DOG_NOTE_PORTRAIT.y } },
            size: 56,
            rotate: -3,
            on: "resume",
            ink: "desk",
          },
          {
            do: "mark",
            target: bullet("w-dog"),
            kind: "arrow",
            text: true,
            on: "resume",
            from: { note: "dog" },
            grow: { left: 8, right: -560, top: 4, bottom: 4 },
            // From the note above: onto the line's first words.
            portrait: { grow: { left: 8, right: -560, top: -8, bottom: 4 } },
            ink: "desk",
          },
        ],
        hold: 1500,
      },
      {
        // Pull back: what else goes (a phone stays on the sections that go) ...
        shot: {
          target: [head("service"), head("honors")],
          grow: { top: 20, right: 640, bottom: 110, left: 30 },
          context: SPREAD,
          legible: 0.35,
          minScale: READ,
          anchor: "start",
        },
        cues: [
          { do: "mark", target: head("service"), kind: "strike", after: "camera" },
          { do: "mark", target: head("honors"), kind: "strike" },
        ],
        hold: 700,
      },
      {
        // ... and the rewrite folds two pages into one. (A rect: the step changes the page.)
        shot: { target: PAGE_1, context: SPREAD, legible: 0.35 },
        cues: [
          {
            do: "resume",
            id: "resume",
            state: "granary",
            highlight: ["headline", "w-birds", "w-mentor"],
            clear: true,
            after: "camera",
          },
        ],
        hold: 600,
      },
      {
        // One page: the bullet that matters most moved up.
        shot: {
          target: [SUNBEAM, bullet("w-mentor"), UP_NOTE],
          grow: { top: 16, bottom: 16, left: 16 },
          context: ["resume", "duna", UP_NOTE],
          legible: 0.6,
          portrait: {
            target: [UP_NOTE_PORTRAIT, SUNBEAM, bullet("w-mentor")],
            grow: { top: 16, left: 16, bottom: 16 },
            minScale: READ,
            anchor: "start",
          },
        },
        cues: [
          { do: "mark", target: bullet("w-birds"), kind: "circle", text: true, pad: 2 },
          {
            do: "note",
            id: "up",
            get text() {
              return t("note.up");
            },
            at: { x: UP_NOTE.x, y: UP_NOTE.y },
            portrait: { at: { x: UP_NOTE_PORTRAIT.x, y: UP_NOTE_PORTRAIT.y } },
            size: 56,
            rotate: -4,
          },
          {
            do: "mark",
            target: bullet("w-birds"),
            kind: "arrow",
            on: "world",
            from: { note: "up" },
            grow: 10,
            portrait: { text: true, grow: { left: 4, right: -600, top: -6, bottom: 0 } },
            ink: "desk",
          },
        ],
        hold: 2400,
      },
    ],
  },
  {
    id: "ship",
    steps: [
      {
        // The real PDF, from this commit.
        shot: {
          target: [{ x: 0, y: 0, w: 816, h: 330 }, REAL_NOTE],
          grow: { top: 30, bottom: 30 },
          context: ["resume", REAL_NOTE],
          legible: 0.45,
          portrait: { target: ["resume", REAL_NOTE_PORTRAIT], grow: { top: 20 } },
        },
        cues: [
          {
            do: "enter",
            id: "resume",
            kind: "resume",
            at: RESUME_1,
            props: { state: "granary" },
            wait: false,
          },
          {
            do: "enter",
            id: "duna",
            kind: "cat",
            at: DUNA_L,
            props: { name: "duna" },
            wait: false,
          },
          { do: "proof", id: "resume", show: true, after: "camera" },
          {
            do: "note",
            id: "real",
            get text() {
              return t("note.real");
            },
            at: { x: REAL_NOTE.x, y: REAL_NOTE.y },
            portrait: { at: { x: REAL_NOTE_PORTRAIT.x, y: REAL_NOTE_PORTRAIT.y } },
            size: 64,
            rotate: -3,
          },
          {
            do: "mark",
            target: { x: 40, y: 60, w: 300, h: 80 },
            kind: "arrow",
            on: "world",
            from: { note: "real" },
            ink: "desk",
          },
        ],
        hold: 1400,
      },
      {
        // Nangnang stamps the tag.
        shot: {
          target: [STAMP_AREA, NANGNANG],
          grow: { top: 20, left: 20, right: 140 }, // and clear of Duna, left of the page
          // When legible, the whole page, Nangnang, and the note left of it (no note cut).
          context: ["resume", NANGNANG, REAL_NOTE],
          legible: 0.45,
          // Upright phone: from the page's left edge to the stamp; Nangnang sits below it.
          portrait: {
            target: [{ x: 0, y: STAMP_AREA.y, w: 1, h: 1 }, STAMP_AREA, NANGNANG_PORTRAIT],
            grow: { left: 12, right: 12, top: 30, bottom: 10 },
          },
        },
        cues: [
          {
            do: "enter",
            id: "paws-7",
            kind: "paws",
            at: { z: 0 },
            props: { from: { x: 1500, y: 1110 }, to: { x: 1000, y: 1080 } },
            portrait: { props: { from: { x: 1300, y: 1440 }, to: { x: 820, y: 1400 } } },
            wait: false,
          },
          {
            do: "enter",
            id: "nangnang",
            kind: "cat",
            at: NANGNANG,
            portrait: { at: NANGNANG_PORTRAIT },
            from: { dx: 420, dy: -30, o: 0 },
            props: { name: "nangnang" },
          },
          { do: "pose", id: "nangnang", pose: "wave", wait: false },
          {
            do: "stamp",
            id: "tag",
            at: STAMP_AT,
            text: ["submitted/", "2026-09-granary-senior-mouser"],
            jolt: "resume",
            delay: 500,
          },
          { do: "pose", id: "nangnang", pose: "blink", wait: false },
        ],
        hold: 2600,
      },
    ],
  },
  {
    id: "update",
    steps: [
      {
        // A new session: the card comes in beside Duna.
        shot: {
          target: { x: -2060, y: -60, w: 2000, h: 940 },
          portrait: { x: -2060, y: -60, w: 760, h: 1380 },
        },
        cues: [
          {
            do: "enter",
            id: "resume",
            kind: "resume",
            at: RESUME,
            props: { state: "canonical" },
            wait: false,
          },
          {
            do: "enter",
            id: "duna",
            kind: "cat",
            at: DUNA_L,
            props: { name: "duna" },
            wait: false,
          },
          {
            do: "enter",
            id: "term",
            kind: "terminal",
            at: TERM_B,
            from: { dy: 90, o: 0 },
            props: { lines: HELLO },
          },
        ],
        hold: 300,
      },
      {
        // Zoom on the prompt, then on Claude's question.
        shot: {
          target: INPUT_A,
          grow: { top: 200, bottom: 150 },
          context: "duna",
          legible: 0.62,
        },
        cues: [
          { do: "pose", id: "duna", pose: "tap", wait: false },
          { do: "terminal", id: "term", lines: UPDATE_ASK },
          { do: "pose", id: "duna", pose: "sit", wait: false },
          {
            do: "note",
            id: "asks",
            get text() {
              return t("note.asks");
            },
            at: INPUT_A,
            side: "below",
            gap: 34,
            size: 64,
            rotate: -2,
          },
        ],
        hold: 1400,
      },
      {
        // Her answer.
        cues: [
          { do: "pose", id: "duna", pose: "tap", wait: false },
          { do: "terminal", id: "term", lines: UPDATE_ANSWER },
          { do: "pose", id: "duna", pose: "sit", wait: false },
        ],
        hold: 1000,
      },
      {
        shot: {
          target: INPUT_A,
          grow: { top: 330, bottom: 20 },
          context: ["term", "duna"],
          legible: 0.5,
        },
        cues: [{ do: "terminal", id: "term", lines: UPDATE_WRITE }],
        hold: 1200,
      },
      {
        // The new role lands on top of the spine, under the Experience heading (the shot names
        // the heading: the role isn't there yet when the step starts).
        shot: {
          target: head("experience"),
          grow: { top: 20, bottom: 100, left: 20, right: 640 },
          context: "duna",
          legible: 1.1,
          portrait: {
            target: head("experience"),
            grow: { top: 20, bottom: 100, left: 20, right: 300 },
          },
        },
        cues: [
          {
            do: "resume",
            id: "resume",
            state: "updated",
            highlight: ["granary", "g-patrol"],
            after: "camera",
          },
          { do: "mark", target: NEW_ROLE_TITLE, kind: "underline", grow: { bottom: -4 } },
        ],
        hold: 1200,
      },
      {
        // She got the job: the terminal's work is done. Duna hops up beside her new role, Dudu
        // joins her and cheers. (A desk wide enough frames the role with them; an upright phone
        // crops to the role's title and the two cats, on the page under it.)
        shot: {
          target: [DUDU_8, DUNA_8],
          grow: { top: 30, bottom: 10 },
          context: NEW_ROLE,
          legible: 0.75,
          portrait: {
            target: [NEW_ROLE_TITLE, DUDU_8_PORTRAIT, DUNA_8_PORTRAIT],
            grow: { top: 30, bottom: 10, left: 10 },
            minScale: READ,
            anchor: "start",
          },
        },
        cues: [
          { do: "exit", id: "term", to: { dy: 80, o: 0 }, wait: false },
          {
            do: "enter",
            id: "dudu",
            kind: "cat",
            at: DUDU_8,
            portrait: { at: DUDU_8_PORTRAIT },
            from: { dx: -360, dy: -20, o: 0 },
            props: { name: "dudu" },
            wait: false,
            delay: 300,
          },
          {
            do: "move",
            id: "duna",
            at: { x: DUNA_8.x, y: DUNA_8.y },
            portrait: { at: { x: DUNA_8_PORTRAIT.x, y: DUNA_8_PORTRAIT.y } },
            walk: true,
          },
          { do: "confetti", at: { x: -700, y: 40, w: 1600, h: 1000 }, wait: false },
          { do: "pose", id: "duna", pose: "jump", wait: false, delay: 100 },
          { do: "pose", id: "dudu", pose: "wave", wait: false, delay: 600 },
        ],
        hold: 2400,
      },
    ],
  },
  {
    id: "cta",
    steps: [
      {
        // Wide on the whole desk; a phone keeps to Duna and the note.
        shot: {
          target: { x: -1060, y: 400, w: 980, h: 450 },
          context: { x: -1060, y: -60, w: 2780, h: 1170 },
          legible: 0.3,
        },
        cues: [
          {
            do: "enter",
            id: "resume",
            kind: "resume",
            at: RESUME,
            props: { state: "updated" },
            wait: false,
          },
          {
            do: "enter",
            id: "duna",
            kind: "cat",
            at: DUNA_L,
            props: { name: "duna", pose: "wave" },
            wait: false,
          },
          {
            do: "cta",
            links: [
              {
                get text() {
                  return t("cta.template");
                },
                href: "https://github.com/h1994st/my-resume/generate",
                primary: true,
              },
              {
                get text() {
                  return t("cta.github");
                },
                href: "https://github.com/h1994st/my-resume",
              },
            ],
            wait: false,
            delay: 300,
          },
          {
            do: "note",
            id: "free",
            get text() {
              return t("note.free");
            },
            at: { x: -1040, y: 520 },
            size: 68,
            rotate: -3,
            delay: 400,
          },
        ],
        hold: 3000,
      },
    ],
  },
].map(localized);
