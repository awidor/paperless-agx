import { For, useContext } from "solid-js";
import { AppContext } from "../state/app";
import { THEME_NAMES } from "../state/theme";
import { Monitor, Moon, Sun } from "./Icons";

const options = Object.entries(THEME_NAMES);

export function ThemeControl() {
  const { theme, choose } = useContext(AppContext).theme;
  return <label class="theme-control" data-preference={theme()} title={`Color theme: ${THEME_NAMES[theme()]}`}>
    <Monitor class="theme-icon--system" size={18} aria-hidden="true" />
    <Sun class="theme-icon--light" size={18} aria-hidden="true" />
    <Moon class="theme-icon--dark" size={18} aria-hidden="true" />
    <select aria-label="Color theme" value={theme()} onChange={(event) => choose(event.currentTarget.value as keyof typeof THEME_NAMES)}>
      <For each={options}>{([value, name]) => <option value={value}>{name}</option>}</For>
    </select>
  </label>;
}
