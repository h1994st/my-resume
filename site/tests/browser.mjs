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
  ...Object.fromEntries(
    "12345".split("").map((d) => [d, { key: d, code: `Digit${d}`, keyCode: 48 + +d, text: d }]),
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

// The terminal's rendered blocks (text), and what the terminal renders instantly for the end state
// of step i (built in a detached terminal from acts.js), for comparison.
const termState = (page) =>
  page.eval(() => {
    const blocks = [...document.querySelectorAll("#term .t-log > .t-line")];
    return blocks.map((b) => b.textContent);
  });
const expectedTerm = (page, stepIndex) =>
  page.eval(async (i) => {
    const { ACTS } = await import("./acts.js");
    const { createTerminal } = await import("./terminal.js");
    const steps = ACTS.flatMap((a) => a.steps);
    const el = document.createElement("div");
    const t = createTerminal(el);
    t.renderInstant(steps.slice(0, i + 1).flatMap((s) => s.lines));
    return [...el.querySelectorAll(".t-log > .t-line")].map((b) => b.textContent);
  }, stepIndex);
const firstStepOfAct = (page, act) =>
  page.eval(async (n) => {
    const { ACTS } = await import("./acts.js");
    return ACTS.slice(0, n - 1).reduce((sum, a) => sum + a.steps.length, 0);
  }, act);

// --- Tests: the player -----------------------------------------------------------------------

test("jumping between acts mid-playback renders the target step's end state", async ({
  newPage,
}) => {
  const page = await newPage();
  await page.goto("/");
  await page.eval(() => window.__demo.player.play());
  await sleep(700); // mid-animation of the first step
  await page.eval(() => {
    window.__demo.player.goToAct(5);
    window.__demo.player.goToAct(2);
  });
  const target = await firstStepOfAct(page, 2);
  const check = async () => {
    const [got, want] = [await termState(page), await expectedTerm(page, target)];
    assert.equal(got.at(-1), want.at(-1), "terminal's last line");
    assert.deepEqual(got, want, "terminal content");
    assert.equal(await page.eval(() => window.__demo.resume.pageCount()), 2, "replica pages");
    assert.equal(await page.eval(() => window.__demo.player.step), target, "player step");
  };
  await check();
  await sleep(2500); // the aborted step must not write anything later
  await check();
  assert.equal(await page.eval(() => window.__demo.player.playing), false, "jumping pauses");
});

test("stepping through every step reaches the end state of each act", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/");
  const trace = await page.eval(async () => {
    const { ACTS } = await import("./acts.js");
    const { player, resume } = window.__demo;
    player.goTo(0);
    const total = ACTS.reduce((n, a) => n + a.steps.length, 0);
    const out = [];
    for (let i = 1; i < total; i++) {
      player.next();
      out.push({
        step: player.step,
        act: player.act,
        pages: resume.pageCount(),
        granary: Boolean(document.querySelector('.resume [data-id="granary"]')),
        current: document.querySelector('.ctl-act[aria-current="step"]')?.dataset.act,
      });
    }
    player.next(); // past the end: stays on the last step
    return { out, total, last: player.step };
  });
  assert.equal(trace.out.length, trace.total - 1);
  trace.out.forEach((s, k) => {
    assert.equal(s.step, k + 1, "next() advances one step");
    assert.equal(s.current, String(s.act), "the current act chip is marked");
  });
  assert.equal(trace.last, trace.total - 1, "next() at the end stays on the last step");
  const lastOf = (act) => trace.out.findLast((s) => s.act === act);
  assert.equal(lastOf(2).pages, 1, "after act 2 the variant fits one page");
  for (const s of trace.out.filter((s) => s.act === 3)) assert.equal(s.pages, 1, "act 3: 1 page");
  assert.ok(lastOf(5).granary, "after act 5 the granary role is on the page");
  assert.ok(!lastOf(4).granary, "the granary role appears only in act 5");
});

test("space while the stage is out of view scrolls the page and leaves playback alone", async ({
  newPage,
}) => {
  const page = await newPage();
  await page.goto("/");
  await page.eval(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "4000px";
    document.body.append(spacer);
    window.__demo.player.pause();
    const stage = document.getElementById("stage");
    scrollTo(0, stage.offsetTop + stage.offsetHeight + 200);
  });
  await page.frames(3);
  await sleep(150);
  const before = await page.eval(() => ({ y: scrollY, playing: window.__demo.player.playing }));
  await page.key(" ");
  await page.frames(3);
  await sleep(300);
  const after = await page.eval(() => ({ y: scrollY, playing: window.__demo.player.playing }));
  assert.equal(after.playing, before.playing, "playback did not toggle");
  assert.ok(after.y > before.y, `the page scrolled (${before.y} → ${after.y})`);

  // Control: back in view, space toggles playback and the page stays put.
  await page.eval(() => scrollTo(0, 0));
  await page.frames(3);
  await sleep(150);
  await page.key(" ");
  await page.frames(2);
  const inView = await page.eval(() => ({ y: scrollY, playing: window.__demo.player.playing }));
  assert.equal(inView.playing, true, "space in view toggles playback");
  assert.equal(inView.y, 0, "space in view does not scroll");
  await page.key("ArrowRight");
  await page.key("3");
  const third = await firstStepOfAct(page, 3);
  assert.equal(await page.eval(() => window.__demo.player.step), third, "digit keys jump to acts");
});

test("controls, swipe, and events", async ({ newPage }) => {
  const page = await newPage({ width: 390, height: 844, mobile: true, deviceScaleFactor: 2 });
  await page.goto("/");
  await page.eval(() => {
    window.__demo.player.pause();
    window.__demo.events.length = 0;
  });
  // A chip click jumps to its act; prev/next buttons step.
  await page.eval(() => document.querySelector('.ctl-act[data-act="4"]').click());
  const four = await firstStepOfAct(page, 4);
  assert.equal(await page.eval(() => window.__demo.player.step), four);
  await page.eval(() => document.querySelector('[data-ctl="next"]').click());
  await page.eval(() => document.querySelector('[data-ctl="prev"]').click());
  assert.equal(await page.eval(() => window.__demo.player.step), four);
  // A left swipe on the stage steps forward, a right swipe steps back.
  const box = await page.eval(() => {
    const r = document.getElementById("stage").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 200) };
  });
  await page.swipe(box.x + 80, box.y, box.x - 80, box.y);
  assert.equal(await page.eval(() => window.__demo.player.step), four + 1, "left swipe: next");
  await page.swipe(box.x - 80, box.y, box.x + 80, box.y);
  assert.equal(await page.eval(() => window.__demo.player.step), four, "right swipe: prev");
  // On a phone the chips show only their numbers; their names stay in the accessible name.
  assert.deepEqual(
    await page.eval(() =>
      [...document.querySelectorAll(".ctl-act")].map((c) => c.getAttribute("aria-label")),
    ),
    ["Act 1: Facts", "Act 2: Tailor", "Act 3: Check", "Act 4: Submit", "Act 5: Update"],
  );
  // Play button toggles.
  await page.eval(() => document.querySelector('[data-ctl="play"]').click());
  assert.equal(await page.eval(() => window.__demo.player.playing), true);
  await page.eval(() => document.querySelector('[data-ctl="play"]').click());
  assert.equal(await page.eval(() => window.__demo.player.playing), false);
  // Jump to the last act and step to the end.
  await page.eval(() => {
    window.__demo.player.goToAct(5);
    while (window.__demo.player.step < window.__demo.player.stepCount - 1)
      window.__demo.player.next();
  });
  const events = await page.eval(() => window.__demo.events);
  const names = events.map((e) => e.name);
  assert.deepEqual(
    events.filter((e) => e.name === "interact").map((e) => e.params.method),
    ["act_chip", "step", "step", "swipe", "swipe", "play", "play"],
  );
  assert.deepEqual(
    events.filter((e) => e.name === "act").map((e) => e.params),
    [
      { act: 4, act_name: "submit" },
      { act: 5, act_name: "update" },
    ],
  );
  assert.deepEqual(events.at(-1), { name: "complete", params: { method: "manual" } });
  assert.equal(names.filter((n) => n === "complete").length, 1);
  assert.equal(
    await page.eval(() => getComputedStyle(document.querySelector(".demo-tag")).display !== "none"),
    true,
    "act 5 shows the demo-step tag",
  );
  assert.ok(
    await page.eval(() => document.documentElement.scrollWidth <= innerWidth),
    "no horizontal scroll",
  );
});

test("autoplay starts on its own and plays through the first steps", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/");
  await page.waitFor(() => window.__demo.player.playing);
  await page.waitFor(() => window.__demo.player.step >= 1, { timeout: 20_000 });
  const events = await page.eval(() => window.__demo.events);
  assert.deepEqual(events[0], { name: "act", params: { act: 1, act_name: "facts" } });
  assert.ok(!events.some((e) => e.name === "interact"), "autoplay is not an interaction");
});

test("reduced motion: no autoplay, steps render instantly", async ({ newPage }) => {
  const page = await newPage({ media: REDUCED });
  await page.goto("/");
  await sleep(3000);
  assert.equal(await page.eval(() => window.__demo.player.step), 0, "no autoplay");
  assert.equal(await page.eval(() => window.__demo.player.playing), false);
  const got = await page.eval(() => {
    window.__demo.player.next();
    return {
      animations: document.getAnimations().length,
      ghosts: document.querySelectorAll(".r-ghost").length,
      blocks: [...document.querySelectorAll("#term .t-log > .t-line")].map((b) => b.textContent),
    };
  });
  assert.equal(got.animations, 0, "no animations");
  assert.equal(got.ghosts, 0, "no ghosts");
  assert.deepEqual(got.blocks, await expectedTerm(page, 1), "end state rendered at once");
  // Pressing play shows each step's end state at once (no typing), then holds and advances.
  await page.eval(() => window.__demo.player.play());
  await sleep(150);
  assert.deepEqual(await termState(page), await expectedTerm(page, 1), "play: no typing");
  await page.waitFor(() => window.__demo.player.step >= 2, { timeout: 10_000 });
  await sleep(150);
  assert.deepEqual(await termState(page), await expectedTerm(page, 2), "next step at once");
  assert.equal(await page.eval(() => document.getAnimations().length), 0);
});

test("the terminal stays scrolled to its last line after every jump", async ({ newPage }) => {
  const page = await newPage();
  await page.goto("/");
  await page.eval(() => window.__demo.player.pause());
  const count = await page.eval(() => window.__demo.player.stepCount);
  for (const order of [[...Array(count).keys()], [...Array(count).keys()].reverse()]) {
    for (const i of order) {
      await page.eval((n) => window.__demo.player.goTo(n), i);
      await page.frames(3);
      const gap = await page.eval(() => {
        const log = document.querySelector("#term .t-log");
        return Math.round(log.scrollHeight - log.scrollTop - log.clientHeight);
      });
      assert.ok(gap <= 1, `step ${i}: ${gap}px below the visible part of the log`);
    }
  }
});

// --- Tests: layout and sections --------------------------------------------------------------

const SIZES = [
  [390, 844],
  [844, 390], // a phone in landscape
  [1280, 720],
  [1920, 1080],
  [2560, 1440],
];

// Goes to the end state of act n (paused).
const endOfAct = (page, n) =>
  page.eval(async (act) => {
    const { ACTS } = await import("./acts.js");
    const end = ACTS.slice(0, act).reduce((sum, a) => sum + a.steps.length, 0) - 1;
    window.__demo.player.pause();
    window.__demo.player.goTo(end);
  }, n);

// Geometry of the stage at the top of the page.
const layout = (page) =>
  page.eval(() => {
    scrollTo(0, 0);
    const rect = (sel) => document.querySelector(sel).getBoundingClientRect().toJSON();
    const term = document.querySelector("#term");
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(20);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    term.append(probe);
    const ch = probe.getBoundingClientRect().width / 20;
    probe.remove();
    const col = document.getElementById("page-col");
    const cs = getComputedStyle(col);
    const box = document.getElementById("page-box");
    const shown = [...document.querySelectorAll(".resume .r-sheet:not(.r-ghost)")].map((s) =>
      s.getBoundingClientRect().toJSON(),
    );
    return {
      vw: innerWidth,
      vh: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      stacked: matchMedia(
        "(max-width: 799px) and (orientation: portrait), (max-width: 799px) and (min-height: 501px)",
      ).matches,
      short: matchMedia("(max-height: 500px) and (orientation: landscape)").matches,
      pages: window.__demo.resume.pageCount(),
      scale: parseFloat(getComputedStyle(box).getPropertyValue("--s")),
      stage: rect("#stage"),
      col: rect("#page-col"),
      colInner: {
        left: col.getBoundingClientRect().left + parseFloat(cs.paddingLeft),
        right: col.getBoundingClientRect().right - parseFloat(cs.paddingRight),
        top: col.getBoundingClientRect().top + parseFloat(cs.paddingTop),
        bottom: col.getBoundingClientRect().bottom - parseFloat(cs.paddingBottom),
      },
      box: rect("#page-box"),
      caption: (() => {
        const which = document.getElementById("stage").dataset.proof;
        return which
          ? document
              .querySelector(`.proof[data-proof="${which}"] figcaption`)
              .getBoundingClientRect()
              .toJSON()
          : null;
      })(),
      tag: (() => {
        const el = document.querySelector(".demo-tag");
        return getComputedStyle(el).display !== "none" ? el.getBoundingClientRect().toJSON() : null;
      })(),
      sheets: shown,
      term: rect("#term"),
      termCols: term.clientWidth / ch,
      ctl: rect(".ctl"),
      ctlLabel: (() => {
        const el = document.querySelector(".ctl-label");
        return getComputedStyle(el).display !== "none" ? el.getBoundingClientRect().toJSON() : null;
      })(),
      ctlItems: [...document.querySelectorAll(".ctl-btn, .ctl-act")].map((el) =>
        el.getBoundingClientRect().toJSON(),
      ),
      indicator: (() => {
        const el = document.querySelector(".page-switch");
        return el && getComputedStyle(el).display !== "none"
          ? el.getBoundingClientRect().toJSON()
          : null;
      })(),
    };
  });

function checkLayout(m, label) {
  const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
  assert.ok(m.scrollWidth <= m.vw, `${label}: horizontal scroll (${m.scrollWidth} > ${m.vw})`);
  // The page box (what is shown of the spread) sits inside its column.
  assert.ok(
    m.box.left >= m.colInner.left - 1 && m.box.right <= m.colInner.right + 1,
    `${label}: page box ${m.box.left}–${m.box.right} outside column ${m.colInner.left}–${m.colInner.right}`,
  );
  if (!m.short) {
    assert.ok(m.box.bottom <= m.colInner.bottom + 1, `${label}: page box overflows its column`);
  }
  // Controls are within the viewport.
  assert.ok(m.ctl.top >= 0 && m.ctl.bottom <= m.vh + 0.5, `${label}: controls off screen`);
  assert.ok(m.ctl.left >= 0 && m.ctl.right <= m.vw + 0.5, `${label}: controls too wide`);
  // The "replay" label is on screen at every size, clear of the terminal and the controls.
  assert.ok(m.ctlLabel && m.ctlLabel.width > 0, `${label}: no "replay" label`);
  assert.ok(
    m.ctlLabel.top >= m.term.bottom - 0.5 && m.ctlLabel.bottom <= m.vh + 0.5,
    `${label}: "replay" label off screen or over the terminal`,
  );
  assert.ok(
    m.ctlLabel.left >= 0 && m.ctlLabel.right <= m.vw + 0.5,
    `${label}: "replay" label off screen`,
  );
  for (const r of m.ctlItems) {
    const apart =
      r.right <= m.ctlLabel.left ||
      r.left >= m.ctlLabel.right ||
      r.bottom <= m.ctlLabel.top ||
      r.top >= m.ctlLabel.bottom;
    assert.ok(apart, `${label}: "replay" label overlaps a control`);
  }
  // Act 3's "the real PDF" caption is in the visible part of the page column.
  if (m.caption) {
    assert.ok(
      m.caption.top >= m.col.top - 0.5 &&
        m.caption.bottom <= Math.min(m.col.bottom, m.vh) + 0.5 &&
        m.caption.left >= m.col.left - 0.5 &&
        m.caption.right <= m.col.right + 0.5,
      `${label}: the real-PDF caption is out of sight`,
    );
  }
  // Act 5's demo tag sits above the page, inside the column, never over resume content.
  if (m.tag) {
    assert.ok(m.tag.top >= m.col.top - 0.5, `${label}: demo tag above its column`);
    for (const s of m.sheets) {
      if (s.right <= m.tag.left || s.left >= m.tag.right) continue;
      assert.ok(m.tag.bottom <= s.top + 0.5, `${label}: demo tag covers the page`);
    }
  }
  if (m.short) {
    // A short landscape window (a phone on its side): terminal | one page at a time, at the
    // column's width (no smaller than on a phone held upright), scrolling inside its column;
    // the stage and its controls fit the window.
    assert.ok(near(m.stage.bottom, m.vh), `${label}: stage ends at ${m.stage.bottom}, not ${m.vh}`);
    assert.ok(m.scale >= 0.43, `${label}: page scale ${m.scale.toFixed(3)}`);
    assert.ok(
      near(m.box.width, Math.min(m.colInner.right - m.colInner.left, 816), 2),
      `${label}: page ${m.box.width}px wide in a ${m.colInner.right - m.colInner.left}px column`,
    );
    const inBox = m.sheets.filter((s) => s.left >= m.box.left - 1 && s.right <= m.box.right + 1);
    assert.equal(inBox.length, 1, `${label}: one page shown`);
    assert.equal(Boolean(m.indicator), m.pages > 1, `${label}: page switch shown iff 2 pages`);
    if (m.indicator) {
      assert.ok(
        m.indicator.top >= m.col.top && m.indicator.bottom <= m.col.bottom + 1,
        `${label}: page switch outside the visible column`,
      );
    }
    assert.ok(m.term.right <= m.col.left, `${label}: terminal overlaps the page column`);
    assert.ok(m.term.bottom <= m.ctl.top + 1, `${label}: terminal hidden under the controls`);
    assert.ok(m.term.height >= 200, `${label}: terminal only ${m.term.height}px tall`);
  } else if (m.stacked) {
    // One page at a time, at the viewport's width less a 16px gutter on each side.
    assert.ok(near(m.box.width, m.vw - 32, 2), `${label}: page ${m.box.width}px wide on a phone`);
    const inBox = m.sheets.filter((s) => s.left >= m.box.left - 1 && s.right <= m.box.right + 1);
    assert.equal(inBox.length, 1, `${label}: one page shown`);
    assert.equal(Boolean(m.indicator), m.pages > 1, `${label}: page switch shown iff 2 pages`);
    // The whole demo fits one screen: the terminal ends above the fixed controls.
    assert.ok(
      m.term.bottom <= m.ctl.top + 1,
      `${label}: terminal hidden under the controls (${m.term.bottom} > ${m.ctl.top}; ${JSON.stringify({ col: m.col, term: m.term, ctl: m.ctl })})`,
    );
    assert.ok(m.term.height >= 200, `${label}: terminal only ${m.term.height}px tall`);
  } else {
    // Every page of the spread is visible inside the column.
    for (const s of m.sheets) {
      assert.ok(
        s.left >= m.colInner.left - 1 && s.right <= m.colInner.right + 1,
        `${label}: a page sticks out of its column`,
      );
    }
    // The stage fills the window below the title line.
    assert.ok(near(m.stage.bottom, m.vh), `${label}: stage ends at ${m.stage.bottom}, not ${m.vh}`);
    // Both halves read well: a terminal of at least 56 columns, a page at least 0.4 scale, and a
    // single page as tall as its column.
    assert.ok(m.termCols >= 56, `${label}: terminal only ${m.termCols.toFixed(1)} columns`);
    assert.ok(m.scale >= 0.4, `${label}: page scale ${m.scale.toFixed(3)}`);
    if (m.pages === 1) {
      assert.ok(
        near(m.box.height, m.colInner.bottom - m.colInner.top, 2),
        `${label}: one page ${m.box.height}px tall in a ${m.colInner.bottom - m.colInner.top}px column`,
      );
    }
  }
}

test("layout: every act end at every size, with screenshots", async ({ newPage }) => {
  const problems = [];
  for (const [width, height] of SIZES) {
    const page = await newPage({
      width,
      height,
      mobile: width < 800 || height < 500,
      deviceScaleFactor: 1,
    });
    await page.goto("/");
    for (let act = 1; act <= 5; act++) {
      await endOfAct(page, act);
      await page.frames(2);
      await sleep(400); // highlight transitions
      await page.screenshot(`act-${act}-${width}x${height}`);
      try {
        checkLayout(await layout(page), `act ${act} at ${width}×${height}`);
      } catch (err) {
        problems.push(err.message.split("\n")[0]);
      }
    }
    await page.close();
  }
  assert.deepEqual(problems, []);
});

test("phone: one page at a time, with a page switch", async ({ newPage }) => {
  const page = await newPage({ width: 390, height: 844, mobile: true, deviceScaleFactor: 2 });
  await page.goto("/");
  await endOfAct(page, 1);
  await page.frames(2);
  const second = () =>
    page.eval(() => {
      const box = document.getElementById("page-box").getBoundingClientRect();
      const sheet = document.querySelectorAll(".resume .r-sheet")[1].getBoundingClientRect();
      return Math.abs(sheet.left - box.left) < 2;
    });
  assert.equal(await second(), false, "page 1 shown first");
  await page.eval(() => document.querySelector('.page-switch [data-page="2"]').click());
  await sleep(500);
  assert.equal(await second(), true, "page 2 shown after the switch");
  assert.equal(
    await page.eval(() =>
      document.querySelector('.page-switch [data-page="2"]').getAttribute("aria-pressed"),
    ),
    "true",
  );
  // Back to one page: no switch; to two pages again: page 1 first.
  await endOfAct(page, 2);
  await page.frames(2);
  assert.equal(
    await page.eval(() => getComputedStyle(document.querySelector(".page-switch")).display),
    "none",
  );
  await endOfAct(page, 5);
  await page.frames(2);
  await sleep(500);
  assert.equal(await second(), false, "a new two-page state starts on page 1");
  assert.equal(
    await page.eval(() => window.__demo.player.step),
    await page.eval(() => window.__demo.player.stepCount - 1),
  );
  checkLayout(await layout(page), "phone, act 5");
});

test("two pages to one zooms the page in (and jumps under reduced motion)", async ({ newPage }) => {
  for (const media of [undefined, REDUCED]) {
    const page = await newPage({ width: 1280, height: 720, media });
    await page.goto("/");
    await endOfAct(page, 1);
    await page.frames(2);
    const samples = await page.eval(
      () =>
        new Promise((resolve) => {
          const box = document.getElementById("page-box");
          const out = [box.getBoundingClientRect().height];
          window.__demo.resume.render("granary", { animate: true });
          const t0 = performance.now();
          const tick = () => {
            out.push(box.getBoundingClientRect().height);
            if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
            else resolve(out);
          };
          requestAnimationFrame(tick);
        }),
    );
    const [from, to] = [samples[0], samples.at(-1)];
    assert.ok(to > from + 20, `one page is bigger than two (${from} → ${to})`);
    const between = samples.filter((h) => h > from + 5 && h < to - 5).length;
    if (media) assert.equal(between, 0, "reduced motion: no zoom frames");
    else assert.ok(between >= 5, `zoom is animated (${between} frames in between)`);
    await page.close();
  }
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
    await page.eval(() => window.__demo.player.pause());
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

// --- Tests: player gates ---------------------------------------------------------------------

test("autoplay starts when a stage taller than two viewports fills the screen", async ({
  newPage,
}) => {
  // A narrow landscape window just too tall for the short layout: the stacked stage is far taller
  // than the viewport.
  const page = await newPage({ width: 790, height: 520, mobile: true, deviceScaleFactor: 2 });
  await page.goto("/");
  const ratio = await page.eval(() => {
    const r = document.getElementById("stage").getBoundingClientRect();
    return r.height / innerHeight;
  });
  assert.ok(ratio > 2, `the stage is ${ratio.toFixed(2)}× the viewport (test premise)`);
  await page.waitFor(() => window.__demo.player.playing, { timeout: 5000 });
});

test("a swipe on the control bar does not step the demo", async ({ newPage }) => {
  const page = await newPage({ width: 390, height: 844, mobile: true, deviceScaleFactor: 2 });
  await page.goto("/");
  await page.eval(() => window.__demo.player.goToAct(2));
  const before = await page.eval(() => window.__demo.player.step);
  const row = await page.eval(() => {
    const r = document.querySelector(".ctl-acts").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.swipe(row.x + 80, row.y, row.x - 80, row.y);
  assert.equal(await page.eval(() => window.__demo.player.step), before, "chip row swipe left");
  await page.swipe(row.x - 80, row.y, row.x + 80, row.y);
  assert.equal(await page.eval(() => window.__demo.player.step), before, "chip row swipe right");
  const bar = await page.eval(() => {
    const r = document.querySelector(".ctl-buttons").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.swipe(bar.x + 60, bar.y, bar.x - 60, bar.y);
  assert.equal(await page.eval(() => window.__demo.player.step), before, "button row swipe");
  // Control: a swipe on the terminal still steps.
  const term = await page.eval(() => {
    const r = document.getElementById("term").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 100) };
  });
  await page.swipe(term.x + 80, term.y, term.x - 80, term.y);
  assert.equal(await page.eval(() => window.__demo.player.step), before + 1, "terminal swipe");
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
    await page.eval(() => window.__demo.player.pause());
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
  await page.eval(() => window.__demo.player.pause());
  await page.waitFor(() => window.dataLayer?.some((c) => c[0] === "config"));
  await page.key("ArrowRight");
  await page.eval(() => document.querySelector('.ctl-act[data-act="3"]').click());
  await page.eval(() => {
    const { player } = window.__demo;
    while (player.step < player.stepCount - 1) player.next();
  });
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
  assert.ok([1, 3, 4, 5].every((a) => shown.includes(a)), `acts reached: ${shown}`);
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
  await page.eval(() => window.__demo.player.next());
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
  await page.eval(() => window.__demo.player.pause());
  await page.waitFor(() => window.dataLayer?.some((c) => c[0] === "config"));
  await page.eval(() => {
    window.gtag = () => {
      throw new Error("gtag broke");
    };
  });
  await page.eval(() => {
    const { player } = window.__demo;
    while (player.step < player.stepCount - 1) player.next();
  });
  assert.equal(
    await page.eval(() => window.__demo.player.step === window.__demo.player.stepCount - 1),
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
    "player.js",
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
