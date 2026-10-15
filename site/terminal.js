// An emulated Claude Code terminal for the demo: a scrollback log above an input box. It replays
// scripted lines; it never runs anything. Lines (each renders as one block in the log):
//
//   { t: "welcome" }                       bordered box: ✻ Welcome to Claude Code / cwd
//   { t: "prompt", text }                  "> text", typed into the input box first
//   { t: "bash", text }                    "! text" (bash mode), typed into the input box first
//   { t: "out", text, tone? }              command output; tone "ok" | "dim"
//   { t: "tool", name, arg }               "⏺ Name(arg)"
//   { t: "result", text }                  "  ⎿  text" (multi-line allowed)
//   { t: "say", text }                     "⏺ text", assistant prose
//   { t: "code", file, lines: [{ text, mark? }] }   file snippet or diff (mark "+" | "-")
//   { t: "table", head, rows }             signal → evidence table
//   { t: "ask", question, options, pick }  numbered choices; "❯" moves to `pick`
//   { t: "spin", text, ms }                "✻ text…" spinner while playing, removed after ms
//   { t: "gap" }                           blank line
//
// createTerminal(el) → { reset(), renderInstant(lines), play(lines, { signal }) → Promise }
// play() types prompts at ~35 chars/s, paces the other lines, auto-scrolls, and rejects with an
// AbortError when `signal` aborts (the caller then re-renders the state it wants).

const CHAR_MS = 1000 / 35;
const SPIN_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const SPIN_FRAME_MS = 120;
// Pause before each kind of line appears while playing.
const BEFORE = {
  welcome: 200,
  prompt: 300,
  bash: 300,
  out: 140,
  tool: 450,
  result: 260,
  say: 420,
  code: 320,
  table: 420,
  ask: 420,
  spin: 120,
  gap: 0,
};

const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createTerminal(el) {
  el.classList.add("term");
  el.replaceChildren();
  const log = h("div", "t-log");
  log.setAttribute("aria-live", "off");
  const input = h("div", "t-input");
  const sigil = h("span", "t-sigil", ">");
  const typed = h("span", "t-typed");
  const caret = h("span", "t-caret");
  caret.setAttribute("aria-hidden", "true");
  const inputBody = h("span", "t-body");
  inputBody.append(typed, caret);
  input.append(sigil, inputBody);
  el.append(log, input);

  let prev = null; // type of the last block, for output indentation

  // The log sticks to its bottom (as a terminal does) unless the reader has scrolled up; a width
  // change rewraps the lines, so it re-sticks on resize too.
  let stuck = true;
  let setTop = 0; // where scroll() put the log, so its own scroll events are not the reader's
  const scroll = () => {
    log.scrollTop = log.scrollHeight;
    setTop = log.scrollTop;
    stuck = true;
  };
  log.addEventListener("scroll", () => {
    if (Math.abs(log.scrollTop - setTop) < 1) return;
    stuck = log.scrollHeight - log.scrollTop - log.clientHeight < 4;
  });
  new ResizeObserver(() => {
    if (stuck) scroll();
  }).observe(log);

  function setInput(mode = "prompt", text = "") {
    input.classList.toggle("is-bash", mode === "bash");
    sigil.textContent = mode === "bash" ? "!" : ">";
    typed.textContent = text;
  }

  // Builds one block for a line (the ask block in its answered state unless `answered` is false).
  function block(line, { answered = true } = {}) {
    const b = h("div", `t-line t-${line.t}`);
    b.dataset.t = line.t;
    switch (line.t) {
      case "welcome": {
        const box = h("div", "t-box");
        const title = h("div", "t-box-title");
        title.append(h("span", "t-star", "✻"), " Welcome to Claude Code");
        box.append(title, h("div", "t-dim", "cwd: ~/my-resume"));
        b.append(box);
        break;
      }
      case "prompt":
      case "bash":
        b.append(
          h("span", "t-sigil", line.t === "bash" ? "!" : ">"),
          h("span", "t-body", line.text),
        );
        break;
      case "out": {
        // The first output line under a bash command hangs from "⎿", later ones align with it.
        const lead = prev === "bash" ? "  ⎿  " : prev === "out" ? "     " : "";
        if (lead) {
          b.classList.add("t-hang");
          b.append(h("span", "t-elbow", lead));
        }
        b.append(h("span", `t-body${line.tone ? ` t-${line.tone}` : ""}`, line.text));
        break;
      }
      case "tool": {
        const body = h("span", "t-body");
        body.append(h("b", "", line.name), `(${line.arg})`);
        b.append(h("span", "t-dot t-ok", "⏺"), body);
        break;
      }
      case "result":
        b.append(h("span", "t-elbow", "  ⎿  "), h("span", "t-body t-dim", line.text));
        break;
      case "say":
        b.append(h("span", "t-dot", "⏺"), h("span", "t-body", line.text));
        break;
      case "code": {
        const box = h("div", "t-code-box");
        box.append(h("div", "t-code-file", line.file));
        for (const l of line.lines) {
          const row = h("div", `t-cl${l.mark === "+" ? " t-add" : l.mark === "-" ? " t-del" : ""}`);
          row.append(h("span", "t-mark", l.mark ?? " "), h("span", "t-src", l.text));
          box.append(row);
        }
        b.append(box);
        break;
      }
      case "table": {
        const table = h("table", "t-grid");
        const head = h("tr");
        for (const cell of line.head) head.append(h("th", "", cell));
        const thead = h("thead");
        thead.append(head);
        const tbody = h("tbody");
        for (const row of line.rows) {
          const tr = h("tr");
          for (const cell of row) tr.append(h("td", "", cell));
          tbody.append(tr);
        }
        table.append(thead, tbody);
        b.append(table);
        break;
      }
      case "ask": {
        const box = h("div", "t-ask-box");
        box.append(h("div", "t-q", line.question));
        line.options.forEach((option, i) => {
          const row = h("div", "t-opt");
          row.append(h("span", "t-cursor", " "), ` ${i + 1}. ${option}`);
          box.append(row);
        });
        b.append(box);
        select(b, answered ? line.pick : 0, answered);
        break;
      }
      case "spin": {
        const body = h("span", "t-body");
        body.append(
          h("span", "t-star", `${line.text}…`),
          " ",
          h("span", "t-dim", "(esc to interrupt)"),
        );
        b.append(h("span", "t-star t-spinner", SPIN_FRAMES[0]), body);
        break;
      }
      case "gap":
        b.textContent = "\u00a0"; // keeps the empty line's height
        break;
      default:
        throw new Error(`unknown terminal line type "${line.t}"`);
    }
    prev = line.t;
    return b;
  }

  function select(b, index, answered) {
    b.querySelectorAll(".t-opt").forEach((row, i) => {
      row.classList.toggle("is-sel", i === index);
      row.classList.toggle("is-picked", answered && i === index);
      row.firstChild.textContent = i === index ? "❯" : " ";
    });
  }

  function append(b) {
    log.append(b);
    scroll();
  }

  function reset() {
    log.replaceChildren();
    prev = null;
    setInput();
  }

  function renderInstant(lines) {
    for (const line of lines) {
      if (line.t === "spin") continue;
      append(block(line));
    }
    setInput();
  }

  async function type(line, signal) {
    setInput(line.t, "");
    el.classList.add("is-typing");
    try {
      for (let i = 1; i <= line.text.length; i++) {
        await wait(CHAR_MS, signal);
        typed.textContent = line.text.slice(0, i);
      }
      await wait(260, signal);
    } finally {
      el.classList.remove("is-typing");
    }
    setInput();
    append(block(line));
  }

  async function spin(line, signal) {
    const b = block(line);
    append(b);
    const glyph = b.querySelector(".t-spinner");
    let frame = 0;
    const timer = setInterval(() => {
      frame = (frame + 1) % SPIN_FRAMES.length;
      glyph.textContent = SPIN_FRAMES[frame];
    }, SPIN_FRAME_MS);
    try {
      await wait(line.ms ?? 1200, signal);
    } finally {
      clearInterval(timer);
      b.remove();
      prev = log.lastElementChild?.dataset.t ?? null;
    }
  }

  async function ask(line, signal) {
    const b = block(line, { answered: false });
    append(b);
    for (let i = 1; i <= line.pick; i++) {
      await wait(450, signal);
      select(b, i, false);
    }
    await wait(900, signal);
    select(b, line.pick, true);
  }

  async function play(lines, { signal } = {}) {
    for (const line of lines) {
      await wait(BEFORE[line.t] ?? 200, signal);
      if (line.t === "prompt" || line.t === "bash") await type(line, signal);
      else if (line.t === "spin") await spin(line, signal);
      else if (line.t === "ask") await ask(line, signal);
      else append(block(line));
    }
  }

  reset();
  return { reset, renderInstant, play };
}
