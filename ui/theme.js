// Appearance: theme (Auto → Light → Dark) and the accent color, both chosen by the user.
// Loaded in <head> so the saved choices are applied before the first paint.
// The accent is set through the CSSOM (style.setProperty), which the strict CSP allows.
(() => {
  const THEME_KEY = "vigie-theme";
  const ACCENT_KEY = "vigie-accent";
  const MODES = ["auto", "light", "dark"];
  const LABELS = { auto: "◐ Auto", light: "☀ Light", dark: "☾ Dark" };
  const PRESETS = [
    ["Vermilion", "#EF5B2B"],
    ["Cobalt", "#3563FF"],
    ["Emerald", "#12A15B"],
    ["Violet", "#7B4DFF"],
  ];
  const DEFAULT_ACCENT = PRESETS[0][1];
  const HEX = /^#[0-9a-f]{6}$/i;

  const read = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null; // storage blocked: the choice still applies for this page view
    }
  };
  const write = (key, value) => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* not persisted, that's fine */
    }
  };

  let mode = MODES.includes(read(THEME_KEY)) ? read(THEME_KEY) : "auto";
  let accent = HEX.test(read(ACCENT_KEY) ?? "") ? read(ACCENT_KEY).toUpperCase() : DEFAULT_ACCENT;

  const root = document.documentElement;
  const applyMode = () => (mode === "auto" ? root.removeAttribute("data-theme") : root.setAttribute("data-theme", mode));
  const applyAccent = () => root.style.setProperty("--accent", accent);
  applyMode();
  applyAccent();

  document.addEventListener("DOMContentLoaded", () => {
    const themeBtn = document.getElementById("theme");
    const accentBtn = document.getElementById("accent");
    const pop = document.getElementById("accent-pop");

    if (themeBtn) {
      const paint = () => {
        themeBtn.textContent = LABELS[mode];
        themeBtn.setAttribute("aria-label", `Theme: ${mode}. Click to change.`);
        themeBtn.title = "Change theme";
      };
      paint();
      themeBtn.addEventListener("click", () => {
        mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
        applyMode();
        write(THEME_KEY, mode);
        paint();
      });
    }
    if (!accentBtn || !pop) return;

    const el = (tag, props = {}, ...kids) => {
      const e = Object.assign(document.createElement(tag), props);
      e.append(...kids);
      return e;
    };
    const choose = (hex, persist = true) => {
      accent = hex.toUpperCase();
      applyAccent();
      if (persist) write(ACCENT_KEY, accent === DEFAULT_ACCENT ? null : accent);
      refresh();
    };
    const chips = PRESETS.map(([name, hex]) => {
      const b = el("button", { type: "button", className: "chip", title: name });
      b.style.background = hex;
      b.setAttribute("aria-label", name);
      b.addEventListener("click", () => choose(hex));
      return [b, hex];
    });
    const custom = el("input", { type: "color", value: accent });
    custom.setAttribute("aria-label", "Custom accent color");
    custom.addEventListener("input", () => choose(custom.value));
    const reset = el("button", { type: "button", className: "btn small" }, "Reset");
    reset.addEventListener("click", () => choose(DEFAULT_ACCENT));
    pop.append(
      el("div", { className: "pop-title" }, "Accent color"),
      el("div", { className: "chips" }, ...chips.map(([b]) => b)),
      el("label", { className: "custom" }, "Custom ", custom),
      reset,
    );

    const refresh = () => {
      for (const [b, hex] of chips) b.setAttribute("aria-pressed", String(hex === accent));
      custom.value = accent.toLowerCase();
    };
    refresh();

    const close = () => {
      pop.hidden = true;
      accentBtn.setAttribute("aria-expanded", "false");
    };
    accentBtn.addEventListener("click", () => {
      pop.hidden = !pop.hidden;
      accentBtn.setAttribute("aria-expanded", String(!pop.hidden));
    });
    document.addEventListener("click", (e) => {
      if (!pop.hidden && !pop.contains(e.target) && !accentBtn.contains(e.target)) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !pop.hidden) {
        close();
        accentBtn.focus();
      }
    });
  });
})();
