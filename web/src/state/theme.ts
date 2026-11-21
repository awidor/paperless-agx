import { createEffect, createSignal, flush, onSettled } from "solid-js";
import { motionAllowed } from "../primitives/motion";

type Theme = "system" | "light" | "dark";
const storageKey = "paperless-agx-theme";
export const THEME_NAMES: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(storageKey);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

export function createTheme() {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const [darkSystem, setDarkSystem] = createSignal(media.matches, { name: "system dark preference" });
  const [theme, setTheme] = createSignal(readTheme(), { name: "theme preference" });

  createEffect(
    () => theme() === "system" ? (darkSystem() ? "dark" : "light") : theme(),
    (resolved) => {
      const root = document.documentElement;
      root.dataset.theme = resolved;
      const paper = getComputedStyle(root).getPropertyValue("--color-paper").trim();
      if (paper) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", paper);
    },
    { name: "apply theme" },
  );

  onSettled(() => {
    const controller = new AbortController();
    const { signal } = controller;
    media.addEventListener("change", (event) => setDarkSystem(event.matches), { signal });
    window.addEventListener("storage", (event) => {
      if (event.key === storageKey || event.key === null) setTheme(readTheme());
    }, { signal });
    return () => controller.abort();
  });

  function choose(next: Theme) {
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // The preference still applies to this tab.
    }

    const swap = () => {
      setTheme(next);
      flush();
    };
    // Avoid a full-screen snapshot and delayed selection commit on small screens.
    const compact = window.matchMedia("(max-width: 40rem)").matches;
    if (document.startViewTransition && !compact && motionAllowed()) document.startViewTransition(swap);
    else swap();
  }

  return { theme, choose };
}
