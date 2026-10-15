// The kit page (index.html?kit; not linked): the three cats in every pose and every pen mark and
// note, on the desk in the current theme. For the browser tests and for whoever builds scenes.
// Sets window.__kit = { ready: true } once everything is drawn.

import { CATS, POSES, createCat } from "./cast.js";
import { clearPen, mark, markInstant, note, noteInstant } from "./pen.js";

const TARGETS = [
  ["circle", "Patrol at night, detect rodents early"],
  ["underline", "Train the younger cats"],
  ["strike", "Negotiated a mutual-ignorance treaty with the dog"],
  ["arrow", "Monitored 400+ birds and 37 squirrels a day"],
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export async function renderKit() {
  document.body.classList.add("is-kit");
  const kit = el("main", "kit");
  kit.setAttribute("aria-label", "Cast and pen kit");

  kit.append(el("h2", null, "Cast"));
  const cast = el("div", "kit-cast");
  for (const name of Object.keys(CATS)) {
    const row = el("section", "kit-row");
    row.append(el("h3", null, CATS[name].label));
    for (const pose of POSES) {
      const cell = el("figure", "kit-cell");
      cell.append(createCat(name, { pose }), el("figcaption", null, pose));
      row.append(cell);
    }
    cast.append(row);
  }
  kit.append(cast);

  kit.append(el("h2", null, "Pen"));
  const desk = el("div", "kit-desk");
  desk.dataset.penLayer = "";
  const paper = el("div", "kit-paper");
  paper.dataset.paper = "";
  paper.dataset.penLayer = "";
  paper.append(el("strong", null, "Senior Mouser, Granary & Sons"));
  for (const [kind, text] of TARGETS) {
    const line = el("p");
    const target = el("span", null, text);
    target.dataset.kitTarget = kind;
    line.append(target);
    paper.append(line);
  }
  const replay = el("button", "kit-replay", "Replay");
  replay.type = "button";
  desk.append(paper);
  kit.append(desk, replay);
  document.body.append(kit);

  // Text must be in its final font before marks and notes measure it.
  await Promise.all([
    document.fonts.load("400 26px Caveat"),
    document.fonts.load("600 26px Caveat"),
    document.fonts.ready,
  ]);
  const target = (kind) => paper.querySelector(`[data-kit-target="${kind}"]`);
  const draw = async (animate) => {
    clearPen(paper);
    clearPen(desk);
    const m = animate ? mark : markInstant;
    const n = animate ? note : noteInstant;
    const arrow = target("arrow");
    const from = { x: arrow.offsetLeft + arrow.offsetWidth + 64, y: arrow.offsetTop - 2 };
    await m(target("circle"), "circle");
    await m(target("underline"), "underline");
    await m(target("strike"), "strike");
    await m(arrow, "arrow", { from });
    await n("moved up!", { x: from.x + 8, y: from.y - 22 }, { layer: paper });
    await n("which one is true? 🙀", paper, { layer: desk, side: "right", gap: 28 });
    await n(
      "asks first.\nno fibs. 🐟",
      { x: 24, y: paper.offsetTop + paper.offsetHeight + 18 },
      {
        layer: desk,
        rotate: 2,
        weight: 400,
      },
    );
  };
  await draw(false);
  replay.addEventListener("click", () => draw(true));
  window.__kit = { ready: true };
}
