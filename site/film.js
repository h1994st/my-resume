// The launch film: a full-window player that tells the story as scenes on a desk, with a camera
// that frames what matters. Scenes are data (scenes.js); this file plays them.
//
// createFilm({ scenes, cues, actors, root, onEvent }) → film
//   { play(), pause(), toggle(), next(), prev(), goTo(n), interact(method), renderEnd(n),
//     ready, scene, step, playing, animating, seen, inView, busy, actor(id), focus(), camera,
//     world, sceneCount }
// `n` and `scene` are 0-based indexes into `scenes`; events count scenes from 1.
//
// ## The scene contract (scenes.js fills it)
//
// scenes: [{ id, name, caption, transcript?, steps: [{ shot?, cues, hold? }] }]
//   id        the scene's name in events (act_name), e.g. "problem"
//   name      its chapter name: the controls say "Scene N: name"
//   caption   the big line over the film; *word* marks the word the highlighter picks out
//   transcript  extra sentences for the visually hidden transcript (screen readers)
//   shot      what the camera frames when the step starts (kept until the next shot):
//               "duna"               an actor, by id
//               { actor, sel }       an element inside an actor (a CSS selector)
//               { note }             a pen note, by the id its note cue gave it
//               { x, y, w, h }       a rect in world units
//               [ ... ]              several targets, framed together
//             or { target, portrait?, grow?, padding?, duration?, maxScale? }: `portrait` (a
//             target, or { target, grow? }) is framed instead while the free area is taller
//             than wide; `grow` { top, right, bottom, left } adds world units around the
//             target; the rest go to camera.frame.
//             An actor in a shot must be on the desk already, or be entered by this step with
//             a full `at` (x, y, w, h). A shot is framed as its step starts, so put it on the
//             step after the cue that changes its target's size.
//             A scene keeps an actor it enters again unless that enter cue says `fresh: true`.
//   cues      run in order, each after the one before, unless it has `wait: false` (the next
//             starts at once; the step still waits for it). `delay` (ms) waits first; `after:
//             "camera"` waits for the step's camera move. Every cue is { do: kind, ... }.
//   hold      ms that autoplay rests after the step (default 1600)
//
// cues[kind] = { run(cue, ctx, signal) → Promise, instant(cue, ctx) }
//   `run` plays the cue and rejects when `signal` aborts; `instant` puts the cue's end state on
//   screen at once. They must end in the same state: an end frame is built from instant forms.
// actors[kind] = { create(props, ctx, id) → Element, mount?(el, props, ctx),
//                  update?(el, props, ctx), enter?(el, props, signal, ctx) → Promise }
//   `create` builds the element (the film positions it); `mount` runs once it is in the world;
//   `update` runs when a scene keeps the actor (see below); `enter` replaces the default entrance.
// ctx (for cue handlers): { world, camera, cache, reduced, actor(id), add(cue) → { el, kept,
//   before }, place(el, at), remove(id), el(target) → Element, rect(target, layer) → rect in
//   the layer's units, wait(ms, signal) }. `at` is { x, y, w?, h?, r? (deg), z? } in world units.
//
// ## End frames, playback, and jumps
//
// renderEnd(n) builds scene n's end frame from scratch: it empties the world, applies the
// instant form of every cue of the scene, frames the last shot at once, and shows the caption.
// Playback plays each step's cues with `run`. A scene that starts from the end frame of the
// scene before keeps the actors it enters again (same id and kind; their enter cue moves them);
// the rest fade out, and every pen mark and note is cleared. goTo(n) (next, prev, chapters,
// keys, swipes) cancels everything in flight (an AbortSignal) and renders scene n's end frame;
// play() then plays scene n from its start. Pausing mid-step shows that step's end at once;
// play() goes on from the next step. After the last scene, play() starts over. With reduced
// motion there is no autoplay and each step shows its end frame at once (camera cuts).
//
// ## Viewer
//
// The film autoplays the first time it fills half the viewport (or half of itself). Keys: Space
// (play/pause), ←/→ (scenes), 1–9 (scene N), only while the film is in view and focus is on the
// page body or inside the film. Touch or pen swipes step, except from the controls or from
// [data-no-swipe]. The controls (play/pause, prev/next, one chapter segment per scene, a
// "replay" label) fade after 2.5 s without pointer movement while playing, and come back on
// pointer movement, touch, keys, or focus; they stay while paused, with reduced motion, while
// keyboard focus is in them, or while the pointer is over them. The caption and the world are
// aria-hidden: a visually hidden transcript lists every scene, and a polite live region names
// each scene as it starts.
//
// onEvent(name, params): "interact" { method: play|step|chapter|key|swipe } on each user action,
// "act" { act, act_name } each time a scene is entered, "complete" { method: autoplay|manual }
// when the last scene is entered.

import { createCamera, offsetRect } from "./camera.js";

const HOLD = 1600;
const IDLE_MS = 2500;
const SWIPE_PX = 40;
const FADE_MS = 360;

const ICONS = {
  prev: '<path d="M6 5h2v14H6zM20 5v14L9.5 12z"/>',
  next: '<path d="M16 5h2v14h-2zM4 5l10.5 7L4 19z"/>',
  play: '<path d="M7 4.5v15L19.5 12z"/>',
  pause: '<path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
// "a *b* c" → "a <em>b</em> c"; plain() drops the marks.
const emphasis = (s) => esc(s).replace(/\*([^*]+)\*/g, "<em>$1</em>");
const plain = (s) => String(s).replace(/\*([^*]+)\*/g, "$1");
const two = (n) => String(n).padStart(2, "0");

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const isRect = (t) => t && typeof t === "object" && !Array.isArray(t) && "x" in t && "w" in t;
const union = (rs) => {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rs.map((r) => r.x + r.w)) - x,
    h: Math.max(...rs.map((r) => r.y + r.h)) - y,
  };
};

export function createFilm({ scenes, cues, actors, root, onEvent = () => {} }) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const lastScene = scenes.length - 1;
  const lastStep = (n) => scenes[n].steps.length - 1;
  for (const scene of scenes) {
    for (const step of scene.steps) {
      for (const cue of step.cues ?? []) {
        if (!cues[cue.do]) throw new Error(`scene ${scene.id}: unknown cue "${cue.do}"`);
        if (cue.do === "enter" && !actors[cue.kind]) {
          throw new Error(`scene ${scene.id}: unknown actor kind "${cue.kind}"`);
        }
      }
    }
  }

  // --- Markup ----------------------------------------------------------------------------------

  root.classList.add("film");
  root.dataset.controls = "shown";
  root.innerHTML = `<div class="film-viewport" aria-hidden="true">
      <div class="film-world" data-pen-layer><div class="film-desk"></div></div>
    </div>
    <div class="film-caption" aria-hidden="true">
      <p class="film-kicker"><span class="film-num"></span><span class="film-name"></span></p>
      <p class="film-line"></p>
    </div>
    <div class="film-controls" role="group" aria-label="Film controls" data-no-swipe>
      <div class="fc-buttons">
        <button type="button" class="fc-btn" data-ctl="prev" aria-label="Previous scene">${icon("prev")}</button>
        <button type="button" class="fc-btn fc-play" data-ctl="play" aria-label="Play">${icon("play")}</button>
        <button type="button" class="fc-btn" data-ctl="next" aria-label="Next scene">${icon("next")}</button>
      </div>
      <ol class="fc-chapters">${scenes
        .map(
          (s, i) =>
            `<li><button type="button" class="fc-seg" data-scene="${i + 1}" aria-label="Scene ${i + 1}: ${esc(s.name)}"><span class="fc-bar"><span class="fc-fill"></span></span><span class="fc-tip" aria-hidden="true">${i + 1} · ${esc(s.name)}</span></button></li>`,
        )
        .join("")}</ol>
      <span class="fc-label" title="A scripted replay of the workflow, not live output">replay</span>
    </div>
    <div class="visually-hidden">
      <h2>What the film shows</h2>
      <ol>${scenes
        .map(
          (s, i) =>
            `<li>Scene ${i + 1}, ${esc(s.name)}: ${esc(plain(s.caption))}${(s.transcript ?? [])
              .map((t) => ` ${esc(t)}`)
              .join("")}</li>`,
        )
        .join("")}</ol>
    </div>
    <p class="visually-hidden" aria-live="polite" data-film-live></p>`;

  const viewport = root.querySelector(".film-viewport");
  const world = root.querySelector(".film-world");
  const desk = root.querySelector(".film-desk");
  const caption = root.querySelector(".film-caption");
  const controls = root.querySelector(".film-controls");
  const live = root.querySelector("[data-film-live]");
  const ui = {
    play: controls.querySelector('[data-ctl="play"]'),
    segs: [...controls.querySelectorAll(".fc-seg")],
  };

  // The caption and the controls cover the bottom of the film: the camera frames above them.
  const camera = createCamera(viewport, world, {
    insets() {
      root.style.setProperty("--cap-top", `${caption.offsetTop}px`); // for the scrim (style.css)
      return { bottom: Math.max(0, viewport.clientHeight - caption.offsetTop) };
    },
  });

  const emit = (name, params) => {
    try {
      onEvent(name, params);
    } catch (err) {
      console.error(err);
    }
  };

  // --- Actors and the cue context ---------------------------------------------------------------

  const cast = new Map(); // id → { el, kind, at }
  const cache = new Map(); // for actors that are costly to rebuild (the resume replica)

  function place(el, at = {}) {
    el.style.left = `${at.x ?? 0}px`;
    el.style.top = `${at.y ?? 0}px`;
    el.style.width = at.w === undefined ? "" : `${at.w}px`;
    el.style.height = at.h === undefined ? "" : `${at.h}px`;
    el.style.rotate = at.r ? `${at.r}deg` : "";
    el.style.zIndex = at.z === undefined ? "" : String(at.z);
  }

  function remove(id) {
    cast.get(id)?.el.remove();
    cast.delete(id);
  }

  function find(target) {
    if (target instanceof Element) return target;
    if (typeof target === "string") {
      const el = cast.get(target)?.el;
      if (!el) throw new Error(`no actor "${target}" on the desk`);
      return el;
    }
    if (target?.note) {
      const el = world.querySelector(`.pen-note[data-note="${target.note}"]`);
      if (!el) throw new Error(`no pen note "${target.note}"`);
      return el;
    }
    if (target?.actor) {
      const actor = find(target.actor);
      if (!target.sel) return actor;
      const el = actor.querySelector(target.sel);
      if (!el) throw new Error(`no "${target.sel}" in actor "${target.actor}"`);
      return el;
    }
    throw new Error(`not a target: ${JSON.stringify(target)}`);
  }

  const ctx = {
    world,
    camera,
    cache,
    get reduced() {
      return reduced.matches;
    },
    actor: (id) => cast.get(id)?.el ?? null,
    // Puts the actor of an enter cue on the desk; a kept actor (same id and kind) is reused.
    add(cue) {
      const { id, kind, at = {}, props = {} } = cue;
      const def = actors[kind];
      const rec = cast.get(id);
      if (rec && rec.kind === kind && !cue.fresh) {
        const st = rec.el.style;
        const before = {
          x: parseFloat(st.left) || 0,
          y: parseFloat(st.top) || 0,
          r: parseFloat(st.rotate) || 0,
        };
        rec.at = { ...at };
        world.append(rec.el); // cue order is stacking order, as in an end frame
        place(rec.el, rec.at);
        def.update?.(rec.el, props, ctx);
        return { el: rec.el, kept: true, before };
      }
      if (rec) remove(id);
      const el = def.create(props, ctx, id);
      if ("ghost" in el.dataset) {
        // A cached element still fading out from the last frame: take it back.
        delete el.dataset.ghost;
        for (const a of el.getAnimations()) a.cancel();
      }
      el.classList.add("actor");
      el.dataset.actor = id;
      el.dataset.kind = kind;
      place(el, at);
      world.append(el);
      cast.set(id, { el, kind, at: { ...at } });
      def.mount?.(el, props, ctx);
      return { el, kept: false, before: null };
    },
    place,
    remove,
    el: find,
    rect(target, layer = world) {
      return isRect(target) ? target : offsetRect(find(target), layer);
    },
    wait,
  };

  // --- Shots -----------------------------------------------------------------------------------

  let lastShot = null; // { step, rect } of the shot on screen

  const isShot = (s) => s && typeof s === "object" && !Array.isArray(s) && "target" in s;
  const shotOf = (step) => (isShot(step.shot) ? step.shot : { target: step.shot });

  function resolve(target, step) {
    if (Array.isArray(target)) return union(target.map((t) => resolve(t, step)));
    if (isRect(target)) return target;
    if (typeof target === "string") {
      const enter = (step.cues ?? []).find(
        (c) => c.do === "enter" && c.id === target && c.at?.w && c.at?.h,
      );
      if (enter) return { x: enter.at.x, y: enter.at.y, w: enter.at.w, h: enter.at.h };
    }
    return camera.rectOf(find(target));
  }

  function frameShot(step, { instant = false, signal } = {}) {
    let shot = shotOf(step);
    const a = camera.area();
    if (shot.portrait && a.w < a.h * 0.9) {
      const p = shot.portrait;
      shot = { ...shot, ...(isShot(p) ? p : { target: p, grow: undefined }) };
    }
    const r = resolve(shot.target, step);
    const g = { top: 0, right: 0, bottom: 0, left: 0, ...shot.grow };
    const rect = {
      x: r.x - g.left,
      y: r.y - g.top,
      w: r.w + g.left + g.right,
      h: r.h + g.top + g.bottom,
    };
    lastShot = { step, rect };
    return camera.frame(rect, {
      padding: shot.padding,
      duration: shot.duration,
      maxScale: shot.maxScale,
      instant,
      signal,
    });
  }

  // --- Caption ---------------------------------------------------------------------------------

  function setCaption(n, animate) {
    const s = scenes[n];
    caption.querySelector(".film-num").textContent = two(n + 1);
    caption.querySelector(".film-name").textContent = s.name;
    caption.querySelector(".film-line").innerHTML = emphasis(s.caption);
    for (const a of caption.getAnimations({ subtree: true })) a.cancel();
    if (animate && !reduced.matches) {
      caption.animate(
        [
          { opacity: 0, translate: "0 0.5em" },
          { opacity: 1, translate: "0 0" },
        ],
        { duration: 700, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
      );
    }
  }

  // --- Rendering -------------------------------------------------------------------------------

  // Cancels the world's own animations (not CSS ones: pose loops, transitions) and empties it.
  function clearWorld() {
    for (const a of world.getAnimations({ subtree: true })) {
      if (a.effect?.target === world) continue; // the camera's
      if (a instanceof CSSAnimation || a instanceof CSSTransition) continue;
      a.cancel();
    }
    for (const child of [...world.children]) if (child !== desk) child.remove();
    cast.clear();
  }

  let shown = null; // { scene, step } whose end frame is on screen (null while a step plays)

  function renderAt(n, k) {
    clearWorld();
    setCaption(n, false);
    let shotStep = null;
    for (const step of scenes[n].steps.slice(0, k + 1)) {
      for (const cue of step.cues ?? []) cues[cue.do].instant(cue, ctx);
      if (step.shot) shotStep = step;
    }
    if (shotStep) frameShot(shotStep, { instant: true });
    shown = { scene: n, step: k };
  }

  const renderEnd = (n) => renderAt(n, lastStep(n));

  function fadeOut(el) {
    delete el.dataset.actor;
    el.dataset.ghost = "";
    el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], {
      duration: FADE_MS,
      easing: "ease-out",
      fill: "forwards",
    }).finished.then(gone, gone);
    // Gone unless an actor took the element back meanwhile (a cached one: see add()).
    function gone() {
      if ("ghost" in el.dataset) el.remove();
    }
  }

  // The start of scene n during playback: keeps what it enters again if it follows the end of
  // the scene before; fades out the rest and every pen mark and note.
  function beginScene(n, keep) {
    const kinds = new Map();
    if (keep) {
      for (const step of scenes[n].steps) {
        for (const cue of step.cues ?? []) {
          if (cue.do === "enter" && !cue.fresh) kinds.set(cue.id, cue.kind);
        }
      }
    }
    for (const el of world.querySelectorAll(".pen-mark, .pen-note")) fadeOut(el);
    for (const [id, rec] of [...cast]) {
      if (kinds.get(id) === rec.kind) continue;
      fadeOut(rec.el);
      cast.delete(id);
    }
    setCaption(n, true);
  }

  const busy = [];

  async function runCues(list, signal, cameraDone) {
    const started = [];
    for (const cue of list) {
      const handler = cues[cue.do];
      const p = (async () => {
        if (cue.after === "camera") await cameraDone;
        if (cue.delay) await wait(cue.delay, signal);
        if (signal.aborted) throw signal.reason;
        busy.push(cue.do);
        try {
          await (handler.run ?? handler.instant).call(handler, cue, ctx, signal);
        } finally {
          busy.splice(busy.indexOf(cue.do), 1);
        }
      })();
      p.catch(() => {}); // awaited below; this only keeps an abort from being "unhandled"
      started.push(p);
      if (cue.wait !== false) await p;
    }
    await Promise.all(started);
  }

  async function playStep(n, k, signal) {
    const step = scenes[n].steps[k];
    const cameraDone = step.shot ? frameShot(step, { signal }) : Promise.resolve();
    cameraDone.catch(() => {});
    await Promise.all([cameraDone, runCues(step.cues ?? [], signal, cameraDone)]);
  }

  // --- Playback --------------------------------------------------------------------------------

  let cur = 0; // the scene on screen
  let cursor = { scene: 0, step: 0, fresh: true }; // the next step to play; null after the end
  let playing = false;
  let animating = null; // { scene, step } in flight
  let run = null;
  let announced = null;
  let interacted = false;

  const after = ({ scene, step }) =>
    step < lastStep(scene)
      ? { scene, step: step + 1 }
      : scene < lastScene
        ? { scene: scene + 1, step: 0 }
        : null;

  function abort() {
    run?.abort();
    run = null;
  }

  function enter(n, { silent = false } = {}) {
    const from = cur;
    cur = n;
    if (!silent && announced !== n) {
      announced = n;
      emit("act", { act: n + 1, act_name: scenes[n].id });
      live.textContent = `Scene ${n + 1} of ${scenes.length}, ${scenes[n].name}: ${plain(scenes[n].caption)}`;
    }
    updateUI();
    if (!silent && n === lastScene && from !== lastScene) {
      emit("complete", { method: interacted ? "manual" : "autoplay" });
    }
  }

  async function loop() {
    const ctrl = new AbortController();
    run = ctrl;
    const { signal } = ctrl;
    try {
      while (cursor) {
        const { scene: n, step: k, fresh } = cursor;
        if (n !== cur || announced !== n) enter(n);
        animating = { scene: n, step: k };
        updateUI();
        if (reduced.matches) {
          renderAt(n, k);
        } else {
          if (k === 0) {
            const prev = n > 0 && shown?.scene === n - 1 && shown.step === lastStep(n - 1);
            beginScene(n, !fresh && prev);
          }
          shown = null;
          await playStep(n, k, signal);
          if (signal.aborted) return;
          shown = { scene: n, step: k };
        }
        animating = null;
        cursor = after({ scene: n, step: k });
        updateUI();
        if (!cursor) break;
        await wait(scenes[n].steps[k].hold ?? HOLD, signal);
      }
      playing = false;
      run = null;
      updateUI();
    } catch (err) {
      if (!signal.aborted) throw err;
    }
  }

  function goTo(n, opts) {
    const target = Math.max(0, Math.min(lastScene, n));
    abort();
    playing = false;
    animating = null;
    renderEnd(target);
    cursor = { scene: target, step: 0, fresh: true };
    enter(target, opts);
  }

  function play() {
    if (playing) return;
    if (!cursor) goTo(0); // replay from the start
    playing = true;
    updateUI();
    loop();
  }

  function pause() {
    if (!playing) return;
    const inflight = animating;
    abort();
    playing = false;
    animating = null;
    if (inflight) {
      renderAt(inflight.scene, inflight.step); // finish the step at once
      cursor = after(inflight);
    }
    updateUI();
  }

  const toggle = () => (playing ? pause() : play());
  const next = () => goTo(cur + 1);
  const prev = () => goTo(cur - 1);

  function interact(method) {
    interacted = true;
    emit("interact", { method });
  }

  // --- Controls --------------------------------------------------------------------------------

  controls.querySelector('[data-ctl="prev"]').addEventListener("click", () => {
    interact("step");
    prev();
  });
  controls.querySelector('[data-ctl="next"]').addEventListener("click", () => {
    interact("step");
    next();
  });
  ui.play.addEventListener("click", () => {
    interact("play");
    toggle();
  });
  ui.segs.forEach((seg, i) =>
    seg.addEventListener("click", () => {
      interact("chapter");
      goTo(i);
    }),
  );

  let wasPlaying = null;
  function updateUI() {
    root.classList.toggle("is-playing", playing);
    if (wasPlaying !== playing) {
      ui.play.innerHTML = icon(playing ? "pause" : "play");
      ui.play.setAttribute("aria-label", playing ? "Pause" : "Play");
      wasPlaying = playing;
      showControls();
    }
    const steps = scenes[cur].steps.length;
    const done = animating ? animating.step : shown?.scene === cur ? shown.step + 1 : 0;
    ui.segs.forEach((seg, i) => {
      if (i === cur) seg.setAttribute("aria-current", "step");
      else seg.removeAttribute("aria-current");
      const fill = i < cur ? 1 : i > cur ? 0 : done / steps;
      seg.style.setProperty("--fill", String(fill));
    });
  }

  // Auto-hide: only while playing with motion; never under the pointer or keyboard focus.
  let idleTimer = 0;
  function showControls() {
    clearTimeout(idleTimer);
    root.dataset.controls = "shown";
    if (playing && !reduced.matches) idleTimer = setTimeout(hideControls, IDLE_MS);
  }
  function hideControls() {
    if (!playing || reduced.matches) return;
    if (controls.matches(":hover") || controls.querySelector(":focus-visible")) {
      idleTimer = setTimeout(hideControls, IDLE_MS);
      return;
    }
    root.dataset.controls = "hidden";
  }
  for (const type of ["pointermove", "pointerdown", "focusin"]) {
    root.addEventListener(type, showControls);
  }
  reduced.addEventListener("change", showControls);

  // --- Visibility, keys, swipes ----------------------------------------------------------------

  // In view: the visible part covers half the viewport or half of the film.
  const covers = (visible, height, vh) => visible > 0 && visible >= 0.499 * Math.min(height, vh);
  const inView = () => {
    const r = root.getBoundingClientRect();
    return covers(Math.min(r.bottom, innerHeight) - Math.max(r.top, 0), r.height, innerHeight);
  };
  let seen = false;
  const io = new IntersectionObserver(
    ([entry]) => {
      const vh = entry.rootBounds?.height ?? innerHeight;
      const shownNow =
        entry.isIntersecting &&
        covers(entry.intersectionRect.height, entry.boundingClientRect.height, vh);
      if (shownNow && !seen) {
        seen = true;
        if (!reduced.matches && !interacted && !playing) play();
      }
    },
    { threshold: Array.from({ length: 21 }, (_, k) => k / 20) },
  );

  document.addEventListener("keydown", (e) => {
    if (!isReady) return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !inView()) return;
    const active = document.activeElement;
    if (active && active !== document.body && !root.contains(active)) return;
    let action = null;
    if (e.key === " " && !e.shiftKey) {
      // A focused button already activates on Space.
      if (active?.closest?.("button, a, input, select, textarea")) return;
      action = toggle;
    } else if (e.key === "ArrowRight") action = next;
    else if (e.key === "ArrowLeft") action = prev;
    else if (/^[1-9]$/.test(e.key) && +e.key <= scenes.length) action = () => goTo(+e.key - 1);
    if (!action || e.shiftKey) return;
    e.preventDefault();
    showControls();
    if (e.repeat && e.key === " ") return;
    interact("key");
    action();
  });

  // Touch or pen only (a mouse drag selects text); not from the controls.
  let start = null;
  root.addEventListener("pointerdown", (e) => {
    const onControls = controls.contains(e.target) || e.target.closest?.("[data-no-swipe]");
    start =
      e.pointerType === "mouse" || onControls
        ? null
        : { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  root.addEventListener("pointercancel", () => {
    start = null;
  });
  root.addEventListener("pointerup", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) <= SWIPE_PX || Math.abs(dx) <= Math.abs(dy)) return;
    interact("swipe");
    if (dx < 0) next();
    else prev();
  });

  // A resize (or a caption that wraps differently) reframes the shot on screen, at once.
  new ResizeObserver(() => {
    if (lastShot && isReady) frameShot(lastShot.step, { instant: true });
  }).observe(caption);
  new ResizeObserver(() => {
    if (lastShot && isReady) frameShot(lastShot.step, { instant: true });
  }).observe(viewport);

  // Text must be in its final fonts before anything measures it (notes, marks, the replica).
  const fonts = [
    '400 26px "Caveat"',
    '600 26px "Caveat"',
    '400 16px "Source Serif 4 SmText"',
    '600 16px "Source Serif 4 SmText"',
    '400 16px "Source Sans 3"',
    '600 16px "Source Sans 3"',
  ];
  let isReady = false;
  const ready = Promise.all(fonts.map((f) => document.fonts.load(f)))
    .catch(() => {})
    .then(() => document.fonts.ready)
    .then(() => {
      isReady = true;
      goTo(0, { silent: true });
      io.observe(root);
    });

  return {
    play,
    pause,
    toggle,
    next,
    prev,
    goTo,
    interact,
    renderEnd,
    ready,
    camera,
    world,
    actor: ctx.actor,
    // The current shot's target on screen (client px).
    focus: () => (lastShot ? camera.toClient(lastShot.rect) : null),
    get scene() {
      return cur;
    },
    get step() {
      return animating ? animating.step : (shown?.step ?? 0);
    },
    get playing() {
      return playing;
    },
    get animating() {
      return Boolean(animating);
    },
    get seen() {
      return seen;
    },
    get inView() {
      return inView();
    },
    get busy() {
      return [...busy];
    },
    get sceneCount() {
      return scenes.length;
    },
  };
}
