// Wires the page: the language (i18n.js) and theme toggles, the launch film (film.js playing
// scenes.js), the product page below it (page.js), and analytics. Exposes window.__demo = { film,
// events } for the browser tests once the film is ready (and page.js sets window.__page).

import { createFilm } from "./film.js";
import { initLang } from "./i18n.js";
import { initPage, refreshPage } from "./page.js";
import { ACTORS, CUES, SCENES } from "./scenes.js";
import { initTheme } from "./theme.js";

const events = [];

// analytics.js, loaded after the film's first paint; events before it wait in `early`.
let analytics;
const early = [];
function track(name, params) {
  if (analytics) analytics.track(name, params);
  else if (early.length < 16) early.push([name, params]);
}

// The language first: the film and the page are built in it. The toggle only reports: not the
// load, not ?lang.
initLang({
  onChange: (language) => {
    events.push({ name: "language", params: { language } });
    track("language_change", { language });
    film.relang();
    refreshPage();
  },
});

// The toggle only: not the system setting, not the load.
initTheme({
  onChange: (theme) => {
    events.push({ name: "theme", params: { theme } });
    track("theme_change", { theme });
  },
});

// The film's events as analytics sees them: the first interaction, each act once, completion once.
let began = false;
const actsSeen = new Set();
let completed = false;
function report(name, params) {
  if (name === "interact" && !began) {
    began = true;
    track("tutorial_begin", { method: params.method });
  } else if (name === "act" && !actsSeen.has(params.act)) {
    actsSeen.add(params.act);
    track("demo_act", { act: params.act, act_name: params.act_name });
  } else if (name === "complete" && !completed) {
    completed = true;
    track("tutorial_complete", { method: params.method });
  }
}

async function loadAnalytics() {
  try {
    const module = await import("./analytics.js");
    module.start(location);
    analytics = module;
    for (const [name, params] of early.splice(0)) analytics.track(name, params);
  } catch {
    // Analytics never stops the film.
  }
}

const film = createFilm({
  scenes: SCENES,
  cues: CUES,
  actors: ACTORS,
  root: document.getElementById("film"),
  onEvent(name, params) {
    events.push({ name, params });
    report(name, params);
  },
});
film.ready.then(() => {
  window.__demo = { film, events };
});

initPage();

// index.html?kit: the cast and pen kit instead of the page (kit.js).
if (new URLSearchParams(location.search).has("kit")) import("./kit.js").then((m) => m.renderKit());

requestAnimationFrame(() => requestAnimationFrame(loadAnalytics));
