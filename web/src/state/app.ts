import { createContext, createSignal, onSettled } from "solid-js";
import { createCropClient } from "../lib/createCropClient";
import { createLibraryState } from "./library";
import { createSearchState } from "./search";
import { createTheme } from "./theme";
import { createTransfers } from "./transfers";
import { createUrlState } from "./url";

export function createAppState() {
  const url = createUrlState();
  const library = createLibraryState(() => url.state.query);
  const search = createSearchState(() => url.state.search, () => url.state.query, url.run);
  const transfers = createTransfers(library.update);
  const theme = createTheme();
  const crops = createCropClient();
  onSettled(() => crops.dispose);
  const [filtersOpen, setFiltersOpen] = createSignal(false, { name: "filters open" });
  return { url, library, search, transfers, theme, crops, filtersOpen, toggleFilters: () => setFiltersOpen((open) => !open) };
}

export const AppContext = createContext<ReturnType<typeof createAppState>>();
