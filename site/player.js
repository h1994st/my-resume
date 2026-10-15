// The demo's timeline player: steps through ACTS (acts.js), driving the terminal and the resume
// replica, with a control bar, keys, swipe, and autoplay.
//
// createPlayer({ acts, terminal, resume, onEvent, stage, controls }) →
//   { play(), pause(), toggle(), next(), prev(), goTo(i), goToAct(n), interact(method),
//     step, stepCount, act, playing }
//
// Steps are flattened across acts (`step` is the index). goTo(i) cancels the step in flight and
// renders the end state of step i at once: the terminal lines of steps 0..i, and step i's resume
// state without animation. play() animates from the current step: each step plays its lines, then
// moves the replica to its state, holds `hold` ms, and advances; after the last step it stops.
// Manual navigation (next, prev, goToAct) pauses playback. prefers-reduced-motion: no autoplay
// and no motion; playing renders each step's end state.
//
// `stage` (optional) gets data-act / data-proof attributes and an is-playing class for the CSS
// (is-instant while a state is applied without transitions), hosts the keyboard and
// swipe handling, and starts autoplay when it first comes into view. "In view" means the visible
// part covers half the viewport or half the stage. Keys (Space, ←/→, 1–5) are handled only while
// the stage is in view and focus is on the page body or inside the stage. Swipes that start on
// `controls` (optional; it receives the control bar) or on [data-no-swipe] don't step.
//
// onEvent(name, params): "interact" {method: play|step|act_chip|key|swipe} on each user action,
// "act" {act, act_name} each time an act is entered, "complete" {method: autoplay|manual} when the
// last step is reached.

const HOLD = 1600;
const SWIPE_PX = 40;

const ICONS = {
  prev: '<path d="M6 5h2v14H6zM20 5v14L9.5 12z"/>',
  next: '<path d="M16 5h2v14h-2zM4 5l10.5 7L4 19z"/>',
  play: '<path d="M7 4.5v15L19.5 12z"/>',
  pause: '<path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function frames(n, signal) {
  return new Promise((resolve, reject) => {
    const tick = (left) => {
      if (signal.aborted) return reject(signal.reason);
      if (!left) return resolve();
      requestAnimationFrame(() => tick(left - 1));
    };
    tick(n);
  });
}

export function createPlayer({
  acts,
  terminal,
  resume,
  onEvent = () => {},
  stage = null,
  controls = null,
}) {
  const steps = acts.flatMap((act, a) => act.steps.map((step) => ({ ...step, act: a })));
  const firstOf = acts.map((_, a) => steps.findIndex((s) => s.act === a));
  const last = steps.length - 1;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  let cur = 0; // the step on screen
  let watched = false; // whether cur has been played (so play() moves on rather than replaying it)
  let playing = false;
  let animating = false;
  let run = null; // AbortController of the playback in flight
  let shownAct = null; // the act last announced through onEvent("act")
  let interacted = false;
  let termAt = -1; // the terminal shows the end state of steps 0..termAt
  let shown = null; // the resume state on screen: { state, highlight, proof }

  const emit = (name, params) => {
    try {
      onEvent(name, params);
    } catch (err) {
      console.error(err);
    }
  };

  // --- Rendering -------------------------------------------------------------------------------

  const linesUpTo = (i) => steps.slice(0, i + 1).flatMap((s) => s.lines);

  function showTerminal(i) {
    terminal.reset();
    terminal.renderInstant(linesUpTo(i));
    termAt = i;
  }

  // Puts the replica (and the stage's proof overlay) in a step's resume state.
  function showResume(r, animate) {
    if (!shown || shown.state !== r.state || !animate) resume.render(r.state, { animate });
    resume.highlight(r.highlight ?? []);
    if (stage) {
      // An instant change applies with transitions off; the style flush makes it stick.
      if (!animate) stage.classList.add("is-instant");
      if (r.proof) stage.dataset.proof = r.proof;
      else delete stage.dataset.proof;
      if (!animate) {
        void stage.offsetWidth;
        stage.classList.remove("is-instant");
      }
    }
    shown = r;
  }

  function renderEnd(i) {
    showTerminal(i);
    showResume(steps[i].resume, false);
  }

  // Makes i the current step: announces a new act, marks the controls, reports completion.
  function enter(i, { silent = false } = {}) {
    const from = cur;
    cur = i;
    const a = steps[i].act;
    if (!silent && a !== shownAct) {
      shownAct = a;
      emit("act", { act: a + 1, act_name: acts[a].id });
    }
    updateUI();
    if (!silent && i === last && from !== last) {
      emit("complete", { method: interacted ? "manual" : "autoplay" });
    }
  }

  // Plays step i from the end state of step i - 1.
  async function animate(i, signal) {
    const step = steps[i];
    const before = steps[i - 1]?.resume ?? { state: step.resume.state };
    if (termAt !== i - 1) {
      terminal.reset();
      terminal.renderInstant(i > 0 ? linesUpTo(i - 1) : []);
      termAt = i - 1;
    }
    if (!shown || shown.state !== before.state || shown.proof !== before.proof) {
      showResume(before, false);
      await frames(2, signal); // let the instant state land so CSS transitions start from it
    } else {
      resume.highlight(before.highlight ?? []);
    }
    if (reduced.matches) {
      terminal.renderInstant(step.lines);
    } else {
      await terminal.play(step.lines, { signal });
    }
    termAt = i;
    showResume(step.resume, !reduced.matches);
  }

  function abort() {
    run?.abort();
    run = null;
  }

  async function loop() {
    const ctrl = new AbortController();
    run = ctrl;
    const { signal } = ctrl;
    try {
      for (;;) {
        if (!watched) {
          animating = true;
          await animate(cur, signal);
          if (signal.aborted) return;
          animating = false;
          watched = true;
        }
        if (cur === last) break;
        await wait(steps[cur].hold ?? HOLD, signal);
        if (signal.aborted) return;
        watched = false;
        enter(cur + 1);
      }
      playing = false;
      run = null;
      updateUI();
    } catch (err) {
      if (!signal.aborted) throw err;
    }
  }

  // --- Commands --------------------------------------------------------------------------------

  function goTo(i, opts) {
    const target = Math.max(0, Math.min(last, i));
    abort();
    playing = false;
    animating = false;
    renderEnd(target);
    watched = false;
    enter(target, opts);
  }

  function play() {
    if (playing) return;
    if (cur === last && watched) {
      goTo(0); // replay from the start
    }
    playing = true;
    if (shownAct !== steps[cur].act) enter(cur);
    updateUI();
    loop();
  }

  function pause() {
    if (!playing) return;
    const wasAnimating = animating;
    abort();
    playing = false;
    animating = false;
    if (wasAnimating) {
      renderEnd(cur); // finish the step at once
      watched = true;
    }
    updateUI();
  }

  const toggle = () => (playing ? pause() : play());
  const next = () => goTo(cur + 1);
  const prev = () => goTo(cur - 1);
  const goToAct = (n) => goTo(firstOf[Math.max(1, Math.min(acts.length, n)) - 1]);

  function interact(method) {
    interacted = true;
    emit("interact", { method });
  }

  // --- Controls --------------------------------------------------------------------------------

  let ui = null;
  if (controls) {
    controls.innerHTML = `<div class="ctl" role="group" aria-label="Demo controls">
        <div class="ctl-buttons">
          <button type="button" class="ctl-btn" data-ctl="prev" aria-label="Previous step">${icon("prev")}</button>
          <button type="button" class="ctl-btn ctl-play" data-ctl="play" aria-label="Play">${icon("play")}</button>
          <button type="button" class="ctl-btn" data-ctl="next" aria-label="Next step">${icon("next")}</button>
        </div>
        <ol class="ctl-acts">${acts
          .map(
            (act, a) =>
              `<li><button type="button" class="ctl-act" data-act="${a + 1}" title="${act.title}" aria-label="Act ${a + 1}: ${act.name}"><span class="ctl-num">${a + 1}</span> <span class="ctl-name">${act.name}</span></button></li>`,
          )
          .join("")}</ol>
        <span class="ctl-label" title="A scripted replay of the workflow, not live output">replay</span>
        <div class="ctl-progress" aria-hidden="true"><span></span></div>
      </div>`;
    ui = {
      play: controls.querySelector('[data-ctl="play"]'),
      chips: [...controls.querySelectorAll(".ctl-act")],
      bar: controls.querySelector(".ctl-progress span"),
    };
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
    ui.chips.forEach((chip, a) =>
      chip.addEventListener("click", () => {
        interact("act_chip");
        goToAct(a + 1);
      }),
    );
  }

  function updateUI() {
    const a = steps[cur].act;
    if (stage) {
      stage.dataset.act = acts[a].id;
      stage.classList.toggle("is-playing", playing);
    }
    if (!ui) return;
    ui.play.innerHTML = icon(playing ? "pause" : "play");
    ui.play.setAttribute("aria-label", playing ? "Pause" : "Play");
    ui.chips.forEach((chip, k) => {
      if (k === a) chip.setAttribute("aria-current", "step");
      else chip.removeAttribute("aria-current");
    });
    ui.bar.style.width = `${((cur + 1) / steps.length) * 100}%`;
  }

  // --- Stage: visibility, keys, swipe ----------------------------------------------------------

  // In view: the visible part of the stage covers half the viewport or is half of the stage (a
  // stage taller than two viewports never shows half of itself).
  const covers = (visible, height, viewport) =>
    visible > 0 && visible >= 0.499 * Math.min(height, viewport);
  const inView = () => {
    const r = stage.getBoundingClientRect();
    const visible = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return covers(visible, r.height, innerHeight);
  };
  let seen = false;
  if (stage) {
    const io = new IntersectionObserver(
      ([entry]) => {
        const viewport = entry.rootBounds?.height ?? innerHeight;
        const shown =
          entry.isIntersecting &&
          covers(entry.intersectionRect.height, entry.boundingClientRect.height, viewport);
        if (shown && !seen) {
          seen = true;
          if (!reduced.matches && !interacted && !playing) play();
        }
      },
      { threshold: Array.from({ length: 21 }, (_, k) => k / 20) },
    );
    io.observe(stage);

    document.addEventListener("keydown", (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !inView()) return;
      const active = document.activeElement;
      if (active && active !== document.body && !stage.contains(active)) return;
      let action = null;
      if (e.key === " " && !e.shiftKey) {
        // A focused button already activates on Space.
        if (active?.closest?.("button, a, input, select, textarea")) return;
        action = toggle;
      } else if (e.key === "ArrowRight") action = next;
      else if (e.key === "ArrowLeft") action = prev;
      else if (/^[1-9]$/.test(e.key) && +e.key <= acts.length) action = () => goToAct(+e.key);
      if (!action || e.shiftKey) return;
      e.preventDefault();
      if (e.repeat && e.key === " ") return;
      interact("key");
      action();
    });

    // Touch or pen only: a mouse drag on the terminal selects text. Not on the control bar, whose
    // chip row may scroll sideways, or on other controls marked data-no-swipe.
    let start = null;
    stage.addEventListener("pointerdown", (e) => {
      const onControls = controls?.contains(e.target) || e.target.closest?.("[data-no-swipe]");
      start =
        e.pointerType === "mouse" || onControls
          ? null
          : { x: e.clientX, y: e.clientY, id: e.pointerId };
    });
    stage.addEventListener("pointercancel", () => {
      start = null;
    });
    stage.addEventListener("pointerup", (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      if (Math.abs(dx) <= SWIPE_PX || Math.abs(dx) <= Math.abs(dy)) return;
      interact("swipe");
      if (dx < 0) next();
      else prev();
    });
  }

  goTo(0, { silent: true });

  return {
    play,
    pause,
    toggle,
    next,
    prev,
    goTo,
    goToAct,
    interact,
    get step() {
      return cur;
    },
    get stepCount() {
      return steps.length;
    },
    get act() {
      return steps[cur].act + 1;
    },
    get playing() {
      return playing;
    },
  };
}
