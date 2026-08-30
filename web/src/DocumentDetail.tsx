import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, FileText, LoaderCircle, RefreshCw, Save, Sparkles, Trash2, X } from "lucide-react";
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
import { DocumentTitle } from "./DocumentTitle";
import { DigitalPage } from "./DigitalPage";
import { PdfViewer } from "./PdfViewer";
import { OcrTextLayer } from "./OcrTextLayer";

export function DocumentDetail({ documentId, initialPage, senders, onPageChange, onDirtyChange, onClose, onChanged }: { documentId: number; initialPage: number; senders: string[]; onPageChange: (page: number) => void; onDirtyChange: (dirty: boolean) => void; onClose: () => void; onChanged: () => void }) {
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
  const viewerRef = useRef<HTMLDivElement>(null);

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
    viewerRef.current?.scrollTo({ top: 0 });
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

  const processing = document !== null && document.status !== "READY" && document.status !== "FAILED";
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

  const current = pages.find((item) => item.page === page);
  const blocks = current?.blocks ?? [];
  const savedDate = document?.created_at?.slice(0, 10) || "";
  const dirty = document !== null
    && (title !== (document.title || "") || sender !== (document.sender || "") || createdAt !== savedDate);

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

  return <dialog className="detail-dialog" ref={dialogRef} aria-labelledby="document-detail-title" onCancel={(event) => { event.preventDefault(); requestClose(); }} onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <div className="detail-panel">
      <header className="detail-header"><div className="detail-heading"><p className="eyebrow">{document?.title ? document.filename : "Document"}</p><h2 id="document-detail-title" title={document?.filename}>{document ? <DocumentTitle document={document} /> : loading ? "Loading" : "Document unavailable"}</h2></div><button className="icon-button" aria-label="Close" autoFocus disabled={busy} onClick={requestClose}><X /></button></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button></div>}
      {!document ? <div className="empty-state">
        {loading ? <><LoaderCircle className="spin" aria-hidden="true" /><p>Loading document</p></> : <><h3>The document could not be loaded</h3><button onClick={() => void load()}>Try again</button></>}
      </div> : <>
        <div className="detail-tabs" role="tablist" aria-label="Document views"><button id="preview-tab" role="tab" aria-selected={tab === "preview"} aria-controls="document-view-panel" className={tab === "preview" ? "active" : ""} onClick={() => setTab("preview")}>Preview</button><button id="text-tab" role="tab" aria-selected={tab === "text"} aria-controls="document-view-panel" className={tab === "text" ? "active" : ""} onClick={() => setTab("text")}><FileText size={16} /> OCR text</button></div>
        <div className="detail-content">
          <section className="preview-column" id="document-view-panel" role="tabpanel" aria-labelledby={tab === "preview" ? "preview-tab" : "text-tab"}>
            <div className="document-viewer" ref={viewerRef}>
              {tab === "text" ? <DigitalPage documentId={documentId} page={current} /> : document.media_type === "pdf" ? <PdfViewer url={`/api/documents/${documentId}/file`} page={page} blocks={blocks} /> : <div className="ocr-page-frame image-page-frame"><img src={`/api/documents/${documentId}/file`} alt={document.title || document.filename} /><OcrTextLayer blocks={blocks} /></div>}
            </div>
            {tab === "preview" && blocks.length > 0 && <p className="selection-hint">Drag across the page text to select and copy it.</p>}
            <div className="page-controls"><button disabled={page <= 1} onClick={() => selectPage(page - 1)}><ChevronLeft size={17} /> Previous</button><span>Page {page} of {document.page_count || 1}</span><button disabled={page >= document.page_count} onClick={() => selectPage(page + 1)}>Next <ChevronRight size={17} /></button></div>
            <div className="thumbnail-rail">{pages.map((item) => <button key={item.page} aria-label={`Show page ${item.page}`} aria-pressed={item.page === page} className={item.page === page ? "active" : ""} onClick={() => selectPage(item.page)}><img src={`/api/documents/${documentId}/thumbnails/${item.page}`} alt="" /><span>{item.page}</span></button>)}</div>
          </section>
          <section className="metadata-column">
            <form onSubmit={save}>
              <h3>Document information</h3>
              <label><span className="metadata-label">Title{document.title_source === "ai" && <span className="ai-badge">AI</span>}</span><input value={title} maxLength={500} placeholder={document.filename} onChange={(event) => { setTitle(event.target.value); setEdited(true); }} /></label>
              <label><span className="metadata-label">Sender{document.sender_source === "ai" && <span className="ai-badge">AI</span>}</span><input value={sender} maxLength={200} list="detail-sender-options" placeholder="Unknown sender" onChange={(event) => { setSender(event.target.value); setEdited(true); }} /><datalist id="detail-sender-options">{senders.map((entry) => <option key={entry} value={entry} />)}</datalist></label>
              <label><span className="metadata-label">Document date{document.created_at_source === "ai" && <span className="ai-badge">AI</span>}</span><input type="date" value={createdAt} onChange={(event) => { setCreatedAt(event.target.value); setEdited(true); }} /></label>
              <button className="primary-button" disabled={busy || !dirty}><Save size={17} /> {busy ? "Saving" : dirty ? "Save changes" : "Saved"}</button>
            </form>
            <div className="document-facts"><h3>Processing</h3><dl><div><dt>Status</dt><dd><span className={`status status-${document.status.toLowerCase()}`}>{document.status.toLowerCase().replaceAll("_", " ")}</span></dd></div><div><dt>Pages</dt><dd className="mono">{document.page_count}</dd></div><div><dt>Added</dt><dd className="mono">{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(document.added_at))}</dd></div></dl>{document.last_error && <p className="card-error">{document.last_error}</p>}<a className="fact-action" href={`/api/documents/${documentId}/file`} download={document.filename}><Download size={16} /> Download original</a>{(document.status === "READY" || document.status === "FAILED") && <><button disabled={busy} onClick={() => void infer()}><Sparkles size={16} /> Run AI metadata</button><button disabled={busy} onClick={() => void retry()}><RefreshCw size={16} /> Reprocess document</button></>}</div>
            <button className="danger-button" disabled={busy} onClick={() => void remove()}><Trash2 size={17} /> Delete document</button>
          </section>
        </div>
      </>}
    </div>
  </dialog>;
}
