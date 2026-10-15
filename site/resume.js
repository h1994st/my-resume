// HTML replica of the resume template (common/resume.cls), rendered from site/resume-data.js.
//
// createResume(container) → { render(stateKey, {animate}), highlight(ids), pageCount(),
//                             onPagesChange(callback), spreadSize() }
//
// Pagination: the content flows through one CSS multi-column box whose columns are exactly a
// page's content area (US Letter at 96 px/in, 0.6in margins), so overflow becomes page 2 to the
// right. White page sheets with "Page N of M" footers sit behind the columns. The spread has a
// fixed unscaled size (spreadSize()); the caller scales it. Like the template's \resume@needspace,
// a section heading moves to the next page when less than its reserved space is left.
//
// render(..., {animate: true}) animates with FLIP: old rects are measured by data-id, the new
// state is rendered, moved elements play from their old position, exiting elements fade out in
// place as ghost clones, entering ones fade in. prefers-reduced-motion disables all motion.

import { PROFILE, STATES } from "./resume-data.js";

const PT = 96 / 72; // CSS px per TeX pt
const PAGE_W = 816; // 8.5in
const PAGE_H = 1056; // 11in
const MARGIN = 0.6 * 96;
const COL_W = PAGE_W - 2 * MARGIN;
const COL_H = PAGE_H - 2 * MARGIN;
const PAGE_GAP = 48; // between sheets in the spread
const COL_GAP = PAGE_GAP + 2 * MARGIN;
const LINE = 13.9 * PT; // \baselineskip
const SECTION_SKIP = 10.5 * PT; // \addvspace before a section heading

// Space a heading needs left on the page, as in \resume@heading[#1]: 8 lines by default,
// 3 lines for publications, service, and honors.
const NEED = { publications: 3, service: 3, honors: 3 };
const SPINE = new Set(["experience", "projects"]);

const EXIT_MS = 200;
const MOVE_MS = 360;
const ENTER_MS = 280;
const EASE_OUT = "cubic-bezier(0.2, 0.7, 0.2, 1)";

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const rest = (...parts) =>
  parts
    .filter(Boolean)
    .map((p) => `, ${esc(p)}`)
    .join("");

// --- Markup --------------------------------------------------------------------------------

function header(state) {
  const headline = state.headline
    ? `<div class="r-headline" data-id="headline">${esc(state.headline)}</div>`
    : "";
  return `<header class="r-header">
      <div class="r-header-main"><div class="r-name" data-id="name">${esc(PROFILE.name)}</div>${headline}</div>
      <div class="r-contact" data-id="contact"><div>${esc(PROFILE.email)}</div><div>${esc(PROFILE.homepage)}</div><div>${esc(PROFILE.phone)}</div></div>
    </header>
    <div class="r-bar" data-id="bar"></div>`;
}

const heading = (id, title) =>
  `<h2 class="r-head" data-id="sec:${id}"><span class="r-tab">${esc(title)}</span><span class="r-rule"></span></h2>`;

const pill = (dates) => `<span class="r-pill">${esc(dates)}</span>`;

const demo = (item) => (item.demo ? " data-demo" : "");

function entryHead(item, first) {
  const title =
    item.kind === "role"
      ? `<b>${esc(item.title)}</b>${rest(item.org, item.location)}`
      : `<b>${esc(item.title)}</b>${rest(item.org)}`;
  const sub =
    item.kind === "project" && item.link
      ? `<div class="r-sub">${esc(item.link)}${item.note ? ` (${esc(item.note)})` : ""}</div>`
      : "";
  return `<div class="r-entry${first ? "" : " r-gap"}" data-id="${esc(item.id)}"${demo(item)}>
      <span class="r-node"></span>
      <div class="r-line"><span class="r-title">${title}</span>${pill(item.dates)}</div>${sub}
    </div>`;
}

const bullet = (b) => `<div class="r-bullet" data-id="${esc(b.id)}">${esc(b.text)}</div>`;

function authors(text) {
  return esc(text).replace(esc(PROFILE.name), `<b>${esc(PROFILE.name)}</b>`);
}

function block(item, first) {
  const gap = first ? "" : " r-gap";
  switch (item.kind) {
    case "degree":
      return `<div class="r-degree${gap}" data-id="${esc(item.id)}">
          <div class="r-line"><span class="r-title"><b>${esc(item.school)}</b>${rest(item.location)} — ${esc(item.degree)}</span><span class="r-date">${esc(item.dates)}</span></div>
          ${item.dissertation ? `<div class="r-sub">Dissertation: ${esc(item.dissertation)}</div>` : ""}
        </div>`;
    case "pub": {
      const award = item.award ? ` <span class="r-award">${esc(item.award)}</span>` : "";
      return `<div class="r-pub${gap}" data-id="${esc(item.id)}"><span class="r-num">[${item.n}]</span>${esc(item.title)} ${esc(item.venue)}${award}<br>${authors(item.authors)}</div>`;
    }
    case "line":
      return `<div class="r-lineitem${gap}" data-id="${esc(item.id)}"><span>${esc(item.text)}</span><span class="r-date">${esc(item.years)}</span></div>`;
  }
  throw new Error(`unknown item kind ${item.kind}`);
}

// A spine section (Experience, Projects). The heading, the first entry's title line, and its
// first bullet stay together (the template's \nobreak chain); later bullets and entries may move
// to the next page. Each entry title line keeps its first bullet.
function spineSection(section) {
  const parts = [];
  section.items.forEach((item, i) => {
    const [first, ...more] = item.bullets ?? [];
    parts.push(
      `<div class="r-keep">${entryHead(item, i === 0)}${first ? bullet(first) : ""}</div>`,
    );
    parts.push(...more.map(bullet));
  });
  const [lead, ...others] = parts;
  return `<div class="r-keep">${heading(section.id, section.title)}<div class="r-spine">${lead}</div></div>${
    others.length ? `<div class="r-spine">${others.join("")}</div>` : ""
  }`;
}

function plainSection(section) {
  const [first, ...more] = section.items.map((item, i) => block(item, i === 0));
  return `<div class="r-keep">${heading(section.id, section.title)}${first ?? ""}</div>${more.join("")}`;
}

function sectionMarkup(id, body) {
  const spine = SPINE.has(id) ? " r-sec-spine" : "";
  return `<section class="r-sec${spine}" data-sec="${esc(id)}">${body}</section>`;
}

function markup(state) {
  let html = header(state);
  if (state.summary !== undefined) {
    const skills = (state.skills ?? [])
      .map(
        ([label, value]) =>
          `<div class="r-skill" data-id="skill:${esc(label)}"><span class="r-skill-label">${esc(label)}</span><span>${esc(value)}</span></div>`,
      )
      .join("");
    html += sectionMarkup(
      "summary",
      `<div class="r-keep">${heading("summary", "Summary")}<p class="r-summary" data-id="summary">${esc(state.summary)}</p></div>${skills}`,
    );
  }
  for (const section of state.sections ?? []) {
    const body = SPINE.has(section.id) ? spineSection(section) : plainSection(section);
    html += sectionMarkup(section.id, body);
  }
  return html;
}

// --- Component -----------------------------------------------------------------------------

export function createResume(container) {
  const root = document.createElement("div");
  root.className = "resume";
  root.innerHTML = `<div class="r-sheets"></div><div class="r-flow"></div><div class="r-ghosts" aria-hidden="true"></div>`;
  const sheets = root.querySelector(".r-sheets");
  const flow = root.querySelector(".r-flow");
  const ghosts = root.querySelector(".r-ghosts");
  container.append(root);

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const listeners = new Set();
  let current = null;
  let pages = 1;
  let highlighted = new Set();

  const scale = () => root.getBoundingClientRect().width / root.offsetWidth || 1;

  // Rect of el in unscaled spread coordinates.
  function rectOf(el, base = root.getBoundingClientRect(), s = scale()) {
    const r = el.getBoundingClientRect();
    return {
      x: (r.left - base.left) / s,
      y: (r.top - base.top) / s,
      w: r.width / s,
      h: r.height / s,
    };
  }

  function spreadSize() {
    return { width: pages * PAGE_W + (pages - 1) * PAGE_GAP, height: PAGE_H };
  }

  // Emulates \resume@needspace, then counts pages and draws the sheets.
  function paginate() {
    const secs = flow.querySelectorAll(".r-sec");
    for (const sec of secs) sec.classList.remove("r-break");
    for (const sec of secs) {
      const y = rectOf(sec.querySelector(".r-head"), flow.getBoundingClientRect()).y;
      if (y < 1) continue; // already starts a page
      const left = COL_H - (y - SECTION_SKIP); // space left in the column before the heading
      if (left < (NEED[sec.dataset.sec] ?? 8) * LINE) sec.classList.add("r-break");
    }
    const count = Math.max(1, Math.round((flow.scrollWidth + COL_GAP) / (COL_W + COL_GAP)));
    pages = count;
    const { width, height } = spreadSize();
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
    sheets.innerHTML = Array.from(
      { length: count },
      (_, i) =>
        `<div class="r-sheet" style="left:${i * (PAGE_W + PAGE_GAP)}px"><div class="r-foot">Page ${i + 1} of ${count}</div></div>`,
    ).join("");
  }

  function notify() {
    for (const cb of listeners) cb(pages);
  }

  function applyHighlight() {
    for (const el of flow.querySelectorAll("[data-id]")) {
      el.classList.toggle("is-hl", highlighted.has(el.dataset.id));
    }
  }

  function stopAnimations() {
    for (const a of root.getAnimations({ subtree: true })) a.cancel();
    ghosts.replaceChildren();
    for (const g of sheets.querySelectorAll(".r-ghost")) g.remove();
  }

  function snapshot() {
    const base = root.getBoundingClientRect();
    const s = scale();
    const items = new Map();
    for (const el of flow.querySelectorAll("[data-id]")) {
      items.set(el.dataset.id, { el, rect: rectOf(el, base, s), text: el.textContent });
    }
    return { items, sheets: [...sheets.children] };
  }

  // A fading copy of an element's old rendering, left in place while the new one appears.
  function ghost(old) {
    const clone = old.el.cloneNode(true);
    clone.removeAttribute("data-id");
    clone.classList.add("r-ghost");
    Object.assign(clone.style, {
      position: "absolute",
      left: `${old.rect.x}px`,
      top: `${old.rect.y}px`,
      width: `${old.rect.w}px`,
      height: `${old.rect.h}px`,
      margin: "0",
    });
    ghosts.append(clone);
    clone
      .animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: EXIT_MS,
        easing: "ease-out",
        fill: "forwards",
      })
      .finished.then(
        () => clone.remove(),
        () => clone.remove(),
      );
  }

  function play(before) {
    const base = root.getBoundingClientRect();
    const s = scale();
    const seen = new Set();
    for (const el of flow.querySelectorAll("[data-id]")) {
      const id = el.dataset.id;
      const old = before.items.get(id);
      const fadeIn = (delay) =>
        el.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: ENTER_MS,
          delay,
          easing: "ease-out",
          fill: "backwards",
        });
      if (!old) {
        fadeIn(MOVE_MS); // entering: after exits and moves
        continue;
      }
      seen.add(id);
      const now = rectOf(el, base, s);
      const dx = old.rect.x - now.x;
      const dy = old.rect.y - now.y;
      const moved = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;
      if (old.text !== el.textContent) {
        // Changed text: the old version fades out in place while the new one fades in.
        ghost(old);
        fadeIn(EXIT_MS / 2);
      } else if (moved) {
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
          duration: MOVE_MS,
          delay: EXIT_MS / 2,
          easing: EASE_OUT,
          fill: "backwards",
        });
      }
    }
    for (const [id, old] of before.items) if (!seen.has(id)) ghost(old);
    // Page sheets: removed ones fade out after the content has moved, added ones fade in.
    const now = [...sheets.children];
    before.sheets.slice(now.length).forEach((sheet) => {
      sheet.classList.add("r-ghost");
      sheets.append(sheet);
      sheet
        .animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: ENTER_MS,
          delay: MOVE_MS,
          fill: "forwards",
        })
        .finished.then(
          () => sheet.remove(),
          () => sheet.remove(),
        );
    });
    now.slice(before.sheets.length).forEach((sheet) => {
      sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ENTER_MS, easing: "ease-out" });
    });
  }

  function render(stateKey, { animate = false } = {}) {
    const state = STATES[stateKey];
    if (!state) throw new Error(`unknown resume state "${stateKey}"`);
    stopAnimations();
    const before = animate && !reduced.matches && current !== null ? snapshot() : null;
    flow.innerHTML = markup(state);
    paginate();
    applyHighlight();
    if (before) play(before);
    current = stateKey;
    notify();
  }

  // Fonts arriving after the first render change line breaks, so paginate again.
  const relayout = () => {
    if (current === null) return;
    const old = pages;
    paginate();
    if (pages !== old) notify();
  };
  document.fonts?.addEventListener?.("loadingdone", relayout);
  document.fonts?.ready.then(relayout);

  return {
    render,
    highlight(ids = []) {
      highlighted = new Set(ids);
      applyHighlight();
    },
    pageCount: () => pages,
    onPagesChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    spreadSize,
  };
}
