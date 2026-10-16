#!/usr/bin/env node
// Browser tests for the site: headless Chrome driven over the DevTools protocol with Node's
// built-ins only (global WebSocket, node:http, node:assert, node:child_process). No npm.
//
// Usage:  site/assemble.sh build/site .   (after `just build` and `just build applications/…`)
//         node site/tests/browser.mjs [--tier smoke|full] [name-filter]
// Env:    CHROME=<path to Chrome>  (default: the macOS app, else `google-chrome` on PATH)
//         SITE_DIR=<dir to serve>  (default: build/site)
//         BROWSER_TESTS=smoke|full  (the tier when --tier is not given)
// Tiers: `full` runs every test (the default locally); `smoke` runs the tests named in SMOKE, a
// quick pass with no screenshots and no playback beyond one ?speed=16 page (the default when CI
// is set). Screenshots go to build/site-shots/. Prints one line per test and the total time;
// exits 1 if any test fails.
//
// Adding a test: test("name", async ({ newPage }) => { const page = await newPage({ width, height,
// media }); await page.goto("/"); assert.equal(await page.eval(() => 1 + 1), 2); }), and its name
// in SMOKE to run it in the smoke tier too. Pages are closed after the test, and an uncaught
// exception in any page fails the test.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SITE = path.resolve(process.env.SITE_DIR ?? path.join(REPO, "build/site"));
const SHOTS = path.join(REPO, "build/site-shots");
// A checkout of main (the template), for its README.
const TEMPLATE = path.resolve(process.env.TEMPLATE_DIR ?? path.join(REPO, "template"));
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TEST_TIMEOUT = 90_000;

// --- Static server ---------------------------------------------------------------------------

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function serve(root) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!existsSync(file)) return res.writeHead(404).end("not found");
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })),
  );
}

// --- Chrome and the DevTools protocol --------------------------------------------------------

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  if (existsSync(MAC_CHROME)) return MAC_CHROME;
  return "google-chrome";
}

function launchChrome() {
  const profile = mkdtempSync(path.join(tmpdir(), "site-tests-"));
  const proc = spawn(
    chromePath(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--hide-scrollbars",
      // CI runners (containers, restricted user namespaces) can't use Chrome's sandbox.
      ...(process.env.CI ? ["--no-sandbox"] : []),
      // A desktop page has a mouse, (hover: hover) and (pointer: fine), on any host: headless
      // Chrome on a Linux runner has no pointing device and reports none. (CDP's
      // setEmulatedMedia ignores hover and pointer.) A phone page's touch emulation still gives
      // (hover: none) and (pointer: coarse).
      "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  const cleanup = async () => {
    proc.kill();
    await Promise.race([exited, sleep(3000)]);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A leftover temp profile is harmless.
    }
  };
  const url = new Promise((resolve, reject) => {
    let err = "";
    proc.stderr.on("data", (chunk) => {
      err += chunk;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    proc.on("error", reject);
    proc.on("exit", (code) => reject(new Error(`Chrome exited (${code}): ${err}`)));
  });
  return { url, cleanup };
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p?.resolve(msg.result);
      } else {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

// Key definitions for Input.dispatchKeyEvent (as Chrome expects them).
const KEYS = {
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  ...Object.fromEntries(
    "123456789".split("").map((d) => [d, { key: d, code: `Digit${d}`, keyCode: 48 + +d, text: d }]),
  ),
};

class Page {
  constructor(cdp, sessionId, targetId, base) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.base = base;
    this.errors = [];
    this.off = cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        this.errors.push(d.exception?.description ?? d.text);
      }
      for (const w of this.waiters) w(msg);
    });
    this.waiters = new Set();
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  event(name, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(w);
        reject(new Error(`timed out waiting for ${name}`));
      }, timeout);
      const w = (msg) => {
        if (msg.method !== name) return;
        clearTimeout(timer);
        this.waiters.delete(w);
        resolve(msg.params);
      };
      this.waiters.add(w);
    });
  }

  async viewport(width, height, { mobile = false, deviceScaleFactor = 1 } = {}) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
    if (mobile) await this.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  }

  // media: [{ name: "prefers-reduced-motion", value: "reduce" }, ...]
  media(features = []) {
    return this.send("Emulation.setEmulatedMedia", { features });
  }

  // Navigates and waits for the load event, fonts, and the demo (window.__demo).
  async goto(url = "/", { waitForDemo = true } = {}) {
    const loaded = this.event("Page.loadEventFired");
    await this.send("Page.navigate", { url: new URL(url, this.base).href });
    await loaded;
    await this.eval(() => document.fonts.ready.then(() => true));
    if (waitForDemo) await this.waitFor(() => Boolean(window.__demo));
  }

  // Evaluates fn(...args) in the page (or a string expression); awaits promises; returns by value.
  async eval(fn, ...args) {
    const expression =
      typeof fn === "function" ? `(${fn})(...${JSON.stringify(args)})` : String(fn);
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (exceptionDetails) {
      throw new Error(`page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    }
    return result.value;
  }

  // Polls fn(...args) in the page until it returns a truthy value.
  async waitFor(fn, { timeout = 10_000, args = [] } = {}) {
    const start = Date.now();
    for (;;) {
      const value = await this.eval(fn, ...args);
      if (value) return value;
      if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${fn}`);
      await sleep(50);
    }
  }

  // Waits n animation frames in the page.
  frames(n = 2) {
    return this.eval(
      (count) =>
        new Promise((resolve) => {
          const tick = (left) => (left ? requestAnimationFrame(() => tick(left - 1)) : resolve(1));
          tick(count);
        }),
      n,
    );
  }

  // A real key press through Chrome's input pipeline (default actions such as scrolling apply).
  async key(name) {
    const k = KEYS[name];
    if (!k) throw new Error(`no key definition for ${name}`);
    const common = {
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      nativeVirtualKeyCode: k.keyCode,
    };
    await this.send("Input.dispatchKeyEvent", {
      type: k.text ? "keyDown" : "rawKeyDown",
      text: k.text,
      unmodifiedText: k.text,
      ...common,
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  }

  // Runs every WAAPI and CSS animation n times faster (the page's timers: ?speed=n).
  async animationSpeed(n) {
    await this.send("Animation.enable");
    await this.send("Animation.setPlaybackRate", { playbackRate: n });
  }

  // A touch tap at (x, y) in CSS px.
  async tap(x, y) {
    await this.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  // The mouse pointer moved to (x, y) in CSS px.
  mouse(x, y) {
    return this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  // A real left click on the middle of the element `selector` matches (it takes focus).
  async click(selector) {
    const { x, y } = await this.eval((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, selector);
    await this.mouse(x, y);
    const press = { x, y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...press });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...press });
  }

  // A touch swipe from (x0, y0) to (x1, y1) in CSS px.
  async swipe(x0, y0, x1, y1, steps = 8) {
    const point = (x, y) => [{ x, y, id: 1 }];
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(x0, y0) });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t),
      });
    }
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  async screenshot(name) {
    mkdirSync(SHOTS, { recursive: true });
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(SHOTS, `${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }

  // A screenshot of one element's whole box, beyond the viewport if need be.
  async screenshotOf(selector, name) {
    const clip = await this.eval((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
    }, selector);
    mkdirSync(SHOTS, { recursive: true });
    const { data } = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { ...clip, scale: 1 },
    });
    const file = path.join(SHOTS, `${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }

  async close() {
    this.off();
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Registry and runner ---------------------------------------------------------------------

const TESTS = [];
function test(name, fn) {
  TESTS.push({ name, fn });
}

// The smoke tier (each also runs in full): loads, end frames by jump, themes, reduced motion,
// analytics, the call to action, the sections' text, and the head. Names must match a test.
const SMOKE = new Set([
  "smoke: the page loads without errors in light and dark",
  "smoke: every scene's end frame by jump at 1920×1080 and 390×844",
  "smoke: the sections' verified text and the README's quick start",
  "film: scene 9's call to action is a real link, outside the aria-hidden world",
  "film: reduced motion: no autoplay, camera cuts, end frames at once",
  "sections: each close-up's pen mark sits on what it names in the real PDF",
  "head: title, description, theme colour, Open Graph image, favicon",
  "theme: the toggle sets data-theme and keeps it across a reload",
  "theme: a stored theme applies before the first paint",
  "theme: the toggle shows the theme on screen before main.js runs",
  "analytics: debug mode fills dataLayer with the exact event sequence",
  "analytics: off the site (127.0.0.1) nothing is set up or loaded",
]);
const TIERS = ["smoke", "full"];

// --tier smoke|full (or --tier=…), else BROWSER_TESTS, else smoke in CI and full elsewhere; the
// first other argument filters tests by name.
function parseArgs(argv) {
  let tier = null;
  let filter = "";
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--tier(?:=(.*))?$/);
    if (m) tier = m[1] ?? argv[++i];
    else if (!filter) filter = argv[i];
  }
  tier ??= process.env.BROWSER_TESTS || (process.env.CI ? "smoke" : "full");
  if (!TIERS.includes(tier)) {
    console.error(`unknown tier "${tier}" (${TIERS.join(" or ")})`);
    process.exit(2);
  }
  return { tier, filter };
}

async function main() {
  if (!existsSync(path.join(SITE, "index.html"))) {
    console.error(`no site at ${SITE}; run site/assemble.sh build/site . first`);
    process.exit(2);
  }
  const { tier, filter } = parseArgs(process.argv.slice(2));
  const names = new Set(TESTS.map((t) => t.name));
  const unknown = [...SMOKE].filter((n) => !names.has(n));
  if (unknown.length) {
    console.error(`SMOKE names no test: ${unknown.join("; ")}`);
    process.exit(2);
  }
  const selected = TESTS.filter(
    (t) => (tier === "full" || SMOKE.has(t.name)) && t.name.includes(filter),
  );
  console.log(`tier ${tier}: ${selected.length} of ${TESTS.length} tests`);
  const started = Date.now();
  const { server, port } = await serve(SITE);
  const base = `http://127.0.0.1:${port}/`;
  const chrome = launchChrome();
  let failed = 0;
  try {
    const cdp = await CDP.connect(await chrome.url);
    for (const { name, fn } of selected) {
      const pages = [];
      const newPage = async ({
        width = 1280,
        height = 720,
        mobile,
        deviceScaleFactor,
        media,
      } = {}) => {
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        const page = new Page(cdp, sessionId, targetId, base);
        pages.push(page);
        await page.send("Page.enable");
        await page.send("Runtime.enable");
        await page.viewport(width, height, { mobile, deviceScaleFactor });
        if (media) await page.media(media);
        return page;
      };
      const start = Date.now();
      try {
        let timer;
        await Promise.race([
          fn({ newPage, base }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("test timed out")), TEST_TIMEOUT);
          }),
        ]).finally(() => clearTimeout(timer));
        for (const page of pages) {
          assert.deepEqual(page.errors, [], "uncaught exceptions in the page");
        }
        console.log(`ok   ${name} (${Date.now() - start} ms)`);
      } catch (err) {
        failed++;
        console.log(`FAIL ${name}: ${err.message.split("\n").join("\n     ")}`);
      } finally {
        for (const page of pages) await page.close();
      }
    }
  } finally {
    await chrome.cleanup();
    server.close();
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${failed ? `${failed} failed` : "all passed"} (tier ${tier}, ${secs} s)`);
  process.exit(failed ? 1 : 0);
}

// --- Helpers shared by the tests -------------------------------------------------------------

const REDUCED = [{ name: "prefers-reduced-motion", value: "reduce" }];

// Everything a film frame shows, measured: each actor (place, pose, highlight, text), each pen
// mark and note (where, which path, how far drawn), the camera, and the caption; plus the
// film's state and the script animations still running (CSS pose loops don't count). Two equal
// snapshots are the same frame.
const frameState = (page) =>
  page.eval(() => {
    const { film } = window.__demo;
    const world = film.world;
    const hash = (s) => {
      let h = 2166136261;
      for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619);
      return (h >>> 0).toString(16);
    };
    const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
    const actors = [...world.querySelectorAll(":scope > [data-actor]")]
      .map((el) => {
        const cs = getComputedStyle(el);
        return {
          id: el.dataset.actor,
          kind: el.dataset.kind,
          box: [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight],
          rotate: cs.rotate,
          z: cs.zIndex,
          moved: [cs.translate, cs.scale, cs.opacity],
          pose: el.dataset.pose ?? null,
          proof: el.dataset.proof ?? null,
          hl: el.querySelectorAll(".is-hl").length,
          text: hash(text(el)),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const pen = [...world.querySelectorAll(".pen-mark, .pen-note")].map((el) => ({
      layer: el.parentElement.dataset.actor ?? "world",
      cls: el.getAttribute("class"),
      kind: el.dataset.kind ?? null,
      ink: el.dataset.ink,
      at: [el.style.left, el.style.top],
      d: [...el.querySelectorAll("path")].map((p) => p.getAttribute("d")).join(" | "),
      drawn: [...el.querySelectorAll("path")].map((p) => getComputedStyle(p).strokeDashoffset),
      text: el.classList.contains("pen-note") ? el.textContent : null,
      clip: getComputedStyle(el).clipPath,
    }));
    return {
      scene: film.scene,
      playing: film.playing,
      camera: getComputedStyle(world).transform,
      caption: document.querySelector(".film-line").textContent,
      ghosts: world.querySelectorAll("[data-ghost]").length,
      typing: world.querySelectorAll(".is-typing").length,
      actors,
      pen,
      animations: document
        .getAnimations()
        .filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition))
        .filter((a) => a.playState === "running").length,
    };
  });

// The film after its first look at the viewport (autoplay may have started), paused.
const pausedFilm = async (page) => {
  await page.waitFor(() => window.__demo.film.seen);
  await page.eval(() => window.__demo.film.pause());
};

// Resolves once the page has stopped scrolling (scrollY the same for 6 frames in a row).
const settled = (page) =>
  page.eval(
    () =>
      new Promise((resolve) => {
        let last = scrollY;
        let still = 0;
        const tick = () => {
          still = scrollY === last ? still + 1 : 0;
          last = scrollY;
          if (still >= 6) resolve(true);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );

const sceneNames = (page) =>
  page.eval(async () => (await import("./scenes.js")).SCENES.map((s) => [s.id, s.name]));

// --- Tests: the film -------------------------------------------------------------------------

test("smoke: the page loads without errors in light and dark", async ({ newPage }) => {
  for (const theme of ["light", "dark"]) {
    const page = await newPage({ media: [{ name: "prefers-color-scheme", value: theme }] });
    // Console errors and failed loads (404s), besides the uncaught exceptions every test checks.
    const errors = [];
    const off = page.cdp.on((msg) => {
      if (msg.sessionId !== page.sessionId) return;
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        errors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ""}`);
      }
    });
    await page.send("Log.enable");
    await page.goto("/");
    await page.waitFor(() => window.__demo.film.seen);
    await page.frames(4);
    off();
    assert.deepEqual(errors, [], `${theme}: console errors`);
    const got = await page.eval(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      scenes: window.__demo.film.sceneCount,
    }));
    assert.deepEqual(got, { bg: DESK[theme], scenes: 9 }, theme);
  }
});

test("film: a jump during a camera move renders the scene's end frame, and it stays", async ({
  newPage,
}) => {
  const page = await newPage();
  await page.goto("/");
  await page.waitFor(() => window.__demo.film.playing);
  await page.waitFor(() => window.__demo.film.camera.moving, { timeout: 20_000 });
  await page.eval(() => {
    window.__demo.film.goTo(2);
    window.__demo.film.goTo(1);
  });
  const jumped = await frameState(page);
  assert.equal(jumped.scene, 1, "on scene 2");
  assert.equal(jumped.playing, false, "jumping pauses");
  assert.equal(jumped.animations, 0, "nothing in flight");
  assert.equal(jumped.ghosts, 0, "no fading leftovers");
  assert.ok(jumped.actors.length >= 2 && jumped.pen.length >= 2, "the scene is on the desk");
  await page.eval(() => window.__demo.film.renderEnd(1));
  assert.deepEqual(await frameState(page), jumped, "a fresh end frame is the same frame");
  await sleep(2000); // an aborted cue must not draw anything later
  assert.deepEqual(await frameState(page), jumped, "nothing changes 2 s later");
});

test("film: a jump while a type cue types renders the scene's end frame, and it stays", async ({
  newPage,
}) => {
  const page = await newPage();
  await page.goto("/");
  await page.waitFor(() => window.__demo.film.busy.includes("type"), { timeout: 20_000 });
  const partial = await page.eval(
    () => document.querySelector(".film-world .is-typing")?.textContent,
  );
  assert.equal(typeof partial, "string", "a file name is being typed");
  await page.eval(() => window.__demo.film.goTo(2));
  const jumped = await frameState(page);
  assert.deepEqual([jumped.scene, jumped.playing, jumped.typing], [2, false, 0]);
  await page.eval(() => window.__demo.film.renderEnd(2));
  assert.deepEqual(await frameState(page), jumped, "a fresh end frame is the same frame");
  await sleep(2000);
  assert.deepEqual(await frameState(page), jumped, "nothing changes 2 s later");
  // Back to scene 1: its file names are typed in full.
  const names = await page.eval(() => {
    window.__demo.film.goTo(0);
    return [...document.querySelectorAll(".film-world .copy-file-name")].map((n) => n.textContent);
  });
  assert.deepEqual(names, ["resume_v2.pdf", "resume_final.pdf", "resume_FINAL_v3.pdf"]);
});

test("film: playing each scene through ends on the frame a jump renders", async ({ newPage }) => {
  // Four times the speed (timers through ?speed, animations through the protocol): the same
  // frames, sooner.
  const page = await newPage();
  await page.animationSpeed(4);
  await page.goto("/?speed=4");
  assert.equal(await page.eval(() => window.__demo.film.speed), 4, "?speed is read");
  const steps = await page.eval(async () =>
    (await import("./scenes.js")).SCENES.map((s) => s.steps.length),
  );
  await page.waitFor(() => window.__demo.film.playing);
  for (let n = 0; n < steps.length; n++) {
    // Scene n has played its last step and rests on it (autoplay holds there).
    await page.waitFor(
      ([scene, last]) => {
        const { film } = window.__demo;
        return film.scene === scene && film.step === last && !film.animating;
      },
      { args: [[n, steps[n] - 1]], timeout: 40_000 },
    );
    await page.eval(() => window.__demo.film.pause());
    await page.frames(2);
    const played = await frameState(page);
    assert.equal(played.ghosts, 0, `scene ${n + 1}: no fading leftovers`);
    await page.eval((i) => window.__demo.film.renderEnd(i), n);
    assert.deepEqual(await frameState(page), played, `scene ${n + 1}: played = end frame`);
    await page.eval(() => window.__demo.film.play()); // on to the next scene
  }
});

test("film: playing a scene after a jump to it keeps its actors on the desk", async ({
  newPage,
}) => {
  const page = await newPage();
  await page.goto("/");
  await pausedFilm(page);
  // The end frame fades out as the scene starts over; the replica it enters again is reused.
  await page.eval(() => {
    window.__demo.film.goTo(1);
    window.__demo.film.play();
  });
  await page.waitFor(() => window.__demo.film.step >= 1, { timeout: 15_000 });
  await sleep(500); // past the fade-out of the old end frame
  const got = await page.eval(() => {
    const el = window.__demo.film.actor("resume");
    return {
      onDesk: Boolean(el?.isConnected),
      ghost: el ? "ghost" in el.dataset : null,
      opacity: el && getComputedStyle(el).opacity,
    };
  });
  assert.deepEqual(got, { onDesk: true, ghost: false, opacity: "1" });
});

test("film: every scene plays from a jump to it", async ({ newPage }) => {
  // After a jump, play() starts the scene from an empty desk: its first shot must not need an
  // actor from the scene before.
  for (const [width, height] of [
    [1280, 720],
    [390, 844],
  ]) {
    const page = await newPage({ width, height, mobile: width < 800 });
    await page.animationSpeed(16);
    await page.goto("/?speed=16");
    await pausedFilm(page);
    const got = await page.eval(async () => {
      const { film } = window.__demo;
      const errors = [];
      const error = console.error;
      console.error = (...args) => errors.push(`${film.scene + 1}: ${args[0]?.message ?? args[0]}`);
      const out = [];
      try {
        for (let n = 0; n < film.sceneCount; n++) {
          film.goTo(n);
          film.play();
          for (let i = 0; i < 300 && film.scene === n && film.playing; i++) {
            await new Promise((r) => setTimeout(r, 10));
          }
          // Still playing (or on to the next scene); the last scene may simply end.
          out.push(film.playing || film.scene !== n || n === film.sceneCount - 1);
          film.pause();
        }
      } finally {
        console.error = error;
      }
      return { out, errors };
    });
    assert.deepEqual(got.errors, [], `${width}×${height}`);
    assert.ok(
      got.out.every(Boolean),
      `${width}×${height}: stopped in scenes ${got.out.map((ok, i) => (ok ? "" : i + 1)).join(" ")}`,
    );
    await page.close();
  }
});

test("film: a scene's first camera move on a phone runs its course", async ({ newPage }) => {
  // Scene 1's two-line caption gives way to scene 2's one line as scene 2 starts; the move,
  // framed for the new caption, must not be cut short by the caption's resize.
  const page = await newPage({ width: 390, height: 844, mobile: true, deviceScaleFactor: 2 });
  await page.goto("/?speed=8");
  await page.waitFor(() => window.__demo.film.playing);
  const move = await page.eval(
    () =>
      new Promise((resolve) => {
        const { film } = window.__demo;
        const samples = [];
        let t0 = null;
        const tick = (t) => {
          if (film.scene === 1 && t0 === null) t0 = t;
          if (t0 !== null) {
            samples.push({
              t: t - t0,
              moving: film.camera.moving,
              m: getComputedStyle(film.world).transform,
            });
            if (t - t0 > 1600) return resolve(samples);
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  const moving = move.filter((s) => s.moving);
  const span = moving.length ? moving.at(-1).t - moving[0].t : 0;
  const distinct = new Set(moving.map((s) => s.m)).size;
  assert.ok(span >= 500, `the move lasts ${Math.round(span)} ms`);
  assert.ok(distinct >= 15, `${distinct} distinct camera frames`);
});

test("film: autoplay starts from an empty desk, with nothing fading", async ({ newPage }) => {
  const page = await newPage();
  // Counts every element that ever fades out (data-ghost) from the first script on.
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__ghosts = 0;
      new MutationObserver((records) => {
        for (const r of records) if (r.target.hasAttribute?.("data-ghost")) window.__ghosts++;
      }).observe(document, { attributes: true, attributeFilter: ["data-ghost"], subtree: true });
    `,
  });
  await page.goto("/");
  await page.waitFor(() => window.__demo.film.busy.includes("type"), { timeout: 15_000 });
  assert.equal(await page.eval(() => window.__ghosts), 0, "no end frame dissolves at autoplay");
});

test("film: a tap on the controls doesn't keep them from fading", async ({ newPage }) => {
  const page = await newPage({ width: 390, height: 844, mobile: true, deviceScaleFactor: 2 });
  await page.goto("/");
  await page.waitFor(() => window.__demo.film.playing);
  const at = await page.eval(() => {
    const r = document.querySelector(".fc-label").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.tap(at.x, at.y); // a touch leaves :hover on what it touched
  assert.equal(await page.eval(() => window.__demo.film.playing), true);
  await page.waitFor(() => document.getElementById("film").dataset.controls === "hidden", {
    timeout: 6000,
  });
});

test("film: a chapter's tooltip shows on hover and keyboard focus, not after a tap", async ({
  newPage,
}) => {
  const opacity = () =>
    getComputedStyle(document.querySelector('.fc-seg[data-scene="5"] .fc-tip')).opacity;
  const shown = () =>
    getComputedStyle(document.querySelector('.fc-seg[data-scene="5"] .fc-tip')).opacity === "1";
  const can = (page) =>
    page.eval(() => ({
      hover: matchMedia("(hover: hover)").matches,
      fine: matchMedia("(pointer: fine)").matches,
    }));
  // A phone: a tap leaves :hover on the segment, and the tooltip would stay over the caption.
  const phone = await newPage({ width: 390, height: 844, mobile: true, deviceScaleFactor: 2 });
  await phone.goto("/");
  await pausedFilm(phone);
  assert.deepEqual(await can(phone), { hover: false, fine: false }, "a phone: touch only");
  const at = await phone.eval(() => {
    const r = document.querySelector('.fc-seg[data-scene="5"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await phone.tap(at.x, at.y);
  assert.equal(await phone.eval(() => window.__demo.film.scene), 4, "the tap jumped");
  await sleep(400); // the tooltip fades in over 150 ms
  await phone.screenshot("film-tooltip-after-tap-390x844");
  assert.equal(await phone.eval(opacity), "0", "no tooltip after a tap");
  // A mouse: hover shows it; keyboard focus shows it too.
  const desk = await newPage();
  await desk.goto("/");
  await pausedFilm(desk);
  assert.deepEqual(await can(desk), { hover: true, fine: true }, "a desktop: a mouse");
  const r = await desk.eval(() =>
    document.querySelector('.fc-seg[data-scene="5"]').getBoundingClientRect().toJSON(),
  );
  await desk.mouse(r.left + r.width / 2, r.top + r.height / 2);
  await desk.waitFor(shown, { timeout: 3000 });
  await desk.mouse(5, 300);
  await desk.eval(() => document.querySelector('.fc-seg[data-scene="4"]').focus());
  await desk.key("Tab");
  await desk.waitFor(shown, { timeout: 3000 });
});

test("film: a failing cue stops playback cleanly", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/");
  await pausedFilm(page);
  const got = await page.eval(async () => {
    const { CUES } = await import("./scenes.js");
    const { film } = window.__demo;
    const run = CUES.type.run;
    const logged = [];
    const error = console.error;
    console.error = (...args) => logged.push(String(args[0]?.message ?? args[0]));
    CUES.type.run = () => Promise.reject(new Error("a broken cue"));
    try {
      film.goTo(0);
      film.play();
      for (let i = 0; i < 200 && film.playing; i++) await new Promise((r) => setTimeout(r, 20));
      const after = { playing: film.playing, animating: film.animating };
      const label = document.querySelector('[data-ctl="play"]').getAttribute("aria-label");
      CUES.type.run = run;
      film.play();
      return { after, label, logged, again: film.playing };
    } finally {
      CUES.type.run = run;
      console.error = error;
      film.pause();
    }
  });
  assert.deepEqual(got, {
    after: { playing: false, animating: false },
    label: "Play",
    logged: ["a broken cue"],
    again: true,
  });
});

test("film: control clicks before the film is ready are ignored", async ({ newPage }) => {
  const page = await newPage();
  // Holds the film's font loads (it waits for them) until the test lets them go.
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      const load = FontFaceSet.prototype.load;
      let release;
      const gate = new Promise((r) => (release = r));
      window.__releaseFonts = release;
      FontFaceSet.prototype.load = function (...args) {
        return gate.then(() => load.apply(this, args));
      };
    `,
  });
  await page.goto("/", { waitForDemo: false });
  await page.waitFor(() => document.querySelector(".fc-seg"));
  await page.eval(() => {
    document.querySelector('.fc-seg[data-scene="3"]').click();
    document.querySelector('[data-ctl="next"]').click();
    document.querySelector('[data-ctl="play"]').click();
  });
  await page.eval(() => window.__releaseFonts());
  await page.waitFor(() => Boolean(window.__demo));
  const got = await page.eval(() => ({
    scene: window.__demo.film.scene,
    interactions: window.__demo.events.filter((e) => e.name === "interact").length,
  }));
  assert.deepEqual(got, { scene: 0, interactions: 0 });
});

test("film: the overlay layer is outside the aria-hidden world and is cleared per frame", async ({
  newPage,
}) => {
  const page = await newPage();
  await page.goto("/");
  await pausedFilm(page);
  const got = await page.eval(() => {
    const overlay = document.querySelector(".film-overlay");
    const hidden = overlay?.closest("[aria-hidden='true']");
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = "a real link";
    overlay?.append(link);
    window.__demo.film.goTo(1);
    return { exists: Boolean(overlay), hidden: Boolean(hidden), left: overlay?.children.length };
  });
  assert.deepEqual(got, { exists: true, hidden: false, left: 0 });
});

test("scenes: a kept replica, updated, is the replica its enter cue would build", async ({
  newPage,
}) => {
  const page = await newPage();
  await page.goto("/");
  await pausedFilm(page);
  const got = await page.eval(async () => {
    const { ACTORS } = await import("./scenes.js");
    const { markInstant, noteInstant } = await import("./pen.js");
    const ctx = { cache: new Map() };
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-6000px;top:0";
    document.body.append(host);
    const make = (id, props) => {
      const el = ACTORS.resume.create(props, ctx, id);
      el.style.position = "absolute";
      host.append(el);
      ACTORS.resume.mount(el, props, ctx);
      return el;
    };
    const look = (el) => ({
      text: el.textContent.replace(/\s+/g, " ").trim(),
      hl: [...el.querySelectorAll(".is-hl")].map((e) => e.dataset.id),
      pen: el.querySelectorAll(".pen-mark, .pen-note").length,
      proof: "proof" in el.dataset,
      size: [el.style.width, el.style.height],
    });
    // The end of a scene: another state, a highlight, pen marks, the real PDF on top.
    const kept = make("kept", { state: "granary", highlight: ["w-birds"] });
    markInstant(kept.querySelector('[data-id="w-birds"]'), "circle", { layer: kept });
    noteInstant("moved up!", { x: 10, y: 10 }, { layer: kept });
    kept.dataset.proof = "";
    const props = { state: "canonical", highlight: ["windowsill"] };
    ACTORS.resume.update(kept, props, ctx);
    const fresh = make("fresh", props);
    const out = { kept: look(kept), fresh: look(fresh) };
    host.remove();
    return out;
  });
  assert.equal(got.kept.pen, 0, "pen marks cleared");
  assert.deepEqual(got.kept, got.fresh);
});

test("scenes: scene 2's pen mark on the role keeps clear of the bullet under it", async ({
  newPage,
}) => {
  const page = await newPage({ width: 1920, height: 1080 });
  await page.goto("/");
  await pausedFilm(page);
  const got = await page.eval(() => {
    window.__demo.film.goTo(1);
    const resume = window.__demo.film.actor("resume");
    const mark = resume.querySelector(".pen-mark path").getBoundingClientRect();
    const bullet = resume.querySelector('[data-id="windowsill"] + .r-bullet');
    // The bullet's text: the top of its x-height, below the line box's top.
    const range = document.createRange();
    range.selectNodeContents(bullet);
    const text = range.getBoundingClientRect();
    const s = window.__demo.film.camera.view.s;
    return { overlap: (mark.bottom - text.top) / s + 1.3 }; // + half the pen's stroke
  });
  assert.ok(got.overlap <= 4, `the mark dips ${got.overlap.toFixed(1)} units into the bullet`);
});

test("scenes: the replica folds to one page, then gets the new role on top", async ({
  newPage,
}) => {
  const page = await newPage();
  await page.goto("/");
  await pausedFilm(page);
  const got = await page.eval(() => {
    const { film } = window.__demo;
    const out = [];
    for (let n = 0; n < film.sceneCount; n++) {
      film.goTo(n);
      const resume = film.actor("resume");
      out.push({
        state: resume?.dataset.state ?? null,
        pages: resume?.resume.pageCount() ?? null,
        first: resume?.querySelector(".r-entry")?.dataset.id ?? null,
        term: Boolean(film.actor("term")),
      });
    }
    return out;
  });
  assert.equal(got.length, 9, "nine scenes");
  assert.deepEqual(got[5], { state: "granary", pages: 1, first: "windowsill", term: false });
  assert.deepEqual(got[7], { state: "updated", pages: 2, first: "granary", term: false });
  // The terminal is a card on the desk for the input scenes (4, 5) and leaves after.
  assert.deepEqual(
    got.map((s) => s.term),
    [false, false, false, true, true, false, false, false, false],
  );
  // Scene 8 types on a terminal before it leaves.
  const enters = await page.eval(async () =>
    (await import("./scenes.js")).SCENES.map((s) =>
      s.steps.some((st) => (st.cues ?? []).some((c) => c.do === "enter" && c.kind === "terminal")),
    ),
  );
  assert.deepEqual(enters, [false, false, false, true, true, false, false, true, false]);
});

test("scenes: the terminal's lines are the ones the real commands print", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/");
  await pausedFilm(page);
  const text = await page.eval(() => {
    const { film } = window.__demo;
    const seen = [];
    for (const n of [3, 4]) {
      film.goTo(n);
      seen.push(film.actor("term").textContent);
    }
    // Scene 8’s card leaves at the end: read it on the step before.
    film.renderStep(7, 4);
    seen.push(film.actor("term").textContent);
    return seen.join("\n");
  });
  for (const line of [
    "/customize-resume https://example.com/careers/senior-mouser",
    "Fetch(example.com/careers/senior-mouser)",
    "Received 2.1KB (200 OK)",
    "Bash(just new granary senior-mouser)",
    "Created applications/2026-09-granary-senior-mouser — fill in jd.md, then ask Claude to customize.",
    "Night patrol, early rodent detection",
    "Monitored 400+ birds a day (Sunbeam)",
    "To fit one page: drop Service, Honors, two projects, and three papers.",
    "Proceed with this plan?",
    "/update-resume Got the job: Senior Mouser at Granary & Sons",
    "What is the start date (YYYY-MM) and location, and when did your Sunbeam role end?",
    "2026-11, the grain warehouse; Sunbeam ended 2026-10. First bullet: patrols 40 tons of grain on night shifts",
    "Updated common/facts/roles.tex with 7 additions and 1 removal",
  ]) {
    assert.ok(text.includes(line), `terminal: ${line}`);
  }
});

test("cues: Nangnang stamps the tag; confetti falls and leaves nothing behind", async ({
  newPage,
}) => {
  const page = await newPage();
  await page.animationSpeed(4);
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__confetti = 0;
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of r.addedNodes) if (n.classList?.contains("confetti")) window.__confetti++;
      }).observe(document, { childList: true, subtree: true });
    `,
  });
  await page.goto("/?speed=4");
  await pausedFilm(page);
  const stamp = await page.eval(() => {
    const { film } = window.__demo;
    film.goTo(6);
    const el = film.actor("tag");
    return {
      kind: el?.dataset.kind,
      text: el?.textContent.replace(/\s+/g, ""),
      nangnang: film.actor("nangnang")?.dataset.cat,
      proof: "proof" in (film.actor("resume")?.dataset ?? {}),
      confetti: document.querySelectorAll(".confetti").length,
    };
  });
  assert.deepEqual(stamp, {
    kind: "stamp",
    text: "submitted/2026-09-granary-senior-mouser",
    nangnang: "nangnang",
    proof: true,
    confetti: 0,
  });
  // Scene 8 played: confetti falls, then is gone; the end frame has none.
  await page.eval(() => {
    window.__demo.film.goTo(7);
    window.__demo.film.play();
  });
  await page.waitFor(() => window.__confetti > 0, { timeout: 30_000 });
  const last = await page.eval(
    async () => (await import("./scenes.js")).SCENES[7].steps.length - 1,
  );
  // Scene 8 has played its last step (autoplay rests on it).
  await page.waitFor(
    (k) => {
      const { film } = window.__demo;
      return film.scene === 7 && film.step === k && !film.animating;
    },
    { args: [last], timeout: 30_000 },
  );
  await page.eval(() => window.__demo.film.pause());
  assert.equal(await page.eval(() => document.querySelectorAll(".confetti").length), 0);
});

test("cues: no confetti with reduced motion", async ({ newPage }) => {
  const page = await newPage({ media: REDUCED });
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__confetti = 0;
      new MutationObserver((records) => {
        for (const r of records)
          for (const n of r.addedNodes) if (n.classList?.contains("confetti")) window.__confetti++;
      }).observe(document, { childList: true, subtree: true });
    `,
  });
  await page.goto("/?speed=16");
  await page.waitFor(() => window.__demo.film.seen);
  await page.eval(() => {
    window.__demo.film.goTo(7);
    window.__demo.film.play();
  });
  await page.waitFor(() => window.__demo.film.scene === 8, { timeout: 20_000 });
  assert.equal(await page.eval(() => window.__confetti), 0);
});

test("film: every shot frames its target inside the free area at every size", async ({
  newPage,
}) => {
  // Every step's shot, as its end frame shows it: the target in the free area; terminal text
  // at 12 px or more on screen; on phones, resume text in a shot on the replica at 11 px or
  // more (a zoom crops the line rather than shrink it); the notes the step writes in view; and
  // the terminal card the shape of the camera's free area. And at every step's end, no note
  // still on the desk cut by the film's edge.
  const PHONES = new Set(["390x844", "844x390"]);
  const problems = [];
  for (const [width, height] of SIZES) {
    const page = await newPage({ width, height, mobile: width < 800 || height < 500 });
    await page.goto("/");
    await pausedFilm(page);
    const shots = await page.eval(async () => {
      const { SCENES } = await import("./scenes.js");
      const { film } = window.__demo;
      const out = [];
      SCENES.forEach((scene, n) => {
        scene.steps.forEach((step, k) => {
          film.renderStep(n, k);
          const box = document.getElementById("film").getBoundingClientRect();
          const free = {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: document.querySelector(".film-caption").getBoundingClientRect().top,
          };
          const at = `scene ${n + 1} step ${k + 1}`;
          const onDesk = [...film.world.querySelectorAll(".pen-note")].map((el) => {
            const r = el.getBoundingClientRect();
            return {
              text: el.textContent,
              r: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
            };
          });
          if (!step.shot) {
            out.push({ at, free, box: box.toJSON(), onDesk });
            return;
          }
          const term = film.actor("term");
          const resume = film.actor("resume");
          const target = JSON.stringify(film.shot().target);
          const a = film.camera.area();
          out.push({
            at,
            focus: film.focus(),
            free,
            box: box.toJSON(),
            onDesk,
            // The terminal's text on screen (px), for shots on the terminal card.
            termPx:
              target.includes('"term"') && term
                ? parseFloat(getComputedStyle(term).fontSize) * film.camera.view.s
                : null,
            // The replica's body text on screen (px), for shots on its content.
            resumePx:
              target.includes('"actor":"resume"') && resume
                ? parseFloat(getComputedStyle(resume.querySelector(".resume")).fontSize) *
                  film.camera.view.s
                : null,
            notes: (step.cues ?? [])
              .filter((c) => c.do === "note" && c.id)
              .map((c) => {
                const r = film.world
                  .querySelector(`.pen-note[data-note="${c.id}"]`)
                  .getBoundingClientRect();
                return {
                  id: c.id,
                  r: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
                };
              }),
            card: term ? { narrow: term.offsetWidth < 1000, portrait: a.w < a.h * 0.9 } : null,
          });
        });
      });
      return out;
    });
    const inside = (r, box) =>
      r &&
      r.left >= box.left - 2 &&
      r.right <= box.right + 2 &&
      r.top >= box.top - 2 &&
      r.bottom <= box.bottom + 2;
    const size = `${width}x${height}`;
    for (const s of shots) {
      const at = `${width}×${height} ${s.at}`;
      // Any note on the desk (left from an earlier step too): cut by the film's left, right, or
      // top edge is a problem; one running under the caption is not (the scrim, from 56 px
      // above the caption down, fades whatever lies there).
      const scrim = s.free.bottom - 56;
      for (const n of s.onDesk) {
        const { left, right, top } = n.r;
        if (top >= scrim || right <= s.box.left || left >= s.box.right || n.r.bottom <= s.box.top) {
          continue; // under the caption, or off the film
        }
        const edges = [
          left < s.free.left - 2 && "left",
          right > s.free.right + 2 && "right",
          top < s.free.top - 2 && "top",
        ].filter(Boolean);
        if (edges.length) {
          problems.push(`${at}: note "${n.text}" cut at the film's ${edges.join(" and ")} edge`);
        }
      }
      if (!s.focus) continue; // a step without a shot of its own
      if (!inside(s.focus, s.free)) problems.push(`${at}: focus outside the free area`);
      if (s.termPx !== null && s.termPx < 12) {
        problems.push(`${at}: terminal text ${s.termPx.toFixed(1)} px`);
      }
      if (PHONES.has(size) && s.resumePx !== null && s.resumePx < 11) {
        problems.push(`${at}: resume text ${s.resumePx.toFixed(1)} px`);
      }
      for (const n of s.notes) {
        if (!inside(n.r, s.free)) problems.push(`${at}: note "${n.id}" out of view`);
      }
      if (s.card && s.card.narrow !== s.card.portrait) {
        problems.push(
          `${at}: a ${s.card.narrow ? "narrow" : "wide"} card in a ${s.card.portrait ? "portrait" : "landscape"} frame`,
        );
      }
    }
    await page.close();
  }
  assert.deepEqual(problems, []);
});

test("film: a call to action fading out can't be reached", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/");
  await pausedFilm(page);
  const got = await page.eval(() => {
    const { film } = window.__demo;
    film.goTo(film.sceneCount - 1);
    const old = document.querySelector(".film-overlay .film-cta");
    film.play(); // the scene starts over: its end frame fades out
    const out = { fading: "ghost" in old.dataset, inert: old.inert };
    film.pause();
    return out;
  });
  assert.deepEqual(got, { fading: true, inert: true });
});

test("cues: the stamp's impact jolts the stamp with the paper", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/?speed=2");
  await pausedFilm(page);
  const got = await page.eval(async () => {
    const { film } = window.__demo;
    film.goTo(6);
    film.play();
    for (let i = 0; i < 2000 && !film.busy.includes("stamp"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const jolts = (el) =>
      el
        .getAnimations()
        .filter((a) => a.effect.getKeyframes().some((f) => f.translate === "0px 7px")).length;
    const out = { resume: jolts(film.actor("resume")), stamp: jolts(film.actor("tag")) };
    film.pause();
    return out;
  });
  assert.deepEqual(got, { resume: 1, stamp: 1 });
});

test("film: a scripted run emits act 1–9, then complete", async ({ newPage }) => {
  const page = await newPage();
  await page.animationSpeed(16);
  await page.goto("/?speed=16");
  await page.waitFor(() => window.__demo.film.playing);
  await page.waitFor(() => window.__demo.events.some((e) => e.name === "complete"), {
    timeout: 60_000,
  });
  const events = await page.eval(() =>
    window.__demo.events.filter((e) => e.name === "act" || e.name === "complete"),
  );
  const names = await sceneNames(page);
  assert.deepEqual(events, [
    ...names.map(([id], i) => ({ name: "act", params: { act: i + 1, act_name: id } })),
    { name: "complete", params: { method: "autoplay" } },
  ]);
  assert.deepEqual(
    names.map(([id]) => id),
    ["problem", "meet", "job", "prompt", "plan", "tailor", "ship", "update", "cta"],
  );
});

test("film: ?speed is clamped to 0.25–16", async ({ newPage }) => {
  const page = await newPage();
  const got = [];
  for (const q of ["100", "0.01", "8", "nope"]) {
    await page.goto(`/?speed=${q}`);
    got.push(await page.eval(() => window.__demo.film.speed));
  }
  assert.deepEqual(got, [16, 0.25, 8, 1]);
});

test("film: scene 9's call to action is a real link, outside the aria-hidden world", async ({
  newPage,
}) => {
  const page = await newPage();
  await page.goto("/");
  await pausedFilm(page);
  const got = await page.eval(() => {
    window.__demo.film.goTo(8);
    const links = [...document.querySelectorAll(".film-overlay a")];
    return links.map((a) => ({
      href: a.href,
      text: a.textContent.trim(),
      hidden: Boolean(a.closest("[aria-hidden='true']")),
      tab: a.tabIndex,
    }));
  });
  assert.deepEqual(got, [
    {
      href: "https://github.com/h1994st/my-resume/generate",
      text: "Use this template",
      hidden: false,
      tab: 0,
    },
    { href: "https://github.com/h1994st/my-resume", text: "GitHub", hidden: false, tab: 0 },
  ]);
  // Tab reaches it (after the header, before the film's controls).
  await page.eval(() => document.getElementById("theme-toggle").focus());
  let reached = false;
  for (let i = 0; i < 20 && !reached; i++) {
    await page.key("Tab");
    reached = await page.eval(() => Boolean(document.activeElement?.closest(".film-overlay")));
  }
  assert.ok(reached, "Tab reaches the call to action");
  // Gone from other scenes.
  assert.equal(
    await page.eval(() => {
      window.__demo.film.goTo(7);
      return document.querySelectorAll(".film-overlay a").length;
    }),
    0,
  );
});

test("film: the controls fade after 2.5 s while playing and come back", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/");
  await page.waitFor(() => window.__demo.film.playing);
  const controls = () =>
    page.eval(() => ({
      state: document.getElementById("film").dataset.controls,
      opacity: getComputedStyle(document.querySelector(".film-controls")).opacity,
    }));
  const hidden = () => document.getElementById("film").dataset.controls === "hidden";
  let t0 = Date.now();
  await page.waitFor(hidden, { timeout: 8000 });
  assert.ok(Date.now() - t0 >= 2000, `hidden after ${Date.now() - t0} ms`);
  await page.waitFor(
    () => getComputedStyle(document.querySelector(".film-controls")).opacity === "0",
  );
  // Pointer movement brings them back, and they fade again.
  await page.mouse(640, 300);
  assert.equal((await controls()).state, "shown", "back on pointer move");
  t0 = Date.now();
  await page.waitFor(hidden, { timeout: 8000 });
  assert.ok(Date.now() - t0 >= 2000, "fade again after stillness");
  // Keyboard focus brings them back and keeps them.
  for (let i = 0; i < 8; i++) {
    const inside = await page.eval(() =>
      document.querySelector(".film-controls").contains(document.activeElement),
    );
    if (inside) break;
    await page.key("Tab");
  }
  assert.ok(
    await page.eval(() =>
      document.querySelector(".film-controls").contains(document.activeElement),
    ),
    "Tab reaches the controls",
  );
  assert.equal((await controls()).state, "shown", "back on focus");
  await sleep(3000);
  assert.equal((await controls()).state, "shown", "kept while focused");
  assert.equal(await page.eval(() => window.__demo.film.playing), true, "still playing");
  // Paused: always shown.
  await page.eval(() => {
    document.activeElement.blur();
    window.__demo.film.pause();
  });
  await sleep(3000);
  assert.deepEqual(await controls(), { state: "shown", opacity: "1" }, "shown while paused");
});

test("film: reduced motion: no autoplay, camera cuts, end frames at once", async ({ newPage }) => {
  const page = await newPage({ media: REDUCED });
  await page.goto("/");
  await page.waitFor(() => window.__demo.film.seen);
  await page.frames(4);
  assert.deepEqual(
    await page.eval(() => [window.__demo.film.playing, window.__demo.film.scene]),
    [false, 0],
    "no autoplay",
  );
  const cut = await page.eval(async () => {
    const { film } = window.__demo;
    const before = getComputedStyle(film.world).transform;
    const done = film.camera.frame({ x: 0, y: 0, w: 300, h: 200 });
    const now = getComputedStyle(film.world).transform;
    const moving = film.camera.moving;
    await done;
    return { cut: before !== now, moving, animations: film.world.getAnimations().length };
  });
  assert.deepEqual(cut, { cut: true, moving: false, animations: 0 }, "camera.frame cuts");
  const scripted = () =>
    page.eval(
      () =>
        document
          .getAnimations()
          .filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition)).length,
    );
  await page.eval(() => window.__demo.film.next());
  assert.equal(await scripted(), 0, "next: no animations");
  const end = await frameState(page);
  await page.eval(() => window.__demo.film.renderEnd(1));
  assert.deepEqual(await frameState(page), end, "next shows the end frame");
  // Playing shows each step's end frame at once, then rests and moves on.
  await page.eval(() => window.__demo.film.play());
  assert.equal(await scripted(), 0, "play: no animations");
  await page.waitFor(() => window.__demo.film.step >= 1, { timeout: 10_000 });
  assert.equal(await scripted(), 0, "the next step: no animations");
  await sleep(3000);
  assert.equal(
    await page.eval(() => document.getElementById("film").dataset.controls),
    "shown",
    "controls stay with reduced motion",
  );
});

test("film: keys work only in view and with focus on the page or the film", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/");
  await page.waitFor(() => window.__demo.film.playing); // autoplay began: the observer has fired
  await page.eval(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "4000px";
    document.body.append(spacer);
    window.__demo.film.pause();
    const film = document.getElementById("film");
    scrollTo(0, film.offsetTop + film.offsetHeight + 200);
  });
  await page.waitFor(() => !window.__demo.film.inView);
  const y0 = await page.eval(() => scrollY);
  await page.key(" ");
  await page.waitFor((y) => scrollY > y, { args: [y0], timeout: 5000 });
  await settled(page); // Space scrolls smoothly: let it finish before scrolling back
  assert.equal(await page.eval(() => window.__demo.film.playing), false, "space out of view");

  // Back in view, Space toggles playback and the page stays put.
  await page.eval(() => scrollTo(0, 0));
  await settled(page);
  await page.waitFor(() => window.__demo.film.inView && scrollY === 0);
  await page.key(" ");
  await page.waitFor(() => window.__demo.film.playing, { timeout: 5000 });
  assert.equal(await page.eval(() => scrollY), 0, "space in view does not scroll");
  await page.key("ArrowRight");
  assert.equal(await page.eval(() => window.__demo.film.playing), false, "a key jump pauses");
  await page.key("3");
  assert.equal(await page.eval(() => window.__demo.film.scene), 2, "digit keys jump to scenes");
  await page.key("ArrowLeft");
  assert.equal(await page.eval(() => window.__demo.film.scene), 1, "← steps back");

  // Focus elsewhere on the page: the keys are the page's.
  await page.eval(() => document.querySelector("#get-started a").focus({ preventScroll: true }));
  await page.key("ArrowRight");
  await page.key("1");
  assert.equal(await page.eval(() => window.__demo.film.scene), 1, "keys ignored");
});

// Resolves once an IntersectionObserver made now sees the film `visible` (in view: at least half
// of it on screen; else less than half). The film's own observer, made earlier, gets each update
// first, so by then it has seen the same thing.
const filmSeen = (page, visible) =>
  page.eval(
    (want) =>
      new Promise((resolve) => {
        const io = new IntersectionObserver(
          ([e]) => {
            if (e.intersectionRatio >= 0.5 === want) {
              io.disconnect();
              resolve(true);
            }
          },
          { threshold: Array.from({ length: 21 }, (_, k) => k / 20) },
        );
        io.observe(document.getElementById("film"));
      }),
    visible,
  );

test("film: playback pauses out of view or in a hidden tab, and resumes when back", async ({
  newPage,
}) => {
  const page = await newPage();
  await page.animationSpeed(8);
  await page.goto("/?speed=8");
  await page.waitFor(() => window.__demo.film.playing);
  await page.eval(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "4000px";
    document.body.append(spacer);
  });
  const state = () =>
    page.eval(() => ({
      playing: window.__demo.film.playing,
      acts: window.__demo.events.filter((e) => e.name === "act" || e.name === "complete").length,
      live: document.querySelector("[data-film-live]").textContent,
    }));
  const away = async () => {
    await page.eval(() => {
      const film = document.getElementById("film");
      scrollTo(0, film.offsetTop + film.offsetHeight + 200);
    });
    await filmSeen(page, false);
  };
  const back = async () => {
    await page.eval(() => scrollTo(0, 0));
    await filmSeen(page, true);
  };
  const hide = (hidden) =>
    page.eval((h) => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);

  // Out of view: paused, and no more scenes start (no demo_act, nothing announced).
  await away();
  const out = await state();
  assert.equal(out.playing, false, "paused out of view");
  await sleep(2000); // 16 s of film at ?speed=8: a few scenes, had it gone on
  assert.deepEqual(await state(), out, "nothing happens out of view");
  // Back in view: it goes on.
  await back();
  assert.equal((await state()).playing, true, "resumes in view");
  // A hidden tab pauses it too; showing the tab again resumes it.
  await hide(true);
  const hidden = await state();
  assert.equal(hidden.playing, false, "paused in a hidden tab");
  await sleep(1000);
  assert.deepEqual(await state(), hidden, "nothing happens in a hidden tab");
  await hide(false);
  assert.equal((await state()).playing, true, "resumes when the tab shows");
  // Paused by the viewer: it stays paused, out of view and back, hidden and shown.
  await page.click('[data-ctl="play"]');
  assert.equal((await state()).playing, false, "the viewer paused it");
  await away();
  await back();
  await hide(true);
  await hide(false);
  await page.frames(2);
  assert.equal((await state()).playing, false, "a paused film stays paused");
});

test("film: Space plays and pauses after a click on a chapter, prev, or next", async ({
  newPage,
}) => {
  const page = await newPage();
  await page.goto("/");
  await pausedFilm(page);
  await page.eval(() => {
    window.__demo.events.length = 0;
  });
  const state = () =>
    page.eval(() => ({
      scene: window.__demo.film.scene,
      playing: window.__demo.film.playing,
      focus: document.activeElement.dataset.scene ?? document.activeElement.dataset.ctl ?? null,
    }));
  await page.click('.fc-seg[data-scene="3"]');
  assert.deepEqual(await state(), { scene: 2, playing: false, focus: "3" }, "chapter 3");
  await page.key(" ");
  assert.deepEqual(await state(), { scene: 2, playing: true, focus: "3" }, "Space plays");
  await page.key(" ");
  assert.deepEqual(await state(), { scene: 2, playing: false, focus: "3" }, "Space pauses");
  await page.click('[data-ctl="next"]');
  await page.key(" ");
  assert.deepEqual(await state(), { scene: 3, playing: true, focus: "next" }, "after next");
  await page.click('[data-ctl="prev"]');
  await page.key(" ");
  assert.deepEqual(await state(), { scene: 2, playing: true, focus: "prev" }, "after prev");
  // The play button is a button: Space clicks it (one "play", no "key" too).
  await page.click('[data-ctl="play"]');
  await page.key(" ");
  assert.deepEqual(await state(), { scene: 2, playing: true, focus: "play" }, "play button");
  const methods = await page.eval(() =>
    window.__demo.events.filter((e) => e.name === "interact").map((e) => e.params.method),
  );
  assert.deepEqual(methods, [
    "chapter",
    "key",
    "key",
    "step",
    "key",
    "step",
    "key",
    "play",
    "play",
  ]);
});

test("film: controls, swipes, and events", async ({ newPage }) => {
  const page = await newPage({ width: 390, height: 844, mobile: true, deviceScaleFactor: 2 });
  await page.goto("/");
  await pausedFilm(page);
  const names = await sceneNames(page);
  await page.eval(() => {
    window.__demo.events.length = 0;
  });
  const scene = () => page.eval(() => window.__demo.film.scene);
  await page.eval(() => document.querySelector('.fc-seg[data-scene="2"]').click());
  assert.equal(await scene(), 1, "a chapter jumps to its scene");
  await page.eval(() => document.querySelector('[data-ctl="next"]').click());
  assert.equal(await scene(), 2, "next");
  await page.eval(() => document.querySelector('[data-ctl="prev"]').click());
  assert.equal(await scene(), 1, "prev");
  // Swipes on the film step: right goes back, left goes on.
  const box = await page.eval(() => {
    const r = document.getElementById("film").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.3 };
  });
  await page.swipe(box.x - 80, box.y, box.x + 80, box.y);
  assert.equal(await scene(), 0, "right swipe: prev");
  await page.swipe(box.x + 80, box.y, box.x - 80, box.y);
  assert.equal(await scene(), 1, "left swipe: next");
  // Chapters are named for assistive tech; the current one is marked.
  const chapters = await page.eval(() =>
    [...document.querySelectorAll(".fc-seg")].map((c) => [
      c.getAttribute("aria-label"),
      c.getAttribute("aria-current"),
    ]),
  );
  assert.deepEqual(
    chapters,
    names.map(([, name], i) => [`Scene ${i + 1}: ${name}`, i === 1 ? "step" : null]),
  );
  // The play button toggles.
  await page.eval(() => document.querySelector('[data-ctl="play"]').click());
  assert.equal(await page.eval(() => window.__demo.film.playing), true);
  assert.equal(
    await page.eval(() => document.querySelector('[data-ctl="play"]').getAttribute("aria-label")),
    "Pause",
  );
  await page.eval(() => document.querySelector('[data-ctl="play"]').click());
  assert.equal(await page.eval(() => window.__demo.film.playing), false);
  // To the end.
  await page.eval(() => window.__demo.film.goTo(window.__demo.film.sceneCount - 1));
  const events = await page.eval(() => window.__demo.events);
  assert.deepEqual(
    events.filter((e) => e.name === "interact").map((e) => e.params.method),
    ["chapter", "step", "step", "swipe", "swipe", "play", "play"],
  );
  const last = names.length - 1;
  assert.deepEqual(
    events.filter((e) => e.name === "act").map((e) => e.params),
    [1, 2, 1, 0, 1, last].map((i) => ({ act: i + 1, act_name: names[i][0] })),
  );
  assert.deepEqual(events.at(-1), { name: "complete", params: { method: "manual" } });
  // The live region names the scene; the transcript has every caption.
  const a11y = await page.eval(() => ({
    live: document.querySelector("[data-film-live]").textContent,
    role: document.getElementById("film").getAttribute("aria-roledescription"),
    hidden: document.querySelector(".film-viewport").getAttribute("aria-hidden"),
    transcript: document.querySelector(".film .visually-hidden ol").textContent,
  }));
  assert.match(a11y.live, new RegExp(`^Scene ${last + 1} of ${last + 1}, `));
  assert.equal(a11y.role, "demo");
  assert.equal(a11y.hidden, "true");
  // The transcript has every caption, without the highlighter's marks and the emoji (decoration).
  const captions = await page.eval(async () =>
    (await import("./scenes.js")).SCENES.map((s) =>
      s.caption
        .replace(/\*/g, "")
        .replace(/\s*\p{Extended_Pictographic}/gu, "")
        .trim(),
    ),
  );
  for (const c of captions) assert.ok(a11y.transcript.includes(c), `transcript: ${c}`);
  assert.ok(!/\p{Extended_Pictographic}/u.test(a11y.transcript), "no emoji in the transcript");
  // A swipe that starts on the controls doesn't step.
  for (const sel of [".fc-chapters", ".fc-buttons"]) {
    const at = await page.eval((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
    const before = await scene();
    await page.swipe(at.x - 60, at.y, at.x + 60, at.y);
    assert.equal(await scene(), before, `swipe on ${sel}`);
  }
  assert.ok(
    await page.eval(() => document.documentElement.scrollWidth <= innerWidth),
    "no horizontal scroll",
  );
});

test("film: autoplay starts on its own, as an act, not an interaction", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/");
  await page.waitFor(() => window.__demo.film.playing);
  const events = await page.eval(() => window.__demo.events);
  assert.deepEqual(events[0], { name: "act", params: { act: 1, act_name: "problem" } });
  assert.ok(!events.some((e) => e.name === "interact"), "autoplay is not an interaction");
});

test("film: autoplay starts in a phone held sideways", async ({ newPage }) => {
  const page = await newPage({ width: 844, height: 390, mobile: true, deviceScaleFactor: 2 });
  await page.goto("/");
  await page.waitFor(() => window.__demo.film.playing, { timeout: 5000 });
});

// --- Tests: layout and sections --------------------------------------------------------------

const SIZES = [
  [390, 844],
  [844, 390], // a phone in landscape
  [1024, 1366], // a tablet held upright
  [1280, 720],
  [1366, 1024], // a tablet on its side
  [1920, 1080],
  [2560, 1440],
];

// Geometry of the film at the top of the page.
const filmLayout = (page) =>
  page.eval(() => {
    scrollTo(0, 0);
    const rect = (el) => el.getBoundingClientRect().toJSON();
    const q = (s) => document.querySelector(s);
    return {
      vw: innerWidth,
      vh: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      header: rect(q(".site-title")),
      film: rect(q("#film")),
      controls: rect(q(".film-controls")),
      buttons: [...document.querySelectorAll(".fc-btn")].map(rect),
      segments: [...document.querySelectorAll(".fc-seg")].map(rect),
      segMin: parseFloat(getComputedStyle(q(".fc-seg")).minWidth),
      label: rect(q(".fc-label")),
      caption: rect(q(".film-caption")),
      line: rect(q(".film-line")),
      lineSize: parseFloat(getComputedStyle(q(".film-line")).fontSize),
      focus: window.__demo.film.focus(),
      // The call to action (scene 9): each link's box and its contrast against what is under it.
      cta: [...document.querySelectorAll(".film-overlay a")].map((a) => {
        const rgb = (c) =>
          c
            .match(/[\d.]+/g)
            .slice(0, 4)
            .map(Number);
        const lum = ([r, g, b]) => {
          const ch = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
        };
        const cs = getComputedStyle(a);
        const bg = rgb(cs.backgroundColor);
        const under =
          bg.length === 4 && bg[3] === 0
            ? rgb(getComputedStyle(document.body).backgroundColor)
            : bg;
        const [l1, l2] = [lum(rgb(cs.color)), lum(under)].sort((x, y) => y - x);
        return { rect: rect(a), contrast: (l1 + 0.05) / (l2 + 0.05) };
      }),
    };
  });

function checkFilmLayout(m, label) {
  const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
  const inside = (r, box, tol = 1) =>
    r.left >= box.left - tol &&
    r.right <= box.right + tol &&
    r.top >= box.top - tol &&
    r.bottom <= box.bottom + tol;
  const screen = { left: 0, top: 0, right: m.vw, bottom: m.vh };
  const apart = (a, b) =>
    a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
  assert.ok(m.scrollWidth <= m.vw, `${label}: horizontal scroll (${m.scrollWidth} > ${m.vw})`);
  // The film fills the window under the one-line header.
  assert.ok(near(m.film.top, m.header.bottom) && near(m.film.bottom, m.vh), `${label}: film box`);
  assert.ok(near(m.film.left, 0) && near(m.film.right, m.vw), `${label}: film width`);
  // Controls on screen: 44 px buttons; chapter segments 44 px tall and at least 24 px wide
  // (WCAG 2.5.8; nine of them share a phone's row); the "replay" label clear of them.
  assert.ok(inside(m.controls, screen), `${label}: controls off screen`);
  assert.ok(m.segMin >= 24, `${label}: segments may shrink below 24 px`);
  for (const r of m.buttons) {
    assert.ok(r.width >= 44 && r.height >= 44, `${label}: a ${r.width}×${r.height} button`);
  }
  for (const r of m.segments) {
    assert.ok(r.width >= 24 && r.height >= 44, `${label}: a ${r.width}×${r.height} segment`);
  }
  for (const r of [...m.buttons, ...m.segments]) {
    assert.ok(inside(r, screen), `${label}: a control off screen`);
    assert.ok(apart(r, m.label), `${label}: "replay" overlaps a control`);
  }
  assert.ok(m.label.width > 0 && inside(m.label, screen), `${label}: "replay" label`);
  // The caption: on screen, large, above the controls.
  assert.ok(inside(m.line, screen), `${label}: caption off screen`);
  assert.ok(m.caption.bottom <= m.controls.top + 1, `${label}: caption over the controls`);
  assert.ok(m.lineSize >= 20, `${label}: caption ${m.lineSize}px`);
  // The camera's target is in view, above the caption.
  assert.ok(m.focus, `${label}: no shot`);
  const free = { left: 0, right: m.vw, top: m.film.top, bottom: m.caption.top };
  assert.ok(
    inside(m.focus, free, 2),
    `${label}: focus ${JSON.stringify(m.focus)} outside ${JSON.stringify(free)}`,
  );
  // The call to action: on screen, between the caption and the controls, 44 px tall, legible.
  for (const { rect: r, contrast } of m.cta) {
    assert.ok(inside(r, screen), `${label}: a call-to-action link off screen`);
    assert.ok(r.top >= m.caption.bottom - 1, `${label}: the call to action overlaps the caption`);
    assert.ok(r.bottom <= m.controls.top + 1, `${label}: the call to action overlaps the controls`);
    assert.ok(r.height >= 44, `${label}: a ${r.height} px call-to-action link`);
    assert.ok(contrast >= 4.5, `${label}: call-to-action contrast ${contrast.toFixed(2)}`);
  }
}

test("layout: every scene's end frame at every size, in both themes, with screenshots", async ({
  newPage,
}) => {
  const problems = [];
  for (const theme of ["light", "dark"]) {
    for (const [width, height] of SIZES) {
      // Reduced motion holds each pose's key frame, so the screenshots are stable.
      const page = await newPage({
        width,
        height,
        mobile: width < 800 || height < 500,
        deviceScaleFactor: 1,
        media: [...scheme(theme), ...REDUCED],
      });
      await page.goto("/");
      await pausedFilm(page);
      const count = await page.eval(() => window.__demo.film.sceneCount);
      for (let n = 0; n < count; n++) {
        await page.eval((i) => window.__demo.film.goTo(i), n);
        await page.frames(2);
        await page.screenshot(`film-${n + 1}-${theme}-${width}x${height}`);
        try {
          checkFilmLayout(await filmLayout(page), `scene ${n + 1} at ${width}×${height} ${theme}`);
        } catch (err) {
          problems.push(err.message.split("\n")[0]);
        }
      }
      await page.close();
    }
  }
  assert.deepEqual(problems, []);
});

test("smoke: every scene's end frame by jump at 1920×1080 and 390×844", async ({ newPage }) => {
  // The layout checks of the screenshot test above, at two sizes, from jumps alone.
  const problems = [];
  for (const [width, height] of [
    [1920, 1080],
    [390, 844],
  ]) {
    const page = await newPage({ width, height, mobile: width < 800, media: REDUCED });
    await page.goto("/");
    await pausedFilm(page);
    const count = await page.eval(() => window.__demo.film.sceneCount);
    for (let n = 0; n < count; n++) {
      await page.eval((i) => window.__demo.film.goTo(i), n);
      await page.frames(2);
      try {
        checkFilmLayout(await filmLayout(page), `scene ${n + 1} at ${width}×${height}`);
      } catch (err) {
        problems.push(err.message.split("\n")[0]);
      }
    }
    await page.close();
  }
  assert.deepEqual(problems, []);
});

// --- Tests: the product page below the film ---------------------------------------------------

const SECTIONS = ["template", "how-it-works", "get-started", "credits"];

// Scrolls down the page a part of a screen at a time to its end (each pen group draws when it
// comes into view), then waits until every pen group is drawn.
const readPage = async (page) => {
  await page.eval(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * 0.5) {
      scrollTo(0, y);
      await frame();
    }
    scrollTo(0, document.documentElement.scrollHeight);
    await frame();
  });
  await page.waitFor(
    () =>
      [...document.querySelectorAll("[data-pen-group]")].every(
        (g) => g.dataset.penState === "drawn",
      ),
    { timeout: 30_000 },
  );
};

// Everything the sections show, measured.
const sectionsState = (page) =>
  page.eval((ids) => {
    const q = (s) => document.querySelector(s);
    const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ");
    const rgb = (c) =>
      c
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number);
    const lum = ([r, g, b]) => {
      const ch = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const contrast = (a, b) => {
      const [l1, l2] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
      return (l1 + 0.05) / (l2 + 0.05);
    };
    // The first opaque background at or above el.
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (!/rgba\(.*,\s*0\)$/.test(c) && c !== "transparent") return c;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const t = q("#template");
    const g = q("#get-started");
    const all = ids.map((id) => document.getElementById(id));
    const els = all.flatMap((s) => (s ? [s, ...s.querySelectorAll("*")] : []));
    // A "0" in each paragraph's font, for its measure in ch.
    const ch = (el) => {
      const probe = document.createElement("span");
      probe.textContent = "0".repeat(10);
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
      el.append(probe);
      const w = probe.getBoundingClientRect().width / 10;
      probe.remove();
      return w;
    };
    return {
      order: [...document.querySelectorAll("main > section, body > footer")].map((s) => s.id),
      figures: [...t.querySelectorAll("a > img")].map((img) => ({
        src: img.getAttribute("src"),
        href: img.parentElement.getAttribute("href"),
        loaded: img.complete && img.naturalWidth > 0,
      })),
      items: t.querySelectorAll("ol.tour > li").length,
      text: text(t),
      commands: g.querySelector("pre").textContent.replace(/\n$/, "").split("\n"),
      links: [...g.querySelectorAll("a")].map((a) => a.getAttribute("href")),
      how: [...document.querySelectorAll("#how-it-works .beat")].map((b) => ({
        title: text(b.querySelector("h3")).trim(),
        cats: [...b.querySelectorAll(".cat")].map((c) => [
          c.dataset.cat,
          c.getAttribute("aria-hidden"),
        ]),
        marks: b.querySelectorAll(".pen-mark").length,
      })),
      credits: {
        text: text(q("#credits")),
        cats: [...document.querySelectorAll("#credits .cat")].map((c) => c.dataset.cat),
        links: [...document.querySelectorAll("#credits a")].map((a) => a.getAttribute("href")),
      },
      marks: Object.fromEntries(all.map((s) => [s.id, s.querySelectorAll(".pen-mark").length])),
      // Pen ink against what it lies on (handwriting: 3:1).
      ink: [...document.querySelectorAll(".sections .pen-note, #credits .pen-note")].map((n) => ({
        text: n.textContent,
        contrast: contrast(getComputedStyle(n).color, bgOf(n.parentElement)),
      })),
      // Pen notes and marks inside the window's width.
      penBoxes: [
        ...document.querySelectorAll(
          ".sections .pen-note, .sections .pen-mark, #credits .pen-note",
        ),
      ].map((n) => {
        const r = n.getBoundingClientRect();
        return { left: r.left, right: r.right, text: n.textContent };
      }),
      // Emoji are decoration: inside aria-hidden.
      bareEmoji: els
        .filter((el) =>
          [...el.childNodes].some(
            (c) => c.nodeType === 3 && /\p{Extended_Pictographic}/u.test(c.textContent),
          ),
        )
        .filter((el) => !el.closest("[aria-hidden='true']"))
        .map((el) => el.textContent.trim()),
      caps: els
        .filter((el) => getComputedStyle(el).textTransform === "uppercase")
        .map((el) => el.textContent.trim()),
      gradients: els
        .filter((el) => /gradient/.test(getComputedStyle(el).backgroundImage))
        .map((el) => el.className),
      arrows: els.filter((el) => el.tagName === "A" && /→/.test(el.textContent)).length,
      // Prose measure, in ch of the paragraph's own font.
      wide: [...document.querySelectorAll(".sections p, #credits p")]
        .filter((p) => !p.classList.contains("pen-note"))
        .map((p) => ({ text: p.textContent.trim().slice(0, 40), ch: p.offsetWidth / ch(p) }))
        .filter((p) => p.ch > 80),
      scrollWidth: document.documentElement.scrollWidth,
      vw: innerWidth,
    };
  }, SECTIONS);

// The README's quick start (the commands in its first bash block after "Quick start").
const quickStart = () => {
  const readme = readFileSync(path.join(TEMPLATE, "README.md"), "utf8");
  return readme
    .slice(readme.indexOf("Quick start"))
    .match(/```bash\n([\s\S]*?)\n```/)[1]
    .split("\n");
};

// The sections' content and calm, as sectionsState measured them at one size and theme: fails
// at once on missing content; adds layout problems (contrast, overflow) to `problems`.
function checkSections(got, label, problems) {
  const quick = quickStart();
  assert.deepEqual(got.order, SECTIONS, `${label}: sections in order`);
  assert.deepEqual(
    got.figures.map((f) => [f.src, f.href]),
    [
      ["img/canonical-1.png", "pdf/canonical.pdf"],
      ["img/canonical-2.png", "pdf/canonical.pdf"],
      ["img/tailored-1.png", "pdf/tailored.pdf"],
    ],
  );
  assert.ok(
    got.figures.every((f) => f.loaded),
    `${label}: page images load`,
  );
  assert.equal(got.items, 6, "six things to notice");
  assert.match(got.text, /Package resume Error: Unknown role key 'windowsil'\./);
  assert.match(got.text, /\.\/canonical\/resume\.tex:60:/);
  assert.match(got.text, /\\defrole\{windowsill\}/);
  assert.match(got.text, /\\begin\{role\}\{windowsill\}/);
  assert.match(got.text, /51 page positions/);
  assert.deepEqual(got.commands, quick, "the README's quick start");
  for (const href of [
    "https://github.com/h1994st/my-resume",
    "https://github.com/h1994st/my-resume/blob/main/CLAUDE.md",
    "https://github.com/h1994st/my-resume/blob/main/.claude/skills/customize-resume/SKILL.md",
    "https://github.com/h1994st/my-resume/blob/main/.claude/skills/update-resume/SKILL.md",
  ]) {
    assert.ok(got.links.includes(href), `link to ${href}`);
  }
  // How it works: three beats, each with a decorative cat and pen marks.
  assert.equal(got.how.length, 3, "three beats");
  assert.match(got.how[0].title, /once/i);
  assert.match(got.how[1].title, /\/customize-resume/);
  assert.match(got.how[2].title, /\/update-resume/);
  for (const beat of got.how) {
    assert.ok(beat.cats.length >= 1, `${label}: a cat in "${beat.title}"`);
    assert.ok(
      beat.cats.every(([, hidden]) => hidden === "true"),
      `${label}: decorative cats`,
    );
    assert.ok(beat.marks >= 1, `${label}: a pen mark in "${beat.title}"`);
  }
  // Credits: the cast, the name, the license, and the fonts.
  assert.deepEqual(got.credits.cats, ["duna", "dudu", "nangnang"]);
  for (const s of [
    "Duna = Du(du) + Na(ngnang)",
    "Dudu",
    "Nangnang",
    "MIT",
    "SIL Open Font License",
    "Source Serif 4",
    "Source Sans 3",
    "Caveat",
    "Duna Feline is fictional.",
  ]) {
    assert.ok(got.credits.text.includes(s), `credits: "${s}"`);
  }
  assert.ok(
    got.credits.links.includes("https://github.com/h1994st/my-resume/blob/main/LICENSE"),
    "credits: the MIT license",
  );
  assert.ok(got.credits.links.includes("fonts/caveat/OFL.txt"), "credits: Caveat's license");
  // The pen: on the template's pages and snippets; legible; inside the window.
  assert.ok(got.marks.template >= 6, `${label}: ${got.marks.template} marks on the template`);
  for (const n of got.ink) {
    if (n.contrast < 3) problems.push(`${label}: note "${n.text}" contrast ${n.contrast}`);
  }
  for (const b of got.penBoxes) {
    if (b.left < -1 || b.right > got.vw + 1) {
      problems.push(`${label}: pen "${b.text}" outside the window (${b.left}–${b.right})`);
    }
  }
  // Calm: no all-caps, gradients, or arrows on links; prose under 80ch; emoji decorative.
  assert.deepEqual(got.caps, [], `${label}: all-caps text`);
  assert.deepEqual(got.gradients, [], `${label}: gradients`);
  assert.equal(got.arrows, 0, `${label}: "→" on a link`);
  assert.deepEqual(got.wide, [], `${label}: prose over 80ch`);
  assert.deepEqual(got.bareEmoji, [], `${label}: emoji not aria-hidden`);
  if (got.scrollWidth > got.vw) {
    problems.push(`${label}: horizontal scroll (${got.scrollWidth} > ${got.vw})`);
  }
}

test("sections: the template, how it works, get started, and credits, at every size in both themes", async ({
  newPage,
}) => {
  const problems = [];
  for (const theme of ["light", "dark"]) {
    for (const [width, height] of SIZES) {
      const label = `${width}×${height} ${theme}`;
      const page = await newPage({
        width,
        height,
        mobile: width < 800 || height < 500,
        deviceScaleFactor: 1,
        media: scheme(theme),
      });
      await page.goto("/");
      await page.eval(() => window.__demo.film.pause());
      await readPage(page);
      await page.waitFor(() =>
        [...document.querySelectorAll("#template img")].every((i) => i.complete && i.naturalWidth),
      );
      const got = await sectionsState(page);
      checkSections(got, label, problems);
      for (const id of SECTIONS) {
        await page.screenshotOf(`#${id}`, `section-${id}-${theme}-${width}x${height}`);
      }
      await page.close();
    }
  }
  assert.deepEqual(problems, []);
});

test("smoke: the sections' verified text and the README's quick start", async ({ newPage }) => {
  const page = await newPage({ width: 1280, height: 720, media: scheme("light") });
  await page.goto("/");
  await page.eval(() => window.__demo.film.pause());
  await readPage(page);
  await page.waitFor(() =>
    [...document.querySelectorAll("#template img")].every((i) => i.complete && i.naturalWidth),
  );
  const problems = [];
  checkSections(await sectionsState(page), "1280×720 light", problems);
  assert.deepEqual(problems, []);
});

test("sections: pen marks draw once when scrolled into view, and redraw at once on a resize", async ({
  newPage,
}) => {
  const page = await newPage({ width: 1280, height: 720, media: scheme("light") });
  await page.goto("/");
  await page.eval(() => window.__demo.film.pause());
  await page.waitFor(() => window.__page?.ready);
  // Nothing is drawn below the fold yet.
  const before = await page.eval(() => ({
    states: [...document.querySelectorAll("[data-pen-group]")].map((g) => g.dataset.penState),
    marks: document.querySelectorAll(".sections .pen-mark, #credits .pen-mark").length,
  }));
  assert.ok(before.states.length >= 8, `${before.states.length} pen groups`);
  assert.ok(
    before.states.every((s) => s === "waiting"),
    `states before scrolling: ${before.states}`,
  );
  assert.equal(before.marks, 0, "no marks before scrolling");
  // Scrolled into view, the first close-up draws on (animated), then is drawn.
  await page.eval(() =>
    document.querySelector("#template .closeup").scrollIntoView({ block: "center" }),
  );
  const drawing = await page.waitFor(() => {
    const g = document.querySelector("#template .closeup");
    if (g.dataset.penState === "drawing") {
      return document.getAnimations().filter((a) => a.playState === "running").length;
    }
    return 0;
  });
  assert.ok(drawing > 0, "the pen draws on");
  await page.waitFor(
    () => document.querySelector("#template .closeup").dataset.penState === "drawn",
  );
  // Tag the drawn marks; scrolling away and back draws nothing new.
  const count = await page.eval(() => {
    const marks = document.querySelectorAll(
      "#template .closeup .pen-mark, #template .closeup .pen-note",
    );
    for (const m of marks) m.dataset.tagged = "1";
    return marks.length;
  });
  assert.ok(count >= 1);
  await page.eval(() => scrollTo(0, 0));
  await page.frames(4);
  await page.eval(() =>
    document.querySelector("#template .closeup").scrollIntoView({ block: "center" }),
  );
  await page.frames(10);
  const again = await page.eval(() => ({
    all: document.querySelectorAll("#template .closeup .pen-mark, #template .closeup .pen-note")
      .length,
    tagged: document.querySelectorAll("#template .closeup [data-tagged]").length,
    state: document.querySelector("#template .closeup").dataset.penState,
  }));
  assert.deepEqual(again, { all: count, tagged: count, state: "drawn" }, "drawn once");
  // A resize redraws a drawn group at once (no animation), to its new size.
  await page.viewport(390, 844);
  await page.waitFor(() => !document.querySelector("#template .closeup [data-tagged]"), {
    timeout: 5000,
  });
  const resized = await page.eval(() => {
    const g = document.querySelector("#template .closeup");
    const box = g.querySelector(".closeup-paper").getBoundingClientRect();
    const marks = [...g.querySelectorAll(".pen-mark")];
    return {
      state: g.dataset.penState,
      marks: marks.length,
      running: document
        .getAnimations()
        .filter((a) => a.playState === "running" && a.effect?.target?.closest?.(".closeup")).length,
      inside: marks.every((m) => {
        const r = m.getBoundingClientRect();
        const cx = (r.left + r.right) / 2;
        const cy = (r.top + r.bottom) / 2;
        return cx > box.left && cx < box.right && cy > box.top && cy < box.bottom;
      }),
    };
  });
  assert.equal(resized.state, "drawn");
  assert.ok(resized.marks >= 1, "marks redrawn");
  assert.equal(resized.running, 0, "redrawn without animation");
  assert.ok(resized.inside, "marks on the resized close-up");
});

test("sections: with reduced motion every pen mark is drawn at once, without animation", async ({
  newPage,
}) => {
  const page = await newPage({ width: 1280, height: 720, media: REDUCED });
  await page.goto("/");
  await page.waitFor(() => window.__page?.ready);
  const got = await page.eval(() => ({
    states: [...document.querySelectorAll("[data-pen-group]")].map((g) => g.dataset.penState),
    marks: document.querySelectorAll(".sections .pen-mark").length,
    running: document
      .getAnimations()
      .filter((a) => a.playState === "running")
      .filter((a) => a.effect?.target?.closest?.(".sections, #credits")).length,
    // Cats hold still.
    catMotion: [...document.querySelectorAll(".sections .cat, #credits .cat")].some((c) =>
      [...c.querySelectorAll("*")].some((n) => getComputedStyle(n).animationName !== "none"),
    ),
  }));
  assert.ok(
    got.states.every((s) => s === "drawn"),
    `states: ${got.states}`,
  );
  assert.ok(got.marks >= 6, `${got.marks} marks`);
  assert.equal(got.running, 0, "no running animations in the sections");
  assert.equal(got.catMotion, false, "no cat motion");
});

test("sections: each close-up's pen mark sits on what it names in the real PDF", async ({
  newPage,
}) => {
  // Word boxes of the canonical PDF's first page, in pt (pdftotext -bbox, from poppler).
  const { execFileSync } = await import("node:child_process");
  const xml = execFileSync(
    "pdftotext",
    ["-f", "1", "-l", "1", "-bbox", path.join(SITE, "pdf/canonical.pdf"), "-"],
    { encoding: "utf8" },
  );
  const size = xml
    .match(/<page width="([\d.]+)" height="([\d.]+)"/)
    .slice(1)
    .map(Number);
  const words = [
    ...xml.matchAll(
      /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g,
    ),
  ].map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], w: m[5] }));
  // The first run of words that spells `phrase`, as one box.
  const find = (phrase) => {
    const want = phrase.split(" ");
    for (let i = 0; i < words.length; i++) {
      const run = words.slice(i, i + want.length);
      if (run.length === want.length && run.every((w, k) => w.w.startsWith(want[k]))) {
        return {
          x0: Math.min(...run.map((w) => w.x0)),
          y0: Math.min(...run.map((w) => w.y0)),
          x1: Math.max(...run.map((w) => w.x1)),
          y1: Math.max(...run.map((w) => w.y1)),
        };
      }
    }
    throw new Error(`"${phrase}" not on page 1`);
  };
  const page = await newPage({ width: 1280, height: 720, media: REDUCED });
  await page.goto("/");
  await page.waitFor(() => window.__page?.ready);
  const closeups = await page.eval(() =>
    [...document.querySelectorAll("#template .closeup")].map((c) => ({
      crop: c.dataset.crop.split(" ").map(Number),
      mark: c.dataset.mark.split(" "),
      expect: c.dataset.expect,
      src: c.querySelector("img").getAttribute("src"),
      drawn: c.querySelectorAll(".pen-mark").length,
    })),
  );
  assert.ok(closeups.length >= 4, `${closeups.length} close-ups`);
  assert.deepEqual(size, [612, 792], "US Letter pages");
  const tol = 3;
  for (const c of closeups) {
    assert.equal(c.src, "img/canonical-1.png", "close-ups are of the real page 1");
    assert.ok(c.drawn >= 1, `${c.expect}: drawn`);
    const [, ...nums] = c.mark;
    const [mx, my, mw, mh] = nums.map(Number);
    const m = { x0: mx, y0: my, x1: mx + mw, y1: my + mh };
    const [cx, cy, cw, ch] = c.crop;
    // The mark lies inside the crop.
    assert.ok(
      m.x0 >= cx && m.x1 <= cx + cw && m.y0 >= cy && m.y1 <= cy + ch,
      `${c.expect}: mark outside its crop`,
    );
    if (c.expect === "spine") {
      // The spine is drawn, not text: left of the role titles, alongside them.
      for (const title of ["Head of Windowsill", "Senior Box Inspector"]) {
        const b = find(title);
        assert.ok(m.x1 <= b.x0 && b.x0 - m.x1 < 15, `spine: not just left of "${title}"`);
        const mid = (b.y0 + b.y1) / 2;
        assert.ok(mid > m.y0 && mid < m.y1, `spine: not alongside "${title}"`);
      }
      continue;
    }
    // Text: the words inside the mark's box, and the box hugging them.
    const b = find(c.expect);
    assert.ok(
      b.x0 >= m.x0 - tol && b.x1 <= m.x1 + tol && b.y0 >= m.y0 - tol && b.y1 <= m.y1 + tol,
      `${c.expect}: words ${JSON.stringify(b)} outside the mark ${JSON.stringify(m)}`,
    );
    assert.ok(
      b.x0 - m.x0 < 12 && m.x1 - b.x1 < 12 && b.y0 - m.y0 < 8 && m.y1 - b.y1 < 8,
      `${c.expect}: mark ${JSON.stringify(m)} loose around ${JSON.stringify(b)}`,
    );
  }
});

test("sections: links show a visible keyboard focus ring", async ({ newPage }) => {
  const page = await newPage({ width: 1280, height: 720 });
  await page.goto("/");
  await page.eval(() => window.__demo.film.pause());
  await page.key("Tab");
  const rings = await page.eval(() =>
    [...document.querySelectorAll(".sections a, #credits a")].map((a) => {
      a.focus();
      const cs = getComputedStyle(a);
      return {
        href: a.getAttribute("href"),
        visible: a.matches(":focus-visible") && cs.outlineStyle !== "none",
        width: parseFloat(cs.outlineWidth),
      };
    }),
  );
  assert.ok(rings.length >= 8);
  for (const r of rings) assert.ok(r.visible && r.width >= 2, `no focus ring on ${r.href}`);
});

test("head: title, description, theme colour, Open Graph image, favicon", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/");
  const head = await page.eval(() => ({
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content,
    theme: document.querySelector('meta[name="theme-color"]')?.content,
    og: document.querySelector('meta[property="og:image"]')?.content,
    ogUrl: document.querySelector('meta[property="og:url"]')?.content,
    icon: document.querySelector('link[rel="icon"]')?.getAttribute("href"),
  }));
  assert.equal(head.title, "my-resume");
  assert.ok(head.description?.length > 20, "a description");
  assert.ok(head.theme, "a theme colour");
  // Open Graph needs absolute URLs.
  assert.equal(head.og, "https://shengtuo.me/my-resume/img/canonical-1.png");
  assert.equal(head.ogUrl, "https://shengtuo.me/my-resume/");
  assert.match(head.icon ?? "", /^data:image\/svg\+xml,/);

  // SEO: a canonical URL, structured data tied to the homepage's Person, and a sitemap.
  const seo = await page.eval(() => ({
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map(
      (s) => s.textContent,
    ),
  }));
  assert.equal(seo.canonical, "https://shengtuo.me/my-resume/");
  assert.equal(seo.ld.length, 1, "one JSON-LD block");
  const ld = JSON.parse(seo.ld[0]);
  assert.equal(ld["@type"], "SoftwareSourceCode");
  assert.equal(ld.url, "https://shengtuo.me/my-resume/");
  assert.equal(ld.codeRepository, "https://github.com/h1994st/my-resume");
  assert.equal(ld.author?.["@id"], "https://shengtuo.me/#person");
  const sitemap = readFileSync(path.join(SITE, "sitemap.xml"), "utf8");
  assert.match(sitemap, /<loc>https:\/\/shengtuo\.me\/my-resume\/<\/loc>/);
  assert.match(sitemap, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
});

// --- Tests: themes, cast, and pen kit --------------------------------------------------------

const scheme = (value) => [{ name: "prefers-color-scheme", value }];
// The desk colour (spec) as computed style reports it.
const DESK = { light: "rgb(238, 240, 243)", dark: "rgb(27, 31, 37)" };
const PEN = {
  paper: "rgb(194, 65, 12)",
  desk: { light: "rgb(194, 65, 12)", dark: "rgb(251, 146, 60)" },
};
const CAST = {
  duna: { coat: "#9aa3ad", stripe: "#59626d", light: "#eceff2", iris: "#e3a72f", nose: "#e48b8b" },
  dudu: { coat: "#8c939c", stripe: "#8c939c", light: "#b9bfc6", iris: "#8fc27a", nose: "#c98a8f" },
  nangnang: {
    coat: "#b48c5f",
    stripe: "#5a4230",
    light: "#f2e7d7",
    iris: "#b9c25a",
    nose: "#d98579",
  },
};
const POSES = ["sit", "wave", "jump", "tap", "blink"];
const MARKS = ["circle", "underline", "strike", "arrow"];

// The theme as the page shows it: the stored choice, data-theme, the desk, and the toggle.
const themeState = (page) =>
  page.eval(() => {
    const button = document.getElementById("theme-toggle");
    return {
      stored: localStorage.getItem("theme"),
      attr: document.documentElement.dataset.theme ?? null,
      bg: getComputedStyle(document.body).backgroundColor,
      pressed: button?.getAttribute("aria-pressed") ?? null,
      // The accessible name: constant; aria-pressed carries the state.
      name: button
        ? (button.getAttribute("aria-label") ?? button.textContent).replace(/\s+/g, " ").trim()
        : null,
    };
  });
// localStorage outlives a test (one browser profile for the run), so theme tests clean up.
const forgetTheme = (page) => page.eval(() => localStorage.removeItem("theme"));
const toggleTheme = (page) => page.eval(() => document.getElementById("theme-toggle").click());

test("theme: follows the system setting while nothing is stored", async ({ newPage }) => {
  for (const [width, height] of [
    [1280, 720],
    [390, 844],
  ]) {
    const page = await newPage({ width, height, mobile: width < 800, media: scheme("dark") });
    await page.goto("/");
    await forgetTheme(page);
    await page.goto("/");
    assert.deepEqual(await themeState(page), {
      stored: null,
      attr: null,
      bg: DESK.dark,
      pressed: "true",
      name: "Dark theme",
    });
    await page.eval(() => window.__demo.film.pause());
    await page.screenshot(`theme-dark-${width}x${height}`);
    await page.screenshotOf("#template", `theme-dark-template-${width}x${height}`);
    await page.media(scheme("light"));
    await page.frames(2);
    assert.deepEqual(await themeState(page), {
      stored: null,
      attr: null,
      bg: DESK.light,
      pressed: "false",
      name: "Dark theme",
    });
    await page.screenshot(`theme-light-${width}x${height}`);
    // The toggle sits in the one-line header, on screen, with a 44px target.
    const m = await page.eval(() => {
      const b = document.getElementById("theme-toggle").getBoundingClientRect();
      const h = document.querySelector(".site-title").getBoundingClientRect();
      const hit = (x, y) => document.elementFromPoint(x, y)?.closest("#theme-toggle") !== null;
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      return {
        vw: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        b: b.toJSON(),
        header: h.height,
        target: hit(cx, cy - 21) && hit(cx, cy + 21) && hit(cx - 21, cy) && hit(cx + 21, cy),
      };
    });
    assert.ok(m.b.left >= 0 && m.b.right <= m.vw, `${width}: toggle off screen`);
    assert.equal(m.header, 48, `${width}: header height`);
    assert.ok(m.target, `${width}: toggle target under 44px`);
    assert.ok(m.scrollWidth <= m.vw, `${width}: horizontal scroll`);
    await page.close();
  }
});

test("theme: the toggle sets data-theme and keeps it across a reload", async ({ newPage }) => {
  const page = await newPage({ media: scheme("light") });
  await page.goto("/");
  await forgetTheme(page);
  try {
    await page.goto("/");
    await toggleTheme(page);
    const dark = {
      stored: "dark",
      attr: "dark",
      bg: DESK.dark,
      pressed: "true",
      name: "Dark theme",
    };
    assert.deepEqual(await themeState(page), dark);
    assert.deepEqual(
      await page.eval(() => window.__demo.events.filter((e) => e.name === "theme")),
      [{ name: "theme", params: { theme: "dark" } }],
      "onChange reports the choice",
    );
    await page.goto("/");
    assert.deepEqual(await themeState(page), dark, "after a reload");
    // A stored choice wins over the system setting.
    await page.media(scheme("dark"));
    await page.media(scheme("light"));
    await page.frames(2);
    assert.deepEqual(await themeState(page), dark, "after a system change");
    await toggleTheme(page);
    await page.media(scheme("dark"));
    await page.goto("/");
    assert.deepEqual(await themeState(page), {
      stored: "light",
      attr: "light",
      bg: DESK.light,
      pressed: "false",
      name: "Dark theme",
    });
  } finally {
    await forgetTheme(page);
  }
});

test("theme: a stored theme applies before the first paint", async ({ newPage }) => {
  for (const [system, stored] of [
    ["light", "dark"],
    ["dark", "light"],
  ]) {
    const page = await newPage({ media: scheme(system) });
    await page.goto("/");
    await page.eval((t) => localStorage.setItem("theme", t), stored);
    try {
      // Records data-theme changes and the desk colour at the first frame and at load.
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
          window.__paint = [];
          const note = (when) => window.__paint.push({
            when,
            theme: document.documentElement.dataset.theme ?? null,
            body: Boolean(document.body),
            desk: getComputedStyle(document.documentElement).getPropertyValue("--desk").trim(),
          });
          // Observed from the document: the <html> element doesn't exist yet.
          new MutationObserver(() => note("attr")).observe(document, {
            attributes: true,
            attributeFilter: ["data-theme"],
            subtree: true,
          });
          requestAnimationFrame(() => note("frame"));
          addEventListener("load", () => note("load"));
        `,
      });
      await page.goto("/");
      const paint = await page.eval(() => window.__paint);
      const desk = stored === "dark" ? "#1b1f25" : "#eef0f3";
      const attr = paint.filter((p) => p.when === "attr");
      assert.equal(attr.length, 1, `one data-theme change: ${JSON.stringify(paint)}`);
      assert.equal(attr[0].theme, stored);
      assert.equal(attr[0].body, false, "set while the head is parsed");
      const frame = paint.find((p) => p.when === "frame");
      assert.deepEqual([frame.theme, frame.desk], [stored, desk], "first frame");
      const load = paint.find((p) => p.when === "load");
      assert.deepEqual([load.theme, load.desk], [stored, desk], "at load");
    } finally {
      await forgetTheme(page);
      await page.close();
    }
  }
});

test("theme: the toggle shows the theme on screen before main.js runs", async ({ newPage }) => {
  for (const [system, stored, pressed] of [
    ["dark", null, "true"],
    ["light", null, "false"],
    ["light", "dark", "true"],
    ["dark", "light", "false"],
  ]) {
    const page = await newPage({ media: scheme(system) });
    await page.goto("/");
    await page.eval(
      (t) => (t ? localStorage.setItem("theme", t) : localStorage.removeItem("theme")),
      stored,
    );
    try {
      // main.js (theme.js) never loads: only the page's inline scripts run.
      await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/main.js" }] });
      const off = page.cdp.on((msg) => {
        if (msg.sessionId !== page.sessionId || msg.method !== "Fetch.requestPaused") return;
        page.send("Fetch.failRequest", {
          requestId: msg.params.requestId,
          errorReason: "BlockedByClient",
        });
      });
      await page.goto("/", { waitForDemo: false });
      off();
      const got = await page.eval(() => ({
        demo: Boolean(window.__demo),
        pressed: document.getElementById("theme-toggle").getAttribute("aria-pressed"),
      }));
      assert.deepEqual(got, { demo: false, pressed }, `system ${system}, stored ${stored}`);
    } finally {
      await forgetTheme(page);
      await page.close();
    }
  }
});

test("assembled site: the Caveat fonts and their license", async () => {
  const dir = path.join(SITE, "fonts/caveat");
  for (const file of ["caveat-latin-400-normal.woff2", "caveat-latin-600-normal.woff2"]) {
    assert.ok(existsSync(path.join(dir, file)), `${file} in the site`);
  }
  const ofl = path.join(dir, "OFL.txt");
  assert.ok(existsSync(ofl), "fonts/caveat/OFL.txt in the site");
  assert.match(readFileSync(ofl, "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
});

// Everything the kit page draws, measured.
const kitState = (page) =>
  page.eval(() => {
    const css = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();
    const box = (els) => {
      const rs = [...els].map((e) => e.getBoundingClientRect());
      return {
        left: Math.min(...rs.map((r) => r.left)),
        top: Math.min(...rs.map((r) => r.top)),
        right: Math.max(...rs.map((r) => r.right)),
        bottom: Math.max(...rs.map((r) => r.bottom)),
      };
    };
    const marks = {};
    for (const el of document.querySelectorAll(".kit .pen-mark")) {
      const target = document.querySelector(`.kit [data-kit-target="${el.dataset.kind}"]`);
      marks[el.dataset.kind] = {
        mark: box(el.querySelectorAll("path")),
        target: target && box([target]),
        drawn: [...el.querySelectorAll("path")].every(
          (p) => parseFloat(getComputedStyle(p).strokeDashoffset) === 0,
        ),
        color: getComputedStyle(el).color,
      };
    }
    return {
      symbols: document.querySelectorAll("symbol#cat").length,
      cats: [...document.querySelectorAll(".kit .cat")].map((c) => ({
        name: c.dataset.cat,
        pose: c.dataset.pose,
        api: typeof c.pose === "function" && typeof c.idle === "function",
        colors: Object.fromEntries(
          ["coat", "stripe", "light", "iris", "nose"].map((k) => [k, css(c, `--${k}`)]),
        ),
        edge: css(c, "--cat-edge"),
        size: c.getBoundingClientRect().width,
      })),
      marks,
      notes: [...document.querySelectorAll(".kit .pen-note")].map((n) => ({
        ink: n.dataset.ink,
        color: getComputedStyle(n).color,
        font: getComputedStyle(n).fontFamily,
        emoji: [...n.querySelectorAll("[aria-hidden='true']")].map((e) => e.textContent),
        text: n.textContent,
      })),
      caveat: document.fonts.check("400 24px Caveat") && document.fonts.check("600 24px Caveat"),
      vw: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });

test("kit: the three cats in every pose and every pen mark, in both themes", async ({
  newPage,
}) => {
  for (const theme of ["light", "dark"]) {
    // Reduced motion: poses hold still, so the screenshots are stable.
    const page = await newPage({ width: 1280, height: 900, media: [...scheme(theme), ...REDUCED] });
    await page.goto("/?kit", { waitForDemo: false });
    await page.waitFor(() => window.__kit?.ready);
    await page.eval(() => document.fonts.ready.then(() => true));
    const k = await kitState(page);
    assert.equal(k.symbols, 1, "one cat symbol");
    for (const name of Object.keys(CAST)) {
      const cats = k.cats.filter((c) => c.name === name);
      assert.deepEqual(
        cats.map((c) => c.pose),
        POSES,
        `${name}: every pose`,
      );
      for (const c of cats) {
        assert.ok(c.api, `${name}: pose() and idle()`);
        assert.deepEqual(c.colors, CAST[name], `${name}: colours`);
        assert.ok(c.size > 60, `${name}: drawn`);
      }
    }
    const edge = k.cats[0].edge;
    if (theme === "dark") assert.notEqual(edge, "transparent", "a faint outline in dark");
    else assert.equal(edge, "transparent", "no outline in light");
    assert.deepEqual(Object.keys(k.marks).sort(), [...MARKS].sort(), "every mark kind");
    for (const kind of MARKS) {
      const { mark: m, target: t, drawn } = k.marks[kind];
      assert.ok(t, `${kind}: a target`);
      assert.ok(drawn, `${kind}: drawn (instant)`);
      const w = t.right - t.left;
      const h = t.bottom - t.top;
      const label = `${kind} ${JSON.stringify(m)} vs ${JSON.stringify(t)}`;
      if (kind === "circle") {
        assert.ok(
          m.left <= t.left + 2 &&
            m.right >= t.right - 2 &&
            m.top <= t.top + 2 &&
            m.bottom >= t.bottom - 2,
          `${label}: rings the target`,
        );
      } else if (kind === "underline" || kind === "strike") {
        assert.ok(m.left <= t.left + 0.1 * w && m.right >= t.right - 0.1 * w, `${label}: spans it`);
        const mid = (m.top + m.bottom) / 2;
        if (kind === "underline") assert.ok(mid >= t.bottom - 0.25 * h, `${label}: below`);
        else assert.ok(mid > t.top + 0.25 * h && mid < t.bottom - 0.25 * h, `${label}: through`);
      } else {
        const gap = Math.max(
          t.left - m.right,
          m.left - t.right,
          t.top - m.bottom,
          m.top - t.bottom,
        );
        assert.ok(gap <= 24, `${label}: points at the target`);
        assert.ok(
          !(m.left >= t.left && m.right <= t.right && m.top >= t.top && m.bottom <= t.bottom),
          `${label}: from outside`,
        );
      }
      assert.equal(k.marks[kind].color, PEN.paper, `${kind}: paper pen colour`);
    }
    const desk = k.notes.filter((n) => n.ink === "desk");
    const paper = k.notes.filter((n) => n.ink === "paper");
    assert.ok(desk.length >= 1 && paper.length >= 1, "notes on the desk and on paper");
    for (const n of desk) assert.equal(n.color, PEN.desk[theme], `desk note colour in ${theme}`);
    for (const n of paper) assert.equal(n.color, PEN.paper, "paper note colour");
    // A note anchored to the paper but written on the desk takes the desk's ink.
    const anchored = k.notes.find((n) => n.text.startsWith("which one is true?"));
    assert.deepEqual(
      [anchored?.ink, anchored?.color],
      ["desk", PEN.desk[theme]],
      `desk note anchored to paper in ${theme}`,
    );
    for (const n of k.notes) assert.match(n.font, /^"?Caveat"?/, "notes in Caveat");
    assert.ok(k.caveat, "Caveat 400 and 600 loaded");
    assert.ok(
      k.notes.some((n) => n.emoji.includes("🙀")),
      "emoji in notes are aria-hidden",
    );
    assert.ok(k.scrollWidth <= k.vw, "no horizontal scroll");
    await page.screenshotOf(".kit", `kit-${theme}`);
    await page.close();
  }
});

test("kit: idle motion and pose loops, and none with reduced motion", async ({ newPage }) => {
  for (const reduced of [false, true]) {
    const page = await newPage({ media: reduced ? REDUCED : [] });
    await page.goto("/?kit", { waitForDemo: false });
    await page.waitFor(() => window.__kit?.ready);
    const got = await page.eval(async () => {
      const { createCat } = await import("./cast.js");
      const cat = createCat("duna", { pose: "wave" });
      cat.id = "test-cat";
      document.querySelector(".kit").prepend(cat);
      const state = () => ({
        pose: cat.dataset.pose,
        idle: getComputedStyle(cat).getPropertyValue("--cat-wag").trim() !== "none",
        moving: cat.getAnimations({ subtree: true }).length > 0,
      });
      const out = { wave: state() };
      cat.idle(false);
      out.still = state();
      cat.idle(true);
      await cat.pose("sit");
      out.sit = state();
      let threw = false;
      try {
        createCat("rex");
      } catch {
        threw = true;
      }
      out.threw = threw;
      return out;
    });
    assert.deepEqual(got, {
      wave: { pose: "wave", idle: !reduced, moving: !reduced },
      still: { pose: "wave", idle: false, moving: !reduced },
      sit: { pose: "sit", idle: !reduced, moving: false },
      threw: true,
    });
    // Idle life runs inside the <use> tree, out of reach of getAnimations(): compare pixels.
    const frame = async () => {
      const clip = await page.eval(() => {
        const r = document.getElementById("test-cat").getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      });
      const { data } = await page.send("Page.captureScreenshot", {
        format: "png",
        clip: { ...clip, scale: 1 },
      });
      return data;
    };
    // Pixels that differ clearly between two frames (PNG bytes alone vary with rasterization).
    const changes = async () => {
      const a = await frame();
      await sleep(700);
      const b = await frame();
      const moved = await page.eval(
        async (x, y) => {
          const pixels = async (data) => {
            const img = new Image();
            img.src = `data:image/png;base64,${data}`;
            await img.decode();
            const c = new OffscreenCanvas(img.width, img.height);
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            return ctx.getImageData(0, 0, img.width, img.height).data;
          };
          const [p, q] = await Promise.all([pixels(x), pixels(y)]);
          let n = 0;
          for (let i = 0; i < p.length; i += 4) {
            if (Math.max(...[0, 1, 2].map((k) => Math.abs(p[i + k] - q[i + k]))) > 24) n++;
          }
          return n;
        },
        a,
        b,
      );
      return moved > 40;
    };
    await page.eval(() => document.getElementById("test-cat").pose("sit"));
    await page.frames(3);
    assert.equal(await changes(), !reduced, `idle on, reduced motion ${reduced}`);
    await page.eval(() => document.getElementById("test-cat").idle(false));
    await page.frames(3);
    assert.equal(await changes(), false, `idle off, reduced motion ${reduced}`);
    await page.close();
  }
});

test("pen: marks and notes draw on, resolve when drawn, and stop on abort", async ({ newPage }) => {
  for (const reduced of [false, true]) {
    const page = await newPage({ media: reduced ? REDUCED : [] });
    await page.goto("/?kit", { waitForDemo: false });
    await page.waitFor(() => window.__kit?.ready);
    const got = await page.eval(async () => {
      const pen = await import("./pen.js");
      const layer = document.querySelector(".kit-paper");
      const target = layer.querySelector('[data-kit-target="circle"]');
      const offsets = (svg) =>
        [...svg.querySelectorAll("path")].map((p) =>
          parseFloat(getComputedStyle(p).strokeDashoffset),
        );
      const count = () => layer.querySelectorAll(".pen-mark, .pen-note").length;
      const before = count();
      let t = performance.now();
      const pending = pen.mark(target, "circle");
      await new Promise(requestAnimationFrame);
      const svg = await pending;
      const markMs = performance.now() - t;
      const drawn = offsets(svg).every((o) => o === 0);
      t = performance.now();
      const note = await pen.note("moved up!", { x: 20, y: 20 }, { layer });
      const noteMs = performance.now() - t;
      const instant = pen.markInstant({ x: 10, y: 10, w: 80, h: 20 }, "strike", { layer });
      const instantDrawn = offsets(instant).every((o) => o === 0);
      const instantNote = pen.noteInstant("hi 👋", { x: 10, y: 40 }, { layer });
      const rejects = async (promise) => {
        try {
          await promise;
          return null;
        } catch (e) {
          return e.name;
        }
      };
      // Aborted before it starts: nothing is drawn.
      const early = await rejects(pen.mark(target, "underline", { signal: AbortSignal.abort() }));
      const afterEarly = count();
      // Aborted while drawing (only possible with motion): the mark goes away.
      const ctl = new AbortController();
      const aborted = pen.mark(target, "underline", { signal: ctl.signal });
      const n = count();
      ctl.abort();
      const late = await rejects(aborted);
      const after = count();
      return {
        early: [early, afterEarly - before],
        added: n - before,
        after: after - before,
        drawn,
        markMs,
        noteMs,
        instant: instantDrawn,
        noteText: [note.textContent, instantNote.textContent],
        emoji: instantNote.querySelector("[aria-hidden='true']")?.textContent,
        late,
      };
    });
    const label = reduced ? "reduced motion" : "motion";
    assert.ok(got.drawn, `${label}: drawn when resolved`);
    if (reduced) {
      assert.ok(got.markMs < 100 && got.noteMs < 100, `${label}: instant (${got.markMs} ms)`);
    } else {
      assert.ok(got.markMs >= 250, `${label}: the mark draws on (${got.markMs} ms)`);
      assert.ok(got.noteMs >= 250, `${label}: the note writes on (${got.noteMs} ms)`);
    }
    assert.ok(got.instant, `${label}: instant marks are drawn at once`);
    assert.deepEqual(got.noteText, ["moved up!", "hi 👋"]);
    assert.equal(got.emoji, "👋", "emoji are decorative");
    assert.deepEqual(got.early, ["AbortError", 4], `${label}: an aborted signal draws nothing`);
    assert.equal(got.added, 5, `${label}: four marks/notes plus the pending one`);
    if (reduced) {
      assert.deepEqual([got.late, got.after], [null, 5], `${label}: drawn before the abort`);
    } else {
      assert.deepEqual([got.late, got.after], ["AbortError", 4], `${label}: abort removes it`);
    }
    await page.close();
  }
});

// --- Analytics -------------------------------------------------------------------------------

const dataLayer = (page) =>
  page.eval(() => (window.dataLayer ? window.dataLayer.map((c) => Array.from(c)) : null));

test("analytics: debug mode fills dataLayer with the exact event sequence", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/?analytics=debug&speed=16");
  // Autoplay reports act 1 when scene 1 starts; wait for it before pausing, or a slow runner
  // pauses first and act 1 never plays.
  await page.waitFor(() =>
    window.dataLayer?.some((c) => c[0] === "event" && c[1] === "demo_act" && c[2]?.act === 1),
  );
  await page.eval(() => window.__demo.film.pause());
  await page.key("ArrowRight");
  const before = await page.eval(() => document.documentElement.dataset.theme ?? "");
  await page.eval(() => document.getElementById("theme-toggle").click());
  const theme = await page.eval(() => document.documentElement.dataset.theme);
  assert.notEqual(theme, before);
  await page.eval(() => document.querySelector('.fc-seg[data-scene="3"]').click());
  await page.eval(() => {
    const { film } = window.__demo;
    while (film.scene < film.sceneCount - 1) film.next();
  });
  await page.eval(() => document.getElementById("theme-toggle").click());
  const back = await page.eval(() => document.documentElement.dataset.theme);
  const names = ["problem", "meet", "job", "prompt", "plan", "tailor", "ship", "update", "cta"];
  const count = await page.eval(() => window.__demo.film.sceneCount);
  assert.equal(count, 9);
  const commands = (await dataLayer(page)).map(([cmd, a, b]) => [cmd, a, b]);
  assert.equal(commands[0][0], "js");
  assert.deepEqual(commands[1].slice(0, 3), [
    "config",
    "G-ZMH6NLL7C7",
    { content_group: "my-resume" },
  ]);
  const events = commands.slice(2);
  assert.ok(
    events.every(([cmd]) => cmd === "event"),
    "only event commands after config",
  );
  const shown = events.filter(([, n]) => n === "demo_act").map(([, , p]) => p.act);
  assert.deepEqual(
    events.filter(([, n]) => n === "demo_act").map(([, , p]) => p.act_name),
    shown.map((a) => names[a - 1]),
  );
  assert.deepEqual(shown, [...new Set(shown)], "each act once");
  assert.deepEqual(shown, [1, 2, 3, 4, 5, 6, 7, 8, 9], "every act, in order");
  const order = events.map(([, n]) => n);
  assert.equal(order[0], "demo_act", "act 1 when autoplay starts, before any interaction");
  assert.equal(order[1], "tutorial_begin", "then the first interaction");
  assert.equal(order.at(-2), "tutorial_complete", "complete, then the second toggle");
  assert.deepEqual([...new Set(order)].sort(), [
    "demo_act",
    "theme_change",
    "tutorial_begin",
    "tutorial_complete",
  ]);
  assert.deepEqual(
    events.filter(([, n]) => n === "theme_change"),
    [
      ["event", "theme_change", { theme }],
      ["event", "theme_change", { theme: back }],
    ],
  );
  assert.deepEqual(
    events.filter(([, n]) => n === "tutorial_begin"),
    [["event", "tutorial_begin", { method: "key" }]],
  );
  assert.deepEqual(
    events.filter(([, n]) => n === "tutorial_complete"),
    [["event", "tutorial_complete", { method: "manual" }]],
  );
  assert.ok(!events.some(([, name]) => name === "page_view"), "no manual page_view");
  assert.equal(
    await page.eval(() => document.querySelectorAll('script[src*="googletagmanager"]').length),
    0,
    "debug mode loads no Google script",
  );
});

test("analytics: off the site (127.0.0.1) nothing is set up or loaded", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/");
  await page.frames(4);
  await page.eval(() => window.__demo.film.next());
  assert.equal(await dataLayer(page), null);
  assert.equal(await page.eval(() => typeof window.gtag), "undefined");
  assert.equal(
    await page.eval(() => document.querySelectorAll('script[src*="googletagmanager"]').length),
    0,
  );
});

test("analytics: a throwing gtag does not stop the demo", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/?analytics=debug");
  await page.eval(() => window.__demo.film.pause());
  await page.waitFor(() => window.dataLayer?.some((c) => c[0] === "config"));
  await page.eval(() => {
    window.gtag = () => {
      throw new Error("gtag broke");
    };
  });
  await page.eval(() => {
    const { film } = window.__demo;
    while (film.scene < film.sceneCount - 1) film.next();
  });
  assert.equal(
    await page.eval(() => window.__demo.film.scene === window.__demo.film.sceneCount - 1),
    true,
  );
});

test("no absolute script, stylesheet, or media URLs except Google's gtag", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/");
  // rel=canonical names this page's own URL; nothing is fetched from it.
  const urls = await page.eval(() =>
    [
      ...document.querySelectorAll(
        'script[src], link[href]:not([rel="canonical"]), img[src], source[src], iframe[src]',
      ),
    ]
      .map((el) => el.getAttribute("src") ?? el.getAttribute("href"))
      .filter((u) => /^(https?:)?\/\//.test(u)),
  );
  assert.deepEqual(urls, []);
  for (const file of [
    "main.js",
    "analytics.js",
    "film.js",
    "camera.js",
    "scenes.js",
    "theme.js",
    "cast.js",
    "pen.js",
    "kit.js",
    "page.js",
    "style.css",
  ]) {
    const text = readFileSync(path.join(SITE, file), "utf8");
    const found = [...text.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
    for (const u of found) {
      assert.ok(
        // gtag; SVG namespaces; the repo's own links (the film's call to action); the
        // demo's typed example URL (text, never fetched).
        u.startsWith("https://www.googletagmanager.com/gtag/js") ||
          /w3\.org/.test(u) ||
          /^https:\/\/github\.com\/h1994st\/my-resume(\/generate)?$/.test(u) ||
          u.startsWith("https://example.com/"),
        `${file}: unexpected absolute URL ${u}`,
      );
    }
  }
  const js = readFileSync(path.join(SITE, "analytics.js"), "utf8");
  assert.ok(js.includes("https://www.googletagmanager.com/gtag/js"));
});

await main();
