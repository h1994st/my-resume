#!/usr/bin/env node
// Browser tests for the site: headless Chrome driven over the DevTools protocol with Node's
// built-ins only (global WebSocket, node:http, node:assert, node:child_process). No npm.
//
// Usage:  site/assemble.sh build/site .   (after `just build` and `just build applications/…`)
//         node site/tests/browser.mjs [name-filter]
// Env:    CHROME=<path to Chrome>  (default: the macOS app, else `google-chrome` on PATH)
//         SITE_DIR=<dir to serve>  (default: build/site)
// Screenshots go to build/site-shots/. Prints one line per test; exits 1 if any test fails.
//
// Adding a test: test("name", async ({ newPage }) => { const page = await newPage({ width, height,
// media }); await page.goto("/"); assert.equal(await page.eval(() => 1 + 1), 2); }). Pages are
// closed after the test, and an uncaught exception in any page fails the test.

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

  // The mouse pointer moved to (x, y) in CSS px.
  mouse(x, y) {
    return this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
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

async function main() {
  if (!existsSync(path.join(SITE, "index.html"))) {
    console.error(`no site at ${SITE}; run site/assemble.sh build/site . first`);
    process.exit(2);
  }
  const filter = process.argv[2] ?? "";
  const { server, port } = await serve(SITE);
  const base = `http://127.0.0.1:${port}/`;
  const chrome = launchChrome();
  let failed = 0;
  try {
    const cdp = await CDP.connect(await chrome.url);
    for (const { name, fn } of TESTS.filter((t) => t.name.includes(filter))) {
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
  const page = await newPage();
  await page.goto("/");
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
  const captions = await page.eval(async () =>
    (await import("./scenes.js")).SCENES.map((s) => s.caption.replace(/\*/g, "")),
  );
  for (const c of captions) assert.ok(a11y.transcript.includes(c), `transcript: ${c}`);
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
  [1280, 720],
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
      targets: [...document.querySelectorAll(".fc-btn, .fc-seg")].map(rect),
      label: rect(q(".fc-label")),
      caption: rect(q(".film-caption")),
      line: rect(q(".film-line")),
      lineSize: parseFloat(getComputedStyle(q(".film-line")).fontSize),
      focus: window.__demo.film.focus(),
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
  // Controls on screen, with 44 px targets, and the "replay" label clear of them.
  assert.ok(inside(m.controls, screen), `${label}: controls off screen`);
  for (const r of m.targets) {
    assert.ok(r.width >= 44 && r.height >= 44, `${label}: a ${r.width}×${r.height} target`);
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

test("the template and get-started sections", async ({ newPage }) => {
  const readme = readFileSync(path.join(REPO, "README.md"), "utf8");
  const quick = readme
    .slice(readme.indexOf("Quick start"))
    .match(/```bash\n([\s\S]*?)\n```/)[1]
    .split("\n");
  for (const [width, height] of SIZES) {
    const page = await newPage({ width, height, mobile: width < 800, deviceScaleFactor: 1 });
    await page.goto("/");
    await page.eval(() => window.__demo.film.pause());
    const got = await page.eval(() => {
      const t = document.getElementById("template");
      const g = document.getElementById("get-started");
      return {
        figures: [...t.querySelectorAll("a > img")].map((img) => ({
          src: img.getAttribute("src"),
          href: img.parentElement.getAttribute("href"),
          loaded: img.complete && img.naturalWidth > 0,
        })),
        items: t.querySelectorAll("ol > li").length,
        text: t.textContent.replace(/\s+/g, " "),
        commands: g.querySelector("pre").textContent.replace(/\n$/, "").split("\n"),
        links: [...g.querySelectorAll("a")].map((a) => a.getAttribute("href")),
        footer: document.querySelector("footer").textContent,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
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
      "page images load",
    );
    assert.equal(got.items, 6, "six things to notice");
    assert.match(got.text, /Package resume Error: Unknown role key 'windowsil'\./);
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
    assert.match(got.footer, /MIT/);
    assert.match(got.footer, /Open Font License/);
    assert.match(got.footer, /Duna Feline is fictional\./);
    assert.ok(got.scrollWidth <= width, `no horizontal scroll at ${width}×${height}`);
    await page.screenshotOf("#template", `template-${width}x${height}`);
    await page.screenshotOf("#get-started", `get-started-${width}x${height}`);
    await page.screenshotOf(".site-foot", `footer-${width}x${height}`);
    await page.close();
  }
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
    const dark = { stored: "dark", attr: "dark", bg: DESK.dark, pressed: "true", name: "Dark theme" };
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

test("analytics: debug mode fills dataLayer with config and the three demo events", async ({
  newPage,
}) => {
  const page = await newPage();
  await page.goto("/?analytics=debug");
  await page.eval(() => window.__demo.film.pause());
  await page.waitFor(() => window.dataLayer?.some((c) => c[0] === "config"));
  await page.key("ArrowRight");
  await page.eval(() => document.querySelector('.fc-seg[data-scene="3"]').click());
  await page.eval(() => {
    const { film } = window.__demo;
    while (film.scene < film.sceneCount - 1) film.next();
  });
  const count = await page.eval(() => window.__demo.film.sceneCount);
  const acts = await page.eval(() => [
    ...new Set(window.__demo.events.filter((e) => e.name === "act").map((e) => e.params.act)),
  ]);
  const commands = (await dataLayer(page)).map(([cmd, a, b]) => [cmd, a, b]);
  assert.equal(commands[0][0], "js");
  assert.equal(commands[1][0], "config");
  assert.equal(commands[1][1], "G-ZMH6NLL7C7");
  assert.deepEqual(commands[1][2], { content_group: "my-resume" });
  const events = commands.slice(2);
  assert.ok(
    events.every(([cmd]) => cmd === "event"),
    "only event commands after config",
  );
  assert.ok(!events.some(([, name]) => name === "page_view"), "no manual page_view");
  assert.deepEqual(
    events.filter(([, n]) => n === "tutorial_begin"),
    [["event", "tutorial_begin", { method: "key" }]],
  );
  const shown = events.filter(([, n]) => n === "demo_act").map(([, , p]) => p.act);
  assert.deepEqual(shown, acts, "demo_act once per act, in order");
  for (let a = 2; a <= count; a++) assert.ok(shown.includes(a), `act ${a} reached: ${shown}`);
  assert.deepEqual(
    events.filter(([, n]) => n === "tutorial_complete"),
    [["event", "tutorial_complete", { method: "manual" }]],
  );
  assert.deepEqual(
    [...new Set(events.map(([, n]) => n))].sort(),
    ["demo_act", "tutorial_begin", "tutorial_complete"],
  );
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
  const urls = await page.eval(() =>
    [...document.querySelectorAll("script[src], link[href], img[src], source[src], iframe[src]")]
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
    "style.css",
  ]) {
    const text = readFileSync(path.join(SITE, file), "utf8");
    const found = [...text.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
    for (const u of found) {
      assert.ok(
        u.startsWith("https://www.googletagmanager.com/gtag/js") || /w3\.org/.test(u),
        `${file}: unexpected absolute URL ${u}`,
      );
    }
  }
  const js = readFileSync(path.join(SITE, "analytics.js"), "utf8");
  assert.ok(js.includes("https://www.googletagmanager.com/gtag/js"));
});

await main();
