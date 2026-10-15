// Wires the demo stage: the resume replica, the emulated terminal, and the timeline player, and
// scales the replica to fit its column. Exposes window.__demo for the browser tests.
//
// Desktop (≥ 800 px): terminal | page. The terminal keeps at least TERM_COLS columns of its own
// font and TERM_SHARE of the width; the page column takes the rest, and the whole spread is
// scaled to fit it (by height when it can, so one page fills the column's height). Phone: one
// page at a time at the column's full width, with a page switch when there are two; the terminal
// below gets what is left of the screen (style.css, from --page-h). A page-count change zooms
// (CSS transitions on --s and --sw); a resize or an instant state change doesn't.

import { ACTS } from "./acts.js";
import { createPlayer } from "./player.js";
import { createResume } from "./resume.js";
import { createTerminal } from "./terminal.js";

const PAGE_W = 816;
const PAGE_GAP = 48; // between pages in the spread (resume.js)
const TERM_COLS = 62;
const TERM_SHARE = 0.35; // of the stage's width, so wide windows don't squeeze the terminal
const MIN_TERM = 360;

const stage = document.getElementById("stage");
const pageCol = document.getElementById("page-col");
const pageBox = document.getElementById("page-box");
const pageSwitch = document.getElementById("page-switch");
const term = document.getElementById("term");
const resume = createResume(document.getElementById("resume-host"));
const terminal = createTerminal(term);
const stacked = matchMedia("(max-width: 799px)");

let shownPage = 0; // the page shown on a phone
let lastPages = resume.pageCount();

// Width of one character in the terminal's font.
const probe = document.createElement("span");
probe.textContent = "0".repeat(20);
probe.setAttribute("aria-hidden", "true");
probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;pointer-events:none";
term.append(probe);
const charWidth = () => probe.getBoundingClientRect().width / 20;

const px = (v) => parseFloat(v) || 0;

// Sets the page box's scale, shown width, and offset (style.css). Unless animated, the change
// lands at once (transitions are off for that style flush).
function setVars(vars, animate) {
  if (!animate) stage.classList.add("is-fitting");
  for (const [name, value] of Object.entries(vars)) pageBox.style.setProperty(name, value);
  if (!animate) {
    void stage.offsetWidth;
    stage.classList.remove("is-fitting");
  }
}

function fit({ animate = false } = {}) {
  const pages = resume.pageCount();
  if (pages !== lastPages) shownPage = 0;
  lastPages = pages;
  shownPage = Math.min(shownPage, pages - 1);
  const { width, height } = resume.spreadSize();
  const cs = getComputedStyle(pageCol);
  const padX = px(cs.paddingLeft) + px(cs.paddingRight);
  const padY = px(cs.paddingTop) + px(cs.paddingBottom);
  let scale;
  let viewW = width;
  let termMin = MIN_TERM;
  if (stacked.matches) {
    viewW = PAGE_W;
    scale = (pageCol.clientWidth - padX) / PAGE_W;
  } else {
    const ts = getComputedStyle(term);
    const ss = getComputedStyle(stage);
    const inner = stage.clientWidth - px(ss.paddingLeft) - px(ss.paddingRight);
    termMin = Math.ceil(
      Math.max(
        MIN_TERM,
        TERM_COLS * charWidth() + px(ts.paddingLeft) + px(ts.paddingRight),
        TERM_SHARE * inner,
      ),
    );
    const availW = inner - termMin - px(ss.columnGap) - padX;
    const availH = pageCol.clientHeight - padY;
    scale = Math.min(availH / height, availW / width);
  }
  scale = Math.max(0.1, scale);
  stage.dataset.pages = pages;
  setVars(
    {
      "--s": scale,
      "--sw": viewW,
      "--off": stacked.matches ? shownPage * (PAGE_W + PAGE_GAP) : 0,
    },
    animate,
  );
  stage.style.setProperty("--term-min", `${termMin}px`);
  // The phone layout sizes the terminal from the page column's final height.
  stage.style.setProperty("--page-h", `${Math.ceil(height * scale + padY)}px`);
  for (const button of pageSwitch.querySelectorAll("button[data-page]")) {
    button.setAttribute("aria-pressed", String(+button.dataset.page === shownPage + 1));
  }
}

pageSwitch.addEventListener("click", (e) => {
  const button = e.target.closest("button[data-page]");
  if (!button) return;
  shownPage = +button.dataset.page - 1;
  fit({ animate: true });
});

resume.onPagesChange(() => fit({ animate: !stage.classList.contains("is-instant") }));
new ResizeObserver(() => fit()).observe(stage);
stacked.addEventListener("change", () => fit());

const events = [];
const player = createPlayer({
  acts: ACTS,
  terminal,
  resume,
  stage,
  controls: document.getElementById("controls"),
  onEvent(name, params) {
    events.push({ name, params });
  },
});
fit();

window.__demo = { player, resume, events };
