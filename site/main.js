// Wires the demo stage: the resume replica, the emulated terminal, and the timeline player, and
// scales the replica's page spread to fit its column. Exposes window.__demo for the browser tests.

import { ACTS } from "./acts.js";
import { createPlayer } from "./player.js";
import { createResume } from "./resume.js";
import { createTerminal } from "./terminal.js";

const stage = document.getElementById("stage");
const pageCol = document.getElementById("page-col");
const pageBox = document.getElementById("page-box");
const resume = createResume(document.getElementById("resume-host"));
const terminal = createTerminal(document.getElementById("term"));

// Fits the unscaled spread (resume.spreadSize()) into the page column: on desktop the column
// takes what the terminal's minimum width leaves; stacked (phone), the full width.
const MIN_TERM = 360; // the terminal column's minimum width (style.css: minmax(360px, 1fr))
const stacked = matchMedia("(max-width: 799px)");
function fit() {
  const { width, height } = resume.spreadSize();
  const cs = getComputedStyle(pageCol);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  let scale;
  if (stacked.matches) {
    scale = (pageCol.clientWidth - padX) / width;
  } else {
    const ss = getComputedStyle(stage);
    const gap = parseFloat(ss.columnGap) || 0;
    const stagePad = parseFloat(ss.paddingLeft) + parseFloat(ss.paddingRight);
    const availW = stage.clientWidth - stagePad - MIN_TERM - gap - padX;
    const availH = pageCol.clientHeight - padY;
    scale = Math.min(availH / height, availW / width);
  }
  scale = Math.max(0.1, scale);
  pageBox.style.setProperty("--s", scale);
  pageBox.style.width = `${width * scale}px`;
  pageBox.style.height = `${height * scale}px`;
}
resume.onPagesChange(fit);
new ResizeObserver(fit).observe(stage);

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
