// Appearance: theme (Auto / Light / Dark) and the accent color, both chosen by the user.
// Loaded in <head> so the saved choices are applied before the first paint.
// The accent is set through the CSSOM (style.setProperty), which the strict CSP allows.
(() => {
  const THEME_KEY = "vigie-theme";
  const ACCENT_KEY = "vigie-accent";
  const MODES = ["auto", "light", "dark"];
  const LABELS = { auto: "Auto", light: "Light", dark: "Dark" };
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

  // Icons are drawn here, in the page head, so the buttons are never empty or text-only.
  const NS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs = {}) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };
  const ICONS = {
    auto: () => [svgEl("circle", { cx: 12, cy: 12, r: 9 }), svgEl("path", { d: "M12 3a9 9 0 0 1 0 18z", fill: "currentColor" })],
    light: () => [
      svgEl("circle", { cx: 12, cy: 12, r: 4 }),
      svgEl("path", { d: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" }),
    ],
    dark: () => [svgEl("path", { d: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" })],
  };
  const icon = (name) => {
    const s = svgEl("svg", { viewBox: "0 0 24 24", class: "ico", "aria-hidden": "true" });
    s.append(...ICONS[name]());
    return s;
  };
  const el = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...kids);
    return e;
  };

  document.addEventListener("DOMContentLoaded", () => {
    const themeBtn = document.getElementById("theme");
    const themePop = document.getElementById("theme-pop");
    const accentBtn = document.getElementById("accent");
    const accentPop = document.getElementById("accent-pop");

    // One dropdown open at a time; it closes on a click outside and on Esc (focus goes back to its button).
    const dropdowns = [];
    const dropdown = (btn, pop, onOpen) => {
      const d = {
        btn,
        pop,
        close(focusButton = false) {
          if (pop.hidden) return;
          pop.hidden = true;
          btn.setAttribute("aria-expanded", "false");
          if (focusButton) btn.focus();
        },
        open() {
          for (const other of dropdowns) if (other !== d) other.close();
          pop.hidden = false;
          btn.setAttribute("aria-expanded", "true");
          onOpen?.();
        },
      };
      btn.addEventListener("click", () => (pop.hidden ? d.open() : d.close()));
      dropdowns.push(d);
      return d;
    };
    document.addEventListener("click", (e) => {
      for (const d of dropdowns) if (!d.pop.hidden && !d.pop.contains(e.target) && !d.btn.contains(e.target)) d.close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const openOne = dropdowns.find((d) => !d.pop.hidden);
      if (!openOne) return;
      openOne.close(true);
      e.stopPropagation(); // this Esc was meant for the dropdown: the page must not also go back
    });

    // ----- theme: icon button + menu -----
    if (themeBtn && themePop) {
      const setMode = (m) => {
        mode = m;
        applyMode();
        write(THEME_KEY, mode);
        paint();
      };
      const items = MODES.map((m) => {
        const b = el("button", { type: "button", className: "menu-item" }, icon(m), el("span", { className: "lbl" }, LABELS[m]), el("span", { className: "check", textContent: "✓" }));
        b.setAttribute("role", "menuitemradio");
        b.addEventListener("click", () => {
          setMode(m);
          themeDropdown.close(true);
        });
        return [m, b];
      });
      themePop.append(el("div", { className: "pop-title" }, "Theme"), ...items.map(([, b]) => b));
      const paint = () => {
        themeBtn.replaceChildren(icon(mode));
        themeBtn.setAttribute("aria-label", `Theme: ${LABELS[mode]}`);
        themeBtn.title = `Theme: ${LABELS[mode]}`;
        for (const [m, b] of items) b.setAttribute("aria-checked", String(m === mode));
      };
      const themeDropdown = dropdown(themeBtn, themePop, () => items.find(([m]) => m === mode)?.[1].focus());
      themePop.addEventListener("keydown", (e) => {
        const buttons = items.map(([, b]) => b);
        const i = buttons.indexOf(document.activeElement);
        const move = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
        if (move === undefined) return;
        e.preventDefault();
        buttons[(move + buttons.length) % buttons.length].focus();
      });
      paint();
    }

    // ----- accent: color dot button + color choices -----
    if (accentBtn && accentPop) {
      const refresh = () => {
        for (const [b, hex] of chips) b.setAttribute("aria-pressed", String(hex === accent));
        custom.value = accent.toLowerCase();
      };
      const choose = (hex) => {
        accent = hex.toUpperCase();
        applyAccent();
        write(ACCENT_KEY, accent === DEFAULT_ACCENT ? null : accent);
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
      const reset = el("button", { type: "button", className: "small" }, "Reset");
      reset.addEventListener("click", () => choose(DEFAULT_ACCENT));
      accentPop.append(
        el("div", { className: "pop-title" }, "Accent color"),
        el("div", { className: "chips" }, ...chips.map(([b]) => b)),
        el("label", { className: "custom" }, "Custom ", custom),
        reset,
      );
      refresh();
      dropdown(accentBtn, accentPop);
    }
  });
})();
