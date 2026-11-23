import { createEffect, createMemo, createSignal, Errored, isPending, Loading, Match, onSettled, Repeat, Show, Switch, useContext } from "solid-js";
import { FilterBar, FilterToggle } from "../../components/FilterBar";
import { LayoutGrid, Rows3, Upload } from "../../components/Icons";
import { Alert, EmptyState, Spinner } from "../../components/ui";
import { activeFilterCount, groupDocuments, plural } from "../../lib/format";
import { createGrooveThumb } from "../../primitives/motion";
import { AppContext } from "../../state/app";
import { initialQuery } from "../../state/url";
import { Ledger } from "./Ledger";
import { Shelf } from "./Shelf";

function ViewSwitch() {
  const { url } = useContext(AppContext);
  const groove = createGrooveThumb(() => url.state.view);
  return <div class="groove" ref={groove} role="group" aria-label="Document view">
    <button type="button" class="groove__option" aria-pressed={url.state.view === "grid" ? "true" : "false"} onClick={() => url.setView("grid")}><LayoutGrid size={16} aria-hidden="true" /> Grid</button>
    <button type="button" class="groove__option" aria-pressed={url.state.view === "list" ? "true" : "false"} onClick={() => url.setView("list")}><Rows3 size={16} aria-hidden="true" /> List</button>
  </div>;
}

function ShelfSkeleton() {
  const { url } = useContext(AppContext);
  return <Show when={url.state.view === "grid"} fallback={<div class="ledger-skeleton" aria-busy="true" aria-label="Loading your documents">
    <Repeat count={8}>{() => <span class="skeleton skeleton--row" />}</Repeat>
  </div>}>
    <ul class="sheet-grid" role="list" aria-busy="true" aria-label="Loading your documents">
      <Repeat count={12}>{() => <li class="sheet-card">
        <span class="sheet sheet--thumb skeleton" />
        <span class="skeleton skeleton--line" />
        <span class="skeleton skeleton--line skeleton--short" />
      </li>}</Repeat>
    </ul>
  </Show>;
}

export function Library(props: { onUpload: () => void }) {
  return <section class="view" aria-labelledby="library-title">
    <Errored fallback={(error, reset) => <EmptyState alert title="The library could not be loaded"
      action={<button type="button" class="btn" onClick={() => void reset()}>Try again</button>}>
      {error() instanceof Error ? (error() as Error).message : undefined}
    </EmptyState>}>
      <Loading fallback={<>
        <header class="view-head"><div class="view-head__title"><h1 id="library-title">Library</h1></div></header>
        <ShelfSkeleton />
      </>}>
        <LibraryContents onUpload={() => props.onUpload()} />
      </Loading>
    </Errored>
  </section>;
}

function LibraryContents(props: { onUpload: () => void }) {
  const { url, library: service } = useContext(AppContext);
  const { library } = service;
  const query = () => library.query;
  const groups = createMemo(() => groupDocuments(library.items, query().sort), { name: "library groups" });
  const empty = () => library.loaded && library.total === 0 && !query().sender && !query().createdFrom && !query().createdTo;
  const count = () => activeFilterCount(url.state.query, true);
  const [dismissed, dismiss] = createSignal(0);
  const pending = () => isPending(() => library.items);

  return <>
    <Show when={library.loaded && library.failureId && library.failureId !== dismissed()}>
      <Alert message={library.error} onRetry={service.retry} onDismiss={() => dismiss(library.failureId)} />
    </Show>
    <header class="view-head">
      <div class="view-head__title">
        <h1 id="library-title">Library</h1>
        <p class="view-head__count" aria-live="polite" aria-busy={pending() ? "true" : "false"}>
          {library.loaded ? plural(library.total, "document") : ""}
          <span hidden={!pending()}><Spinner label="Updating library" /></span>
        </p>
      </div>
      <Show when={!empty()}><div class="view-head__tools">
        <FilterToggle count={count()} />
        <ViewSwitch />
      </div></Show>
    </header>
    <Show when={!empty()}><FilterBar count={count()} withSort /></Show>
    <Switch>
      <Match when={!library.loaded}>
        <EmptyState alert title="The library could not be loaded" action={<button type="button" class="btn" onClick={service.retry}>Try again</button>}>
          {library.error || "Check that the Paperless AGX server is running, then try again."}
        </EmptyState>
      </Match>
      <Match when={empty()}>
        <div class="dropzone">
          <span class="sheet dropzone__sheet" aria-hidden="true"><Upload size={28} /></span>
          <div class="dropzone__text">
            <h2 class="empty__title">Your library is empty</h2>
            <p>Drop scans and PDFs anywhere on this page, or choose them from your computer. PDF, PNG, JPEG, TIFF and WebP files are read and indexed for search.</p>
            <div class="empty__actions"><button type="button" class="btn" onClick={() => props.onUpload()}><Upload size={16} aria-hidden="true" /> Choose files</button></div>
          </div>
        </div>
      </Match>
      <Match when={library.items.length === 0}>
        <EmptyState title="No documents match these filters" action={<button type="button" class="btn" onClick={() => url.updateQuery(initialQuery)}>Clear filters</button>}>
          Remove a filter to see more of the library.
        </EmptyState>
      </Match>
      <Match when={url.state.view === "grid"}><Shelf groups={groups()} /></Match>
      <Match when={url.state.view === "list"}><Ledger groups={groups()} /></Match>
    </Switch>
    <Show when={library.hasMore}><LibraryMore /></Show>
  </>;
}

function LibraryMore() {
  const { library: service } = useContext(AppContext);
  const { library, loadingMore } = service;
  let sentinel!: HTMLDivElement;

  onSettled(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) service.loadMore();
    }, { rootMargin: "320px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  });

  createEffect(
    () => ({ pages: library.loadedPages, more: library.hasMore, error: library.error }),
    ({ more, error }) => {
      if (!more || error) return;
      if (sentinel.getBoundingClientRect().top <= window.innerHeight + 320) service.loadMore();
    },
    { defer: true, name: "continue infinite library scroll" },
  );

  return <div class="library-more" ref={sentinel}>
    <Show when={loadingMore()}>
      <p class="status-line" role="status"><Spinner /> Loading more documents</p>
    </Show>
  </div>;
}
