import { action, createEffect, createMemo, createProjection, createSignal, For, onSettled, Show, useContext } from "solid-js";
import { deleteDocument, patchDocument, retryDocument, type Document, type DocumentPatch } from "../../client/api";
import { Alert, Thumbnail } from "../../components/ui";
import { isProcessing } from "../../lib/format";
import { createRevealMark } from "../../primitives/createRevealMark";
import { motionAllowed } from "../../primitives/motion";
import { AppContext } from "../../state/app";
import { POLL_MS } from "../../state/library";
import type { createReaderData } from "../../state/reader";
import { createMetadataDraft } from "./createMetadataDraft";
import { DigitalPage } from "./DigitalPage";
import { PageView } from "./PageView";
import { ReaderMetadata } from "./ReaderMetadata";

type Props = { page: number; marks?: string[]; marksPage?: number };

type ContentProps = Props & {
  source: ReturnType<typeof createReaderData>;
  document: Document;
  tab: "preview" | "text";
  busy: boolean;
  setBusy: (busy: boolean) => void;
  finishClose: () => void;
  guard: (check: () => boolean) => () => void;
};

export default function Reader(props: ContentProps) {
  const { url, library } = useContext(AppContext);
  const doc = () => props.document;
  const pages = () => props.source.data.pages;
  const page = () => props.page;
  const activePage = createProjection<Record<number, true>>(() => ({ [page()]: true }), {}, { name: "active reader page" });
  const pageMarks = () => {
    const target = props.marksPage;
    return target !== undefined && activePage[target] ? props.marks : undefined;
  };
  const processing = createMemo(() => isProcessing(doc()), { name: "reader processing" });

  const tab = () => props.tab;
  let stage!: HTMLElement;
  let scrollDrivenPage: number | null = null;
  let jumpTarget: number | null = null;
  let jumpTimer: number | undefined;

  const title = createMetadataDraft(() => doc().title ?? "", "document title draft");
  const sender = createMetadataDraft(() => doc().sender ?? "", "document sender draft");
  const date = createMetadataDraft(() => doc().created_at?.slice(0, 10) ?? "", "document date draft");
  const dirty = createMemo(() => title.dirty() || sender.dirty() || date.dirty(), { name: "unsaved document edits" });
  const busy = () => props.busy;
  const [error, setError] = createSignal("");
  const message = () => error() || props.source.data.error;
  const lifetime = new AbortController();
  const { signal } = lifetime;

  function scrollRoot(): HTMLElement | undefined {
    if (!stage) return undefined;
    return getComputedStyle(stage).overflowY === "visible" ? (stage.parentElement ?? stage) : stage;
  }

  function clearJump() {
    jumpTarget = null;
    if (jumpTimer !== undefined) {
      window.clearTimeout(jumpTimer);
      jumpTimer = undefined;
    }
  }

  function scrollToPage(targetPage: number, smooth: boolean) {
    const scroller = scrollRoot();
    if (!scroller) return;
    const target = stage.querySelector<HTMLElement>(`[data-reader-page="${targetPage}"]`);
    if (!target) return;
    const padding = parseFloat(getComputedStyle(stage).paddingTop) || 0;
    const top = targetPage === 1 && scroller === stage
      ? 0
      : Math.max(0, scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - padding);
    if (smooth && motionAllowed()) {
      clearJump();
      jumpTarget = targetPage;
      jumpTimer = window.setTimeout(clearJump, 900);
      scroller.scrollTo({ top, behavior: "smooth" });
    } else {
      clearJump();
      scroller.scrollTo({ top, behavior: "instant" });
    }
  }

  onSettled(() => {
    const unguard = props.guard(() => !busy() && (!dirty() || window.confirm("Discard your unsaved document changes?")));
    const hosts = [stage, stage.parentElement].filter((element): element is HTMLElement => Boolean(element));
    let frame = 0;

    function syncVisiblePage() {
      frame = 0;
      if (jumpTarget !== null) return;
      const scroller = scrollRoot();
      if (!scroller) return;
      const sheets = stage.querySelectorAll<HTMLElement>("[data-reader-page]");
      if (sheets.length <= 1) return;
      let bestPage = page();
      if (scroller.scrollTop <= 2) {
        bestPage = Number(sheets[0].dataset.readerPage) || 1;
      } else if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        bestPage = Number(sheets[sheets.length - 1].dataset.readerPage) || bestPage;
      } else {
        const rootRect = scroller.getBoundingClientRect();
        let bestVisible = -1;
        for (const sheet of sheets) {
          const rect = sheet.getBoundingClientRect();
          const visible = Math.max(0, Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top));
          if (visible > bestVisible) {
            bestVisible = visible;
            bestPage = Number(sheet.dataset.readerPage) || bestPage;
          }
        }
      }
      if (bestPage !== page()) {
        scrollDrivenPage = bestPage;
        url.setDocumentPage(bestPage);
      }
    }

    function onScroll() {
      if (jumpTarget !== null || frame) return;
      frame = requestAnimationFrame(syncVisiblePage);
    }

    for (const host of hosts) {
      host.addEventListener("scroll", onScroll, { passive: true, signal });
      host.addEventListener("scrollend", clearJump, { passive: true, signal });
      for (const input of ["wheel", "touchstart", "pointerdown"]) {
        host.addEventListener(input, clearJump, { passive: true, signal });
      }
    }

    return () => {
      cancelAnimationFrame(frame);
      clearJump();
      unguard();
      lifetime.abort();
    };
  });

  createEffect(
    () => ({ requested: url.state.selected?.page ?? 1, maximum: doc().page_count || 1 }),
    ({ requested, maximum }) => { if (requested > maximum) url.setDocumentPage(maximum); },
    { name: "normalize reader bookmark" },
  );
  createEffect(dirty, (unsaved) => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = true; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, { name: "guard unsaved edits" });

  createEffect(
    processing,
    (polling) => {
      if (!polling) return;
      const timer = setInterval(() => {
        if (!busy()) props.source.poll();
      }, POLL_MS);
      return () => clearInterval(timer);
    },
    { name: "poll reader processing" },
  );

  createEffect(
    () => ({ page: page(), tab: tab() }),
    (turn, previous) => {
      document.getElementById(`reader-page-${turn.page}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (scrollDrivenPage === turn.page && previous?.tab === turn.tab) {
        scrollDrivenPage = null;
        return;
      }
      scrollDrivenPage = null;
      scrollToPage(turn.page, Boolean(previous && previous.tab === turn.tab));
    },
    { name: "turn reader page" },
  );
  createRevealMark(scrollRoot, () => pageMarks()?.length ? `${page()}-${tab()}` : null);

  function received(document: Document) {
    props.source.received(document);
    setError("");
    props.source.update();
    library.update();
  }

  const save = action(function* save(id: number, patch: DocumentPatch) {
    props.setBusy(true);
    try {
      const updated: Document = yield patchDocument(id, patch, signal);
      if (signal.aborted) return;
      title.commit(updated.title ?? "");
      sender.commit(updated.sender ?? "");
      date.commit(updated.created_at?.slice(0, 10) ?? "");
      received(updated);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "Metadata failed to save.");
    } finally {
      props.setBusy(false);
    }
  });

  const retry = action(function* retry(id: number) {
    props.setBusy(true);
    try {
      const updated: Document = yield retryDocument(id, signal);
      if (!signal.aborted) received(updated);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "Retry failed.");
    } finally {
      props.setBusy(false);
    }
  });

  const remove = action(function* remove(id: number) {
    props.setBusy(true);
    try {
      yield deleteDocument(id, signal);
      if (signal.aborted) return;
      library.update();
      props.finishClose();
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "Deletion failed.");
    } finally {
      props.setBusy(false);
    }
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy() || !dirty()) return;
    void save(doc().document_id, {
      title: title.value.trim() || null,
      sender: sender.value.trim() || null,
      created_at: date.value ? new Date(`${date.value}T00:00:00`).toISOString() : null,
    });
  }

  return <>
    <Show when={message()}>{(text) => <div class="reader__alert">
      <Alert message={text()} onDismiss={() => {
        if (props.source.data.error === text()) props.source.dismissError();
        setError("");
      }} />
    </div>}</Show>
    <div class="reader__body">
      <nav class="reader__pages" aria-label="Pages">
        <For each={pages()}>{(item) => <button id={`reader-page-${item.page}`} type="button" class="page-thumb" aria-label={`Show page ${item.page}`}
          aria-pressed={activePage[item.page] === true ? "true" : "false"} onClick={() => url.setDocumentPage(item.page)}>
          <span class="sheet sheet--page"><Thumbnail document={doc()} page={item.page} priority={item.page <= 4} /></span>
          <span class="page-thumb__n">{item.page}</span>
        </button>}</For>
      </nav>
      <section class="reader__stage" id="reader-view" role="tabpanel" aria-labelledby={tab() === "preview" ? "preview-tab" : "text-tab"} ref={stage}>
        <Show when={tab() === "text"} fallback={<div class="reader__page">
          <PageView
            document={doc()}
            pages={pages()}
            marks={props.marks}
            marksPage={props.marksPage}
            scrollRoot={scrollRoot}
            onPagesReady={() => { if (page() > 1) scrollToPage(page(), false); }}
          />
        </div>}>
          <div class="reader__page reader__sheets">
            <Show when={pages().length > 0} fallback={
              <div class="reader__sheet" data-reader-page={1}>
                <DigitalPage documentId={doc().document_id} page={undefined} marks={undefined} />
              </div>
            }>
              <For each={pages()}>{(item) => <div class="reader__sheet" data-reader-page={item.page}>
                <DigitalPage documentId={doc().document_id} page={item} marks={props.marksPage === item.page ? props.marks : undefined} />
              </div>}</For>
            </Show>
          </div>
        </Show>
        <Show when={tab() === "preview"}><p class="reader__hint">Drag across the page text to select and copy it.</p></Show>
      </section>
      <ReaderMetadata document={doc()} title={title} sender={sender} date={date} dirty={dirty()} busy={busy()} onSave={submit}
        onRetry={() => { if (!busy()) void retry(doc().document_id); }}
        onRemove={() => {
          if (!busy() && window.confirm("Delete this document and its indexed data? This action cannot be undone.")) void remove(doc().document_id);
        }} />
    </div>
  </>;
}
