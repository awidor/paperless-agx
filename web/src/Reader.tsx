import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, Download, RefreshCw, Save, Sparkles, Trash2, X } from "lucide-react";
import {
  deleteDocument,
  getDocument,
  getPages,
  inferDocumentMetadata,
  patchDocument,
  retryDocument,
  type Document,
  type PageInfo,
} from "./api";
import { DigitalPage } from "./DigitalPage";
import { documentName, formatBytes, formatDay, isProcessing, stage } from "./format";
import { PageView } from "./PageView";
import { Alert, EmptyState, Spinner, StageMeter, useRevealMark } from "./ui";

function MetadataField({ label, ai, children }: { label: string; ai: boolean; children: ReactNode }) {
  return <label className="field">
    <span className="field__label">{label}{ai && <span className="field__source">Filled in by AI</span>}</span>
    {children}
  </label>;
}

/** Keys that page through the document unless the reader is typing or choosing. */
function pagingKey(event: KeyboardEvent): -1 | 1 | 0 {
  const target = event.target as HTMLElement | null;
  if (event.altKey || event.ctrlKey || event.metaKey || target?.closest("input, textarea, select, [contenteditable='true']")) return 0;
  if (event.key === "ArrowLeft" || event.key === "PageUp") return -1;
  if (event.key === "ArrowRight" || event.key === "PageDown") return 1;
  return 0;
}

export function Reader({ documentId, initialPage, marks, marksPage, senders, onPageChange, onDirtyChange, onClose, onChanged }: {
  documentId: number;
  initialPage: number;
  /** Terms to mark on `marksPage`, the page a search result pointed at. */
  marks?: string[];
  marksPage?: number;
  senders: string[];
  onPageChange: (page: number) => void;
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [document, setDocument] = useState<Document | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [page, setPage] = useState(initialPage);
  const [tab, setTab] = useState<"preview" | "text">("preview");
  const [title, setTitle] = useState("");
  const [sender, setSender] = useState("");
  const [createdAt, setCreatedAt] = useState("");
  const [edited, setEdited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const overflow = window.document.body.style.overflow;
    window.document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      window.document.body.style.overflow = overflow;
    };
  }, []);

  useEffect(() => {
    setPage(initialPage);
  }, [initialPage]);

  useEffect(() => {
    stageRef.current?.scrollTo({ top: 0 });
    railRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [page, tab]);

  async function load(preserveEdits = false) {
    if (!document) setLoading(true);
    try {
      const [nextDocument, nextPages] = await Promise.all([getDocument(documentId), getPages(documentId)]);
      const nextPage = Math.min(Math.max(page, 1), nextDocument.page_count || 1);
      setDocument(nextDocument);
      setPages(nextPages);
      setPage(nextPage);
      if (nextPage !== page) onPageChange(nextPage);
      if (!preserveEdits || !edited) {
        setTitle(nextDocument.title || "");
        setSender(nextDocument.sender || "");
        setCreatedAt(nextDocument.created_at?.slice(0, 10) || "");
        setEdited(false);
      }
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The document failed to load.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [documentId]);

  const processing = document !== null && isProcessing(document);
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(() => void load(true), 2_000);
    return () => window.clearInterval(timer);
  }, [documentId, document?.status, edited, page, processing]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const updated = await patchDocument(documentId, {
        title: title.trim() || null,
        sender: sender.trim() || null,
        created_at: createdAt ? new Date(`${createdAt}T00:00:00`).toISOString() : null,
      });
      setDocument(updated);
      setEdited(false);
      setError("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Metadata failed to save.");
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    try {
      setDocument(await retryDocument(documentId));
      setError("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Retry failed.");
    } finally {
      setBusy(false);
    }
  }

  async function infer() {
    setBusy(true);
    try {
      const updated = await inferDocumentMetadata(documentId);
      setDocument(updated);
      setTitle(updated.title || "");
      setSender(updated.sender || "");
      setCreatedAt(updated.created_at?.slice(0, 10) || "");
      setEdited(false);
      setError("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "AI metadata failed.");
    } finally {
      setBusy(false);
    }
  }

  function finishClose() {
    onDirtyChange(false);
    dialogRef.current?.close();
    onClose();
  }

  function requestClose() {
    if (busy) return;
    if (dirty && !window.confirm("Discard your unsaved document changes?")) return;
    finishClose();
  }

  async function remove() {
    if (!window.confirm("Delete this document and its indexed data? This action cannot be undone.")) return;
    setBusy(true);
    try {
      await deleteDocument(documentId);
      onChanged();
      finishClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Deletion failed.");
      setBusy(false);
    }
  }

  function selectPage(next: number) {
    const maximum = document?.page_count || 1;
    const selectedPage = Math.min(Math.max(next, 1), maximum);
    setPage(selectedPage);
    onPageChange(selectedPage);
  }

  const selectPageRef = useRef(selectPage);
  selectPageRef.current = selectPage;
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function onKeyDown(event: KeyboardEvent) {
      const step = pagingKey(event);
      if (step === 0) return;
      event.preventDefault();
      selectPageRef.current(pageRef.current + step);
    }
    dialog.addEventListener("keydown", onKeyDown);
    return () => dialog.removeEventListener("keydown", onKeyDown);
  }, []);

  const current = pages.find((item) => item.page === page);
  const blocks = current?.blocks ?? [];
  const pageMarks = page === marksPage ? marks : undefined;
  const savedDate = document?.created_at?.slice(0, 10) || "";
  const dirty = document !== null
    && (title !== (document.title || "") || sender !== (document.sender || "") || createdAt !== savedDate);
  const pageCount = document?.page_count || 1;
  useRevealMark(stageRef, pageMarks?.length && document ? `${page}-${tab}` : null);

  useEffect(() => {
    onDirtyChange(dirty);
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, onDirtyChange]);

  return <dialog className="reader" ref={dialogRef} aria-labelledby="reader-title" onCancel={(event) => { event.preventDefault(); requestClose(); }}>
    <header className="reader__bar">
      <button type="button" className="icon-btn" aria-label="Close" autoFocus disabled={busy} onClick={requestClose}><X size={20} aria-hidden="true" /></button>
      <div className="reader__titles">
        <h2 id="reader-title" className="reader__title" title={document?.filename}>{document ? documentName(document) : loading ? "Loading the document" : "Document unavailable"}</h2>
        {document && <p className="reader__sub">{document.sender || document.filename}</p>}
      </div>
      {document && <div className="reader__controls">
        <div className="groove" role="tablist" aria-label="Document views">
          <button type="button" id="preview-tab" role="tab" className="groove__option" aria-selected={tab === "preview"} aria-controls="reader-view" onClick={() => setTab("preview")}>Page</button>
          <button type="button" id="text-tab" role="tab" className="groove__option" aria-selected={tab === "text"} aria-controls="reader-view" onClick={() => setTab("text")}>OCR text</button>
        </div>
        <div className="page-nav">
          <button type="button" className="icon-btn" aria-label="Previous page" disabled={page <= 1} onClick={() => selectPage(page - 1)}><ChevronLeft size={18} aria-hidden="true" /></button>
          <p className="page-nav__where" aria-live="polite">Page {page} of {pageCount}</p>
          <button type="button" className="icon-btn" aria-label="Next page" disabled={page >= pageCount} onClick={() => selectPage(page + 1)}><ChevronRight size={18} aria-hidden="true" /></button>
        </div>
      </div>}
    </header>

    {error && <div className="reader__alert"><Alert message={error} onDismiss={() => setError("")} /></div>}

    {!document ? <div className="reader__empty">
      {loading
        ? <p className="status-line" role="status"><Spinner /> Loading the document</p>
        : <EmptyState alert title="The document could not be loaded" action={<button type="button" className="btn" onClick={() => void load()}>Try again</button>} />}
    </div> : <div className="reader__body">
      <nav className="reader__pages" ref={railRef} aria-label="Pages">
        {pages.map((item) => <button key={item.page} type="button" className="page-thumb" aria-label={`Show page ${item.page}`} aria-pressed={item.page === page} onClick={() => selectPage(item.page)}>
          <span className="sheet sheet--page"><img className="doc-image" src={`/api/documents/${documentId}/thumbnails/${item.page}`} alt="" width={210} height={297} loading={item.page <= 4 ? "eager" : "lazy"} draggable={false} /></span>
          <span className="page-thumb__n">{item.page}</span>
        </button>)}
      </nav>

      <section className="reader__stage" id="reader-view" role="tabpanel" aria-labelledby={tab === "preview" ? "preview-tab" : "text-tab"} ref={stageRef}>
        <div className="reader__page">
          {tab === "text"
            ? <DigitalPage documentId={documentId} page={current} marks={pageMarks} />
            : <PageView document={document} page={page} blocks={blocks} marks={pageMarks} />}
        </div>
        {tab === "preview" && blocks.length > 0 && <p className="reader__hint">Drag across the page text to select and copy it.</p>}
      </section>

      <aside className="reader__info" aria-label="Document information">
        <form className="panel-section" onSubmit={save}>
          <h3>Details</h3>
          <MetadataField label="Title" ai={document.title_source === "ai"}>
            <input className="input" value={title} maxLength={500} placeholder={document.filename} onChange={(event) => { setTitle(event.target.value); setEdited(true); }} />
          </MetadataField>
          <MetadataField label="Sender" ai={document.sender_source === "ai"}>
            <input className="input" value={sender} maxLength={200} list="reader-sender-options" placeholder="Unknown sender" autoComplete="off" onChange={(event) => { setSender(event.target.value); setEdited(true); }} />
            <datalist id="reader-sender-options">{senders.map((entry) => <option key={entry} value={entry} />)}</datalist>
          </MetadataField>
          <MetadataField label="Document date" ai={document.created_at_source === "ai"}>
            <input className="input" type="date" value={createdAt} onChange={(event) => { setCreatedAt(event.target.value); setEdited(true); }} />
          </MetadataField>
          <button type="submit" className={`btn btn--block${dirty || busy ? " btn--ink" : ""}`} disabled={busy || !dirty} aria-busy={busy}>
            {busy ? <Spinner /> : dirty ? <Save size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />} {busy ? "Saving" : dirty ? "Save changes" : "Saved"}
          </button>
        </form>

        <section className="panel-section facts">
          <h3>File</h3>
          <dl>
            <div><dt>Status</dt><dd>{processing ? <StageMeter document={document} className="stage--inline" /> : stage(document).label}</dd></div>
            <div><dt>Pages</dt><dd>{document.page_count}</dd></div>
            <div><dt>Size</dt><dd>{formatBytes(document.file_size)}</dd></div>
            <div><dt>Added</dt><dd>{formatDay(document.added_at)}</dd></div>
            <div><dt>File name</dt><dd>{document.filename}</dd></div>
          </dl>
          {document.last_error && <p className="error-text">{document.last_error}</p>}
        </section>

        <section className="panel-section">
          <h3>Actions</h3>
          <div className="actions">
            <a className="action" href={`/api/documents/${documentId}/file`} download={document.filename}><Download size={16} aria-hidden="true" /> Download original</a>
            {(document.status === "READY" || document.status === "FAILED") && <>
              <button type="button" className="action" disabled={busy} onClick={() => void infer()}><Sparkles size={16} aria-hidden="true" /> Run AI metadata</button>
              <button type="button" className="action" disabled={busy} onClick={() => void retry()}><RefreshCw size={16} aria-hidden="true" /> Reprocess document</button>
            </>}
            <button type="button" className="action action--danger" disabled={busy} onClick={() => void remove()}><Trash2 size={16} aria-hidden="true" /> Delete document</button>
          </div>
        </section>
      </aside>
    </div>}
  </dialog>;
}
