// Google Analytics 4 for the hosted page only (shengtuo.me): page views and a few demo events.
// main.js loads this after the stage's first paint and calls `start`, then `track` per event.
// Nothing here may stop the demo: every step is wrapped, and off the site (127.0.0.1 for local
// tests) or when Google's script is blocked, `track` does nothing. `?analytics=debug` turns events
// on anywhere without loading Google's script: they only go into `window.dataLayer`.

const MEASUREMENT_ID = "G-ZMH6NLL7C7";
const GTAG_URL = "https://www.googletagmanager.com/gtag/js";
const HOSTS = ["shengtuo.me", "h1994st.github.io"];

let on = false;

export function start(page) {
  try {
    const debug = new URLSearchParams(page.search).get("analytics") === "debug";
    if (!debug && !HOSTS.includes(page.hostname)) return false;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() {
      window.dataLayer.push(arguments);
    };
    window.gtag("js", new Date());
    window.gtag("config", MEASUREMENT_ID, { content_group: "my-resume" });
    on = true;
    if (!debug) {
      const script = document.createElement("script");
      script.async = true;
      script.src = `${GTAG_URL}?id=${MEASUREMENT_ID}`;
      script.addEventListener("error", () => {
        on = false;
      });
      document.head.append(script);
    }
  } catch {
    on = false;
  }
  return on;
}

export function track(name, params) {
  if (!on) return;
  try {
    window.gtag("event", name, params);
  } catch {
    // Analytics never stops the demo.
  }
}
