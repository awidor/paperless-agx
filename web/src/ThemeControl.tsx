import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Monitor, Moon, Sun } from "lucide-react";
import { motionAllowed } from "./motion";

type Theme = "system" | "light" | "dark";
const storageKey = "paperless-agx-theme";
const NAMES: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(storageKey);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

const system = () => window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme === "system" ? (system().matches ? "dark" : "light") : theme;
  // The browser chrome takes the paper colour of whichever theme is showing.
  const paper = getComputedStyle(root).getPropertyValue("--color-paper").trim();
  if (paper) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", paper);
}

/** The colour theme: follows the system unless the reader picks one, and stays in step across tabs. */
export function ThemeControl() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const media = system();
    const follow = () => applyTheme(theme);
    follow();
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [theme]);

  /** A theme the reader picks crossfades in; the old page is captured before anything changes. */
  function choose(next: Theme) {
    const swap = () => {
      flushSync(() => setTheme(next));
      applyTheme(next);
    };
    if (document.startViewTransition && motionAllowed()) document.startViewTransition(swap);
    else swap();
  }

  useEffect(() => {
    function syncTheme(event: StorageEvent) {
      if (event.key === storageKey || event.key === null) setTheme(readTheme());
    }
    window.addEventListener("storage", syncTheme);
    return () => window.removeEventListener("storage", syncTheme);
  }, []);

  const Icon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  return <label className="theme-control" title={`Color theme: ${NAMES[theme]}`}>
    <Icon size={18} aria-hidden="true" />
    <select
      aria-label="Color theme"
      value={theme}
      onChange={(event) => {
        const next = event.target.value as Theme;
        choose(next);
        try {
          localStorage.setItem(storageKey, next);
        } catch {
          // The theme still works for this visit when storage is unavailable.
        }
      }}
    >
      {Object.entries(NAMES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
    </select>
  </label>;
}
