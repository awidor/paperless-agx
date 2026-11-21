import { onSettled, Show, useContext } from "solid-js";
import { AppContext } from "../state/app";
import { Search, TriangleAlert, Upload, X } from "./Icons";
import { ScanControl } from "./Scan";
import { ThemeControl } from "./ThemeControl";
import { Spinner } from "./ui";

export function TopBar(props: { onUpload: () => void }) {
  const { url, library, search, transfers } = useContext(AppContext);
  const health = () => library.context.health;
  const uploading = () => transfers.state.upload?.active ?? false;
  let searchInput!: HTMLInputElement;

  // "/" jumps to search from anywhere outside an editable field or dialog.
  onSettled(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true'], dialog[open]")) return;
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return <header class="bar">
    <div class="container bar__inner">
      <a class="wordmark" href="/" onClick={(event) => { event.preventDefault(); url.clearSearch(); }}>Paperless AGX</a>
      <form class="search-field" role="search" onSubmit={url.submitSearch} aria-busy={search.running ? "true" : "false"}>
        <Search class="search-field__icon" size={18} aria-hidden="true" />
        <input
          ref={searchInput}
          type="search"
          value={url.draft()}
          enterkeyhint="search"
          onInput={(event) => url.setDraft(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.blur(); }}
          placeholder="Ask a question, describe a document, or “quote” exact text"
          aria-label="Search documents"
        />
        <span class={["search-field__end", { "is-searching": Boolean(url.state.search) }]}>
          <kbd class="search-field__key" title="Press / to search">/</kbd>
          <button type="button" class="icon-btn icon-btn--sm" aria-label="Clear search" onClick={url.clearSearch}><X size={16} aria-hidden="true" /></button>
        </span>
      </form>
      <div class="bar__actions">
        <Show when={health() && !health()?.embedding_configured}>
          <p class="health" title={`Not configured: search embeddings (${health()?.embedding_model || "no model"})`}>
            <TriangleAlert size={16} aria-hidden="true" />
            <span class="health__label">Models not configured</span>
          </p>
        </Show>
        <ThemeControl />
        <Show when={health()?.scanner_configured}><ScanControl /></Show>
        <button type="button" class="btn btn--ink" disabled={uploading()} aria-busy={uploading() ? "true" : "false"} onClick={() => props.onUpload()}>
          <Show when={uploading()} fallback={<Upload size={16} aria-hidden="true" />}><Spinner /></Show>
          <span class="btn__label">{uploading() ? "Uploading" : "Upload"}</span>
        </button>
      </div>
    </div>
  </header>;
}
