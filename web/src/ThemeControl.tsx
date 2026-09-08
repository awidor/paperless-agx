import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Theme = "system" | "light" | "dark";
const storageKey = "paperless-agx-theme";

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(storageKey);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

export function ThemeControl() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    function applyTheme() {
      const resolved = theme === "system" ? (system.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute(
        "content", resolved === "dark" ? "#181818" : "#fafaf9",
      );
    }
    applyTheme();
    system.addEventListener("change", applyTheme);
    return () => system.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    function syncTheme(event: StorageEvent) {
      if (event.key === storageKey || event.key === null) setTheme(readTheme());
    }
    window.addEventListener("storage", syncTheme);
    return () => window.removeEventListener("storage", syncTheme);
  }, []);

  const Icon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  return (
    <label className="theme-control">
      <Icon size={15} aria-hidden="true" />
      <select
        aria-label="Color theme"
        value={theme}
        onChange={(event) => {
          const next = event.target.value as Theme;
          setTheme(next);
          try {
            localStorage.setItem(storageKey, next);
          } catch {
            // The theme still works for this visit when storage is unavailable.
          }
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
