// Theme, in four modes, plus the active-nav highlight.
//
// Boot-time application is inlined in each HTML <head> so the page never flashes
// the wrong palette; this module keeps it right afterwards.
//
// The dark palette is complete: every card, panel, table, figure caption and the
// step strip carry their own dark tokens. There is no "mostly light with a dark
// background" state to warn about — if something looks wrong in dark, it is a
// bug rather than a known gap.

export const THEME_KEY = "sylph-theme";
export const SCHEDULE_KEY = "sylph-theme-schedule";

/** { from, to } as "HH:MM", the window in which the dark palette is used. */
export function loadSchedule() {
  try {
    const raw = JSON.parse(localStorage.getItem(SCHEDULE_KEY) || "null");
    if (raw && /^\d{2}:\d{2}$/.test(raw.from) && /^\d{2}:\d{2}$/.test(raw.to)) return raw;
  } catch { /* private mode, or a value from another version */ }
  return { from: "20:00", to: "07:00" };
}

export function saveSchedule(s) {
  try { localStorage.setItem(SCHEDULE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

const minutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/**
 * Is `now` inside the window? Windows that cross midnight are the normal case
 * here — "dark from 20:00 to 07:00" is what anyone actually wants — so the
 * wrapped comparison is the rule, not the exception.
 */
export function inWindow(from, to, now = new Date()) {
  const t = now.getHours() * 60 + now.getMinutes();
  const a = minutes(from), b = minutes(to);
  return a <= b ? (t >= a && t < b) : (t >= a || t < b);
}

/** The palette a mode resolves to right now. */
export function resolveTheme(mode, schedule = loadSchedule(), now = new Date()) {
  if (mode === "light" || mode === "dark") return mode;
  if (mode === "schedule") return inWindow(schedule.from, schedule.to, now) ? "dark" : "light";
  // "auto", and anything unrecognised: follow the OS.
  return matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

export function currentMode() {
  try { return localStorage.getItem(THEME_KEY) || "light"; } catch { return "light"; }
}

export function applyTheme(mode = currentMode()) {
  document.documentElement.setAttribute("data-theme", resolveTheme(mode));
}

export function setMode(mode) {
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* ignore */ }
  applyTheme(mode);
}

// Follow the OS while in "auto" — the point of that mode is that it changes
// without the page being reloaded.
matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
  if (currentMode() === "auto") applyTheme("auto");
});

// A schedule only takes effect if something checks the clock. Once a minute is
// far more often than the boundary is crossed and costs nothing.
setInterval(() => {
  if (currentMode() === "schedule") applyTheme("schedule");
}, 60_000);

document.addEventListener("DOMContentLoaded", () => {
  // The header button stays a quick light/dark flip — the four-way choice lives
  // in Settings, and a single click is what a toggle is for.
  const btn = document.querySelector(".theme-toggle");
  if (btn) {
    btn.addEventListener("click", () => {
      setMode(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
      document.dispatchEvent(new CustomEvent("theme-changed"));
    });
  }
  const path = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  document.querySelectorAll(".app-nav a").forEach((a) => {
    const href = (a.getAttribute("href") || "").toLowerCase();
    if (href.endsWith(path)) a.classList.add("active");
  });
});
