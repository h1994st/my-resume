// The cast: Duna (the star: a gray tabby, amber eyes), Dudu (solid gray, green eyes), and Nangnang
// (brown tabby). One sitting, medium-long-haired cat drawn once as an SVG <symbol> (ruffed cheeks,
// chest ruff, ear tufts, a fluffy ringed tail) and coloured per cat by CSS variables (style.css:
// --coat, --stripe, --light, --iris, --nose; --cat-edge outlines it on the dark desk).
//
// castSymbol() → the <svg><defs><symbol id="cat">… markup (createCat adds it to the page once).
// createCat(name, { pose, idle, label }) → a <div class="cat"> with two methods:
//   cat.pose(p, { signal }) shows a pose (sit, wave, jump, tap, blink; all but sit loop while
//     held) and resolves after its first cycle (at once for sit or with reduced motion; sooner
//     with the test-only ?speed, speed.js).
//   cat.idle(on) turns idle life (breathing, tail wag, blinks) on or off.
// Poses are transforms plus overlays drawn over the symbol: a raised paw (wave), tucked paws
// (jump), tapping paws (tap), closing lids (blink). With reduced motion nothing moves: a pose holds
// its key frame and idle life stays off (style.css).

import { SPEED } from "./speed.js";

export const CATS = {
  duna: { label: "Duna" },
  dudu: { label: "Dudu" },
  nangnang: { label: "Nangnang" },
};
export const POSES = ["sit", "wave", "jump", "tap", "blink"];

// One cycle of each looping pose (keep in step with the cat-pose-* keyframes in style.css).
const CYCLE = { sit: 0, wave: 1200, jump: 1000, tap: 700, blink: 3000 };
// Idle animations start at different points so the cast doesn't blink in unison.
const DELAY = { duna: "0s", dudu: "-1.7s", nangnang: "-3.1s" };

const TAIL =
  "M90 157 C 110 161, 128 155, 135 138 l 4 -1 l -3 -3 C 139 122, 138 108, 131 98 l 3 -3 l -5 0" +
  " C 124 88, 116 84, 110 86 C 103 88, 102 96, 108 100 C 116 106, 121 116, 120 127" +
  " C 119 137, 110 143, 92 144 Z";

const SYMBOL = `<svg class="cast-defs" width="0" height="0" aria-hidden="true" focusable="false">
  <defs>
    <clipPath id="cat-tail-clip"><path d="${TAIL}"/></clipPath>
    <symbol id="cat" viewBox="0 0 140 190">
      <g class="cat-tail">
        <path class="cat-o" d="${TAIL}" fill="var(--coat)"/>
        <g clip-path="url(#cat-tail-clip)" stroke="var(--stripe)" stroke-width="5" fill="none">
          <path d="M120 133 L 142 150 M123 115 L 145 113 M116 101 L 134 84"/>
        </g>
      </g>
      <g class="cat-breath">
        <path class="cat-o" fill="var(--coat)" d="M30 182 C 26 170, 24 160, 26 150 l -4 -3 l 5 -2
          C 28 130, 36 114, 50 104 L 90 104 C 104 114, 112 130, 113 145 l 5 2 l -4 3
          C 116 160, 114 170, 110 182 Q 104 186 98 182 Q 92 187 86 182 Q 76 187 70 182
          Q 62 187 54 182 Q 46 187 42 182 Q 36 186 30 182 Z"/>
        <path class="cat-o" fill="var(--light)" d="M46 96 Q 42 112 44 122 Q 48 128 52 122
          Q 54 138 62 130 Q 66 146 70 134 Q 74 146 78 130 Q 86 138 88 122 Q 92 128 96 122
          Q 98 112 94 96 Z"/>
        <path d="M38 142 q 8 -4 14 2 M36 158 q 10 -4 16 2 M102 142 q -8 -4 -14 2
          M104 158 q -10 -4 -16 2" stroke="var(--stripe)" stroke-width="3.2" fill="none"
          stroke-linecap="round"/>
      </g>
      <g class="cat-o">
        <path d="M34 50 L 36 12 L 62 34 Z" fill="var(--coat)"/>
        <path d="M106 50 L 104 12 L 78 34 Z" fill="var(--coat)"/>
      </g>
      <path d="M40 40 L 41 22 L 54 33 Z M100 40 L 99 22 L 86 33 Z" fill="var(--nose)" opacity=".5"/>
      <path d="M42 39 q 2 -7 7 -10 M45 41 q 4 -5 10 -6 M98 39 q -2 -7 -7 -10 M95 41 q -4 -5 -10 -6"
        stroke="var(--light)" stroke-width="1.4" fill="none" stroke-linecap="round"/>
      <path d="M37 14 l -3 -7 M37 14 l 2 -8 M103 14 l 3 -7 M103 14 l -2 -8" stroke="var(--coat)"
        stroke-width="2" fill="none" stroke-linecap="round"/>
      <path class="cat-o" fill="var(--coat)" d="M70 26 C 96 26, 110 44, 110 64 L 118 70 L 109 74
        L 116 82 L 104 84 C 96 98, 84 104, 70 104 C 56 104, 44 98, 36 84 L 24 82 L 31 74
        L 22 70 L 30 64 C 30 44, 44 26, 70 26 Z"/>
      <g stroke="var(--stripe)" stroke-width="3.2" fill="none" stroke-linecap="round">
        <path d="M58 36 l 4 10 l 8 -8 l 8 8 l 4 -10"/>
        <path d="M33 66 q 8 2 12 0 M31 74 q 9 2 14 -1 M107 66 q -8 2 -12 0 M109 74 q -9 2 -14 -1"/>
      </g>
      <ellipse cx="70" cy="80" rx="17" ry="12" fill="var(--light)"/>
      <g class="cat-eye">
        <ellipse cx="56" cy="64" rx="7" ry="7.5" fill="var(--iris)"/>
        <ellipse cx="56" cy="64" rx="2.6" ry="6" fill="#1d1a18"/>
        <circle cx="58" cy="61" r="1.6" fill="#fff"/>
      </g>
      <g class="cat-eye">
        <ellipse cx="84" cy="64" rx="7" ry="7.5" fill="var(--iris)"/>
        <ellipse cx="84" cy="64" rx="2.6" ry="6" fill="#1d1a18"/>
        <circle cx="86" cy="61" r="1.6" fill="#fff"/>
      </g>
      <path d="M66 76 h8 l-4 4.5 z" fill="var(--nose)"/>
      <path d="M70 80.5 q -4 5 -8 2.5 M70 80.5 q 4 5 8 2.5" stroke="#1d1a18" stroke-width="1.5"
        fill="none" stroke-linecap="round"/>
      <path d="M52 78 h-20 M52 83 l-19 4 M88 78 h20 M88 83 l19 4" stroke="#1d1a18"
        stroke-width="1" opacity=".45"/>
      <g class="cat-paw-l">
        <ellipse class="cat-o" cx="56" cy="183" rx="10" ry="6" fill="var(--light)"/>
        <path d="M53 179 v4 M59 179 v4" stroke="#1d1a18" stroke-width="1" opacity=".3"/>
      </g>
      <g class="cat-paw-r">
        <ellipse class="cat-o" cx="84" cy="183" rx="10" ry="6" fill="var(--light)"/>
        <path d="M81 179 v4 M87 179 v4" stroke="#1d1a18" stroke-width="1" opacity=".3"/>
      </g>
    </symbol>
  </defs>
</svg>`;

// Drawn over the symbol, in the same coordinates; style.css shows the one for the pose.
const OVERLAYS = `
  <g class="cat-wave">
    <path class="cat-wave-edge" d="M88 134 C 95 122, 103 111, 110 101"/>
    <path d="M88 134 C 95 122, 103 111, 110 101" stroke="var(--coat)" stroke-width="14"
      stroke-linecap="round" fill="none"/>
    <path d="M93 121 l 7 4 M99 112 l 7 4" stroke="var(--stripe)" stroke-width="3"
      stroke-linecap="round"/>
    <ellipse class="cat-o" cx="112" cy="96" rx="9" ry="9.5" fill="var(--light)"/>
    <ellipse cx="112" cy="98.5" rx="3.6" ry="3" fill="var(--nose)" opacity=".75"/>
    <path d="M107 91 a1.6 1.6 0 1 0 0.1 0 M112 89.5 a1.6 1.6 0 1 0 0.1 0
      M117 91 a1.6 1.6 0 1 0 0.1 0" fill="var(--nose)" opacity=".75"/>
  </g>
  <g class="cat-tuck">
    <ellipse class="cat-o" cx="58" cy="171" rx="9" ry="5.5" fill="var(--light)"/>
    <ellipse class="cat-o" cx="82" cy="171" rx="9" ry="5.5" fill="var(--light)"/>
  </g>
  <g class="cat-tap">
    <g class="cat-tap-l">
      <ellipse class="cat-o" cx="56" cy="183" rx="10" ry="6" fill="var(--light)"/>
      <path d="M53 179 v4 M59 179 v4" stroke="#1d1a18" stroke-width="1" opacity=".3"/>
    </g>
    <g class="cat-tap-r">
      <ellipse class="cat-o" cx="84" cy="183" rx="10" ry="6" fill="var(--light)"/>
      <path d="M81 179 v4 M87 179 v4" stroke="#1d1a18" stroke-width="1" opacity=".3"/>
    </g>
  </g>
  <g class="cat-lids">
    <ellipse class="cat-lid" cx="56" cy="64" rx="8" ry="8.4" fill="var(--coat)"/>
    <ellipse class="cat-lid" cx="84" cy="64" rx="8" ry="8.4" fill="var(--coat)"/>
    <path class="cat-lash" d="M49 65 q 7 5 14 0 M77 65 q 7 5 14 0" stroke="#1d1a18"
      stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </g>`;

export function castSymbol() {
  return SYMBOL;
}

function ensureSymbol() {
  if (!document.getElementById("cat")) document.body.insertAdjacentHTML("afterbegin", SYMBOL);
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

export function createCat(name, { pose = "sit", idle = true, label } = {}) {
  if (!Object.hasOwn(CATS, name)) throw new Error(`unknown cat: ${name}`);
  if (!POSES.includes(pose)) throw new Error(`unknown pose: ${pose}`);
  ensureSymbol();
  const cat = document.createElement("div");
  cat.className = "cat";
  cat.dataset.cat = name;
  cat.style.setProperty("--cat-delay", DELAY[name]);
  const alt = label ?? CATS[name].label; // "" makes the cat decorative
  if (alt) {
    cat.setAttribute("role", "img");
    cat.setAttribute("aria-label", alt);
  } else {
    cat.setAttribute("aria-hidden", "true");
  }
  cat.innerHTML = `<svg class="cat-svg" viewBox="0 0 140 190" aria-hidden="true" focusable="false">
    <ellipse class="cat-ground" cx="70" cy="186" rx="48" ry="4.5"/>
    <g class="cat-figure"><use href="#cat"/>${OVERLAYS}</g>
  </svg>`;

  cat.pose = (p, { signal } = {}) => {
    if (!POSES.includes(p)) throw new Error(`unknown pose: ${p}`);
    cat.dataset.pose = p;
    const ms = reducedMotion.matches ? 0 : CYCLE[p] / SPEED;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      if (!ms) return resolve();
      const done = () => {
        signal?.removeEventListener("abort", stop);
        resolve();
      };
      const timer = setTimeout(done, ms);
      const stop = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal?.addEventListener("abort", stop, { once: true });
    });
  };
  cat.idle = (on = true) => {
    cat.classList.toggle("is-idle", Boolean(on));
    return cat;
  };

  cat.dataset.pose = pose;
  cat.idle(idle);
  return cat;
}
