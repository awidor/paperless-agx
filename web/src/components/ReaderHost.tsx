import { createOptimistic, createSignal, Errored, isPending, latest, lazy, onSettled, Show, useContext } from "solid-js";
import { documentName } from "../lib/format";
import { createGrooveThumb } from "../primitives/motion";
import { ChevronLeft, ChevronRight } from "./Icons";
import { AppContext } from "../state/app";
import { createReaderData } from "../state/reader";
import { CloseReader, EmptyState, Spinner } from "./ui";

const Reader = lazy(() => import("../features/reader/Reader"));

export function ReaderHost(props: { documentId: number; page: number; marks?: string[]; marksPage?: number }) {
  const { url } = useContext(AppContext);
  const source = createReaderData(() => props.documentId, () => Reader.preload());
  const [tab, setTab] = createSignal<"preview" | "text">("preview", { name: "reader tab" });
  const [busy, setBusy] = createOptimistic(false, { name: "reader mutation busy" });
  const pageCount = () => source.data.document?.page_count || 1;
  const clampPage = (value: number) => Math.max(1, Math.min(value, pageCount()));
  const page = () => clampPage(props.page);
  const selectPage = (value: number) => url.setDocumentPage(clampPage(value));
  let dialog!: HTMLDialogElement;
  let allowClose: (() => boolean) | undefined;

  function handleKey(event: KeyboardEvent) {
    if (!source.data.document) return;
    if (event.altKey || event.ctrlKey || event.metaKey
      || (event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']")) return;
    const step = event.key === "ArrowLeft" || event.key === "PageUp" ? -1
      : event.key === "ArrowRight" || event.key === "PageDown" ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    selectPage(page() + step);
  }

  function close() {
    dialog.close();
    url.closeDocument();
  }

  function requestClose() {
    if (!allowClose || allowClose()) close();
  }

  function guard(check: () => boolean) {
    allowClose = check;
    const remove = url.guardReader(check);
    return () => {
      if (allowClose === check) allowClose = undefined;
      remove();
    };
  }

  onSettled(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = overflow;
    };
  });

  return <dialog class="reader" ref={dialog} aria-labelledby="reader-title"
    onKeyDown={handleKey} onCancel={(event) => { event.preventDefault(); requestClose(); }}>
    <header class="reader__bar">
      <CloseReader onClose={requestClose} disabled={busy()} />
      <div class="reader__titles">
        <h2 id="reader-title" class="reader__title" title={source.data.document?.filename}>
          {source.data.document ? documentName(source.data.document) : source.data.error ? "Document unavailable" : "Loading the document"}
        </h2>
        <Show when={source.data.document}>{(doc) => <p class="reader__sub">{doc().sender || doc().filename}</p>}</Show>
      </div>
      <Show when={source.data.document}>
        <ReaderControls tab={tab()} setTab={setTab} page={page()} pageCount={pageCount()} selectPage={selectPage} />
      </Show>
    </header>
    <Errored fallback={(error, reset) => <ReaderPlaceholder onRetry={() => void reset()} error={String(error())} />}>
      <Show when={source.data.loaded} fallback={<ReaderPlaceholder />}>
        <Show when={source.data.document} fallback={
          <ReaderPlaceholder onRetry={source.retry} error={isPending(() => source.data.document) ? undefined : source.data.error} />
        }>{(doc) => <Reader
          source={source} document={doc()} page={page()} tab={tab()} busy={busy()} setBusy={setBusy} marks={props.marks} marksPage={props.marksPage}
          finishClose={close} guard={guard}
        />}</Show>
      </Show>
    </Errored>
  </dialog>;
}

function ReaderPlaceholder(props: { onRetry?: () => void; error?: string }) {
  return <div class="reader__empty">
    <Show when={props.error} fallback={<p class="status-line" role="status"><Spinner /> Loading the document</p>}>{(message) =>
      <EmptyState alert title="The document could not be loaded"
        action={<button type="button" class="btn" onClick={() => props.onRetry?.()}>Try again</button>}>
        {message()}
      </EmptyState>
    }</Show>
  </div>;
}

function ReaderControls(props: {
  tab: "preview" | "text";
  setTab: (tab: "preview" | "text") => void;
  page: number;
  pageCount: number;
  selectPage: (page: number) => void;
}) {
  const tabs = createGrooveThumb(() => props.tab);
  return <div class="reader__controls">
    <div class="groove" ref={tabs} role="tablist" aria-label="Document views">
      <button type="button" id="preview-tab" role="tab" class="groove__option" aria-selected={props.tab === "preview" ? "true" : "false"} aria-controls="reader-view" onClick={() => props.setTab("preview")}>Page</button>
      <button type="button" id="text-tab" role="tab" class="groove__option" aria-selected={props.tab === "text" ? "true" : "false"} aria-controls="reader-view" onClick={() => props.setTab("text")}>OCR text</button>
    </div>
    <div class="page-nav">
      <button type="button" class="icon-btn" aria-label="Previous page" disabled={props.page <= 1} onClick={() => props.selectPage(props.page - 1)}><ChevronLeft size={18} aria-hidden="true" /></button>
      <p class="page-nav__where" aria-live="polite">Page {latest(() => props.page)} of {props.pageCount}</p>
      <button type="button" class="icon-btn" aria-label="Next page" disabled={props.page >= props.pageCount} onClick={() => props.selectPage(props.page + 1)}><ChevronRight size={18} aria-hidden="true" /></button>
    </div>
  </div>;
}
