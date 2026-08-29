import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, RefreshCw, Save, Sparkles, Trash2, X } from "lucide-react";
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
import { PdfViewer } from "./PdfViewer";
import { OcrTextLayer } from "./OcrTextLayer";

export function DocumentDetail({ documentId, initialPage, senders, onClose, onChanged }: { documentId: number; initialPage: number; senders: string[]; onClose: () => void; onChanged: () => void }) {
  const [document, setDocument] = useState<Document | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [page, setPage] = useState(initialPage);
  const [tab, setTab] = useState<"preview" | "text">("preview");
  const [title, setTitle] = useState("");
  const [sender, setSender] = useState("");
  const [createdAt, setCreatedAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const railRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPage(initialPage);
  }, []);

  useEffect(() => {
    viewerRef.current?.scrollTo({ top: 0 });
  }, [page, tab]);

  async function load() {
    try {
      const [nextDocument, nextPages] = await Promise.all([getDocument(documentId), getPages(documentId)]);
      setDocument(nextDocument);
      setPages(nextPages);
      setPage((value) => Math.min(Math.max(value, 1), nextDocument.page_count || 1));
      setTitle(nextDocument.title || "");
      setSender(nextDocument.sender || "");
      setCreatedAt(nextDocument.created_at?.slice(0, 10) || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The document failed to load.");
    }
  }

  useEffect(() => { void load(); }, [documentId]);

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
      setError("");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "AI metadata failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Delete this document and its indexed data? This action cannot be undone.")) return;
    setBusy(true);
    try {
      await deleteDocument(documentId);
      onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Deletion failed.");
      setBusy(false);
    }
  }

  const current = pages.find((item) => item.page === page);
  const blocks = current?.blocks ?? [];
  const savedDate = document?.created_at?.slice(0, 10) || "";
  const dirty = document !== null
    && (title !== (document.title || "") || sender !== (document.sender || "") || createdAt !== savedDate);
  return <div className="detail-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="detail-panel" aria-label="Document detail">
      <header className="detail-header"><div className="detail-heading"><p className="eyebrow">{document?.title ? document.filename : "Document"}</p><h2 title={document?.filename}>{document ? <DocumentTitle document={document} /> : "Loading"}</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><X /></button></header>
      {error && <div className="error-banner">{error}</div>}
      {!document ? <div className="empty-state">Loading document</div> : <>
        <div className="detail-tabs"><button className={tab === "preview" ? "active" : ""} onClick={() => setTab("preview")}>Preview</button><button className={tab === "text" ? "active" : ""} onClick={() => setTab("text")}><FileText size={16} /> OCR text</button></div>
        <div className="detail-content">
          <section className="preview-column">
            <div className="document-viewer" ref={viewerRef}>
              {tab === "text" ? <article className="ocr-text">{current?.text || "Text is not ready for this page."}</article> : document.media_type === "pdf" ? <PdfViewer url={`/api/documents/${documentId}/file`} page={page} blocks={blocks} /> : <div className="ocr-page-frame image-page-frame"><img src={`/api/documents/${documentId}/file`} alt={document.title || document.filename} /><OcrTextLayer blocks={blocks} /></div>}
            </div>
            {tab === "preview" && blocks.length > 0 && <p className="selection-hint">Drag across the page text to select and copy it.</p>}
            <div className="page-controls"><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={17} /> Previous</button><span>Page {page} of {document.page_count || 1}</span><button disabled={page >= document.page_count} onClick={() => setPage((value) => value + 1)}>Next <ChevronRight size={17} /></button></div>
            <div className="thumbnail-rail" ref={railRef}>{pages.map((item) => <button key={item.page} className={item.page === page ? "active" : ""} onClick={() => setPage(item.page)}><img src={`/api/documents/${documentId}/thumbnails/${item.page}`} alt={`Page ${item.page}`} /><span>{item.page}</span></button>)}</div>
          </section>
          <section className="metadata-column">
            <form onSubmit={save}>
              <h3>Document information</h3>
              <label><span className="metadata-label">Title{document.title_source === "ai" && <span className="ai-badge">AI</span>}</span><input value={title} maxLength={500} placeholder={document.filename} onChange={(event) => setTitle(event.target.value)} /></label>
              <label><span className="metadata-label">Sender{document.sender_source === "ai" && <span className="ai-badge">AI</span>}</span><input value={sender} maxLength={200} list="sender-options" placeholder="Unknown sender" onChange={(event) => setSender(event.target.value)} /><datalist id="sender-options">{senders.map((entry) => <option key={entry} value={entry} />)}</datalist></label>
              <label><span className="metadata-label">Document date{document.created_at_source === "ai" && <span className="ai-badge">AI</span>}</span><input type="date" value={createdAt} onChange={(event) => setCreatedAt(event.target.value)} /></label>
              <button className="primary-button" disabled={busy || !dirty}><Save size={17} /> {busy ? "Saving" : dirty ? "Save changes" : "Saved"}</button>
            </form>
            <div className="document-facts"><h3>Processing</h3><dl><div><dt>Status</dt><dd><span className={`status status-${document.status.toLowerCase()}`}>{document.status.toLowerCase().replaceAll("_", " ")}</span></dd></div><div><dt>Pages</dt><dd className="mono">{document.page_count}</dd></div><div><dt>Added</dt><dd className="mono">{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(document.added_at))}</dd></div></dl>{document.last_error && <p className="card-error">{document.last_error}</p>}{(document.status === "READY" || document.status === "FAILED") && <><button disabled={busy} onClick={() => void infer()}><Sparkles size={16} /> Run AI metadata</button><button disabled={busy} onClick={() => void retry()}><RefreshCw size={16} /> Reprocess document</button></>}</div>
            <button className="danger-button" disabled={busy} onClick={() => void remove()}><Trash2 size={17} /> Delete document</button>
          </section>
        </div>
      </>}
    </aside>
  </div>;
}
