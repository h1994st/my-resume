// A test-only playback speed: index.html?speed=N (a positive number; anything else is ignored)
// runs the film's timers N times faster: holds, delays, typing, cat pose cycles, and the
// terminal's pacing. Animations (WAAPI and CSS) keep their own clock; the browser tests speed
// them up through the DevTools protocol (Animation.setPlaybackRate).

const n = Number(new URLSearchParams(location.search).get("speed"));
export const SPEED = Number.isFinite(n) && n > 0 ? n : 1;
