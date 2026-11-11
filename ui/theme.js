// Theme switch: Auto (follows the system) → Light → Dark.
// Loaded in <head> so the saved choice is applied before the first paint.
(() => {
  const KEY = "vigie-theme";
  const MODES = ["auto", "light", "dark"];
  const LABELS = { auto: "◐ Auto", light: "☀ Light", dark: "☾ Dark" };

  const read = () => {
    try {
      const v = localStorage.getItem(KEY);
      return MODES.includes(v) ? v : "auto";
    } catch {
      return "auto"; // storage blocked: still works for this page view
    }
  };
  const apply = (mode) => {
    if (mode === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", mode);
  };

  let mode = read();
  apply(mode);

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme");
    if (!btn) return;
    const paint = () => {
      btn.textContent = LABELS[mode];
      btn.setAttribute("aria-label", `Theme: ${mode}. Click to change.`);
      btn.title = "Change theme";
    };
    paint();
    btn.addEventListener("click", () => {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      apply(mode);
      try {
        localStorage.setItem(KEY, mode);
      } catch {
        /* not persisted, that's fine */
      }
      paint();
    });
  });
})();
