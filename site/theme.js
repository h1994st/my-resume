// Light and dark themes. The page follows prefers-color-scheme until the user picks a theme with
// the header toggle; the choice is kept in localStorage["theme"] and set as
// <html data-theme="light|dark"> (style.css redefines its tokens for it). With nothing stored,
// data-theme stays unset and the system setting wins. The inline script in index.html's <head>
// applies a stored choice before the first paint, and the one after the toggle sets its
// aria-pressed; this module wires the toggle.
//
// initTheme({ onChange }) → { theme() } wires #theme-toggle: a button named "Dark theme" whose
// aria-pressed is true while the dark theme shows (the name stays the same; the state is in
// aria-pressed). onChange(theme) runs when the user switches, not when the system setting changes.

const KEY = "theme";
const systemDark = matchMedia("(prefers-color-scheme: dark)");

// localStorage can be missing or throw (private windows, blocked storage).
function stored() {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function store(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // The choice then lasts for this page only.
  }
}

// The theme on screen: the user's choice, else the system's.
export function currentTheme() {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "light" || chosen === "dark") return chosen;
  return systemDark.matches ? "dark" : "light";
}

export function initTheme({ onChange } = {}) {
  const root = document.documentElement;
  const button = document.getElementById("theme-toggle");
  // The head script normally did this already; repeat it in case it could not run.
  const saved = stored();
  if (saved && !root.dataset.theme) root.dataset.theme = saved;

  const render = () => {
    const theme = currentTheme();
    button?.setAttribute("aria-pressed", String(theme === "dark"));
    // The browser's own UI follows the desk.
    const desk = getComputedStyle(root).getPropertyValue("--desk").trim();
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = desk;
  };

  button?.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    store(next);
    render();
    onChange?.(next);
  });
  systemDark.addEventListener("change", render);
  render();
  return { theme: currentTheme };
}
