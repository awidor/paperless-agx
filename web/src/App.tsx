import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FileSearch,
  Grid2X2,
  List,
  LoaderCircle,
  Search,
  SlidersHorizontal,
  UploadCloud,
  X,
} from "lucide-react";
import {
  getDocumentTypes,
  getHealth,
  listDocuments,
  searchDocuments,
  uploadDocument,
  type Document,
  type DocumentPageResult,
  type DocumentSort,
  type HealthResponse,
  type LibraryQuery,
  type SearchHit,
} from "./api";
import { DocumentDetail } from "./DocumentDetail";

const initialQuery: LibraryQuery = {
  page: 1,
  pageSize: 24,
  documentType: "",
  createdFrom: "",
  createdTo: "",
  sort: "document_date_desc",
};

type UploadItem = { name: string; state: "uploading" | "queued" | "failed"; error?: string };

export default function App() {
  const [query, setQuery] = useState(initialQuery);
  const [library, setLibrary] = useState<DocumentPageResult | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [selected, setSelected] = useState<{ id: number; page: number } | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const result = await listDocuments(query);
      setLibrary(result);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The document library failed to load.");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    void Promise.all([getDocumentTypes(), getHealth()])
      .then(([nextTypes, nextHealth]) => {
        setTypes(nextTypes);
        setHealth(nextHealth);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Health data failed to load."));
  }, [library?.total]);

  const processing = useMemo(
    () => library?.items.filter((document) => document.status !== "READY" && document.status !== "FAILED") ?? [],
    [library],
  );
  const shownDocuments = searchHits?.map((hit) => hit.document) ?? library?.items ?? [];

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    const value = searchText.trim();
    if (!value) {
      setSearchHits(null);
      return;
    }
    setLoading(true);
    try {
      const result = await searchDocuments({
        query: value,
        page: 1,
        page_size: 100,
        document_type: query.documentType || null,
        created_from: query.createdFrom ? new Date(`${query.createdFrom}T00:00:00`).toISOString() : null,
        created_to: query.createdTo ? new Date(`${query.createdTo}T23:59:59`).toISOString() : null,
      });
      setSearchHits(result.items);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  async function upload(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      setUploads((items) => [...items, { name: file.name, state: "uploading" }]);
      try {
        await uploadDocument(file);
        setUploads((items) => items.map((item) => item.name === file.name ? { ...item, state: "queued" } : item));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Upload failed.";
        setUploads((items) => items.map((item) => item.name === file.name ? { ...item, state: "failed", error: message } : item));
      }
    }
    await refresh();
  }

  function openDocument(document: Document) {
    const hit = searchHits?.find((candidate) => candidate.document.document_id === document.document_id);
    setSelected({ id: document.document_id, page: hit?.page ?? 1 });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">P</span><span>Paperless AGX</span></div>
        <form className="global-search" onSubmit={runSearch}>
          <Search size={19} aria-hidden="true" />
          <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search every document" aria-label="Search documents" />
          {searchHits && <button type="button" className="clear-search" onClick={() => { setSearchHits(null); setSearchText(""); }}><X size={17} /> Clear</button>}
        </form>
        <div className="health-pill" title={health ? `OCR: ${health.ocr_model}\nEmbeddings: ${health.embedding_model}` : "Loading model status"}>
          <span className={health?.ocr_configured && health?.embedding_configured ? "health-dot good" : "health-dot"} />
          {health?.ocr_configured && health?.embedding_configured ? "Models ready" : "Check models"}
        </div>
      </header>

      <main>
        <section className="hero-panel">
          <div>
            <p className="eyebrow">Your private document workspace</p>
            <h1>{searchHits ? `${searchHits.length} search matches` : "Documents, ready when you need them"}</h1>
            <p className="hero-copy">Upload scans and PDFs. Paperless AGX reads, organizes, and makes them searchable on this machine.</p>
          </div>
          <label
            className="upload-drop"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files); }}
          >
            <UploadCloud size={24} />
            <span>Drop files or choose</span>
            <small>PDF, PNG, JPEG, TIFF, or WebP</small>
            <input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/tiff,image/webp" onChange={(event) => event.target.files && void upload(event.target.files)} />
          </label>
        </section>

        {(uploads.length > 0 || processing.length > 0) && (
          <section className="queue-strip" aria-label="Processing queue">
            <div className="queue-title"><LoaderCircle className="spin" size={18} /> Processing queue</div>
            <div className="queue-items">
              {uploads.slice(-3).map((item, index) => <span className={`queue-item ${item.state}`} key={`${item.name}-${index}`}>{item.name} · {item.state}</span>)}
              {processing.map((document) => <span className="queue-item" key={document.document_id}>{document.title || document.filename} · {document.status.toLowerCase().replaceAll("_", " ")}</span>)}
            </div>
          </section>
        )}

        {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")}><X size={17} /></button></div>}

        <section className="library-toolbar">
          <div><h2>{searchHits ? "Search results" : "Library"}</h2><span>{searchHits ? searchHits.length : library?.total ?? 0} documents</span></div>
          <div className="toolbar-actions">
            <button className={filtersOpen ? "active" : ""} onClick={() => setFiltersOpen((value) => !value)}><SlidersHorizontal size={17} /> Filters</button>
            <div className="segmented"><button aria-label="Grid view" className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}><Grid2X2 size={17} /></button><button aria-label="List view" className={view === "list" ? "active" : ""} onClick={() => setView("list")}><List size={18} /></button></div>
          </div>
        </section>

        {filtersOpen && <FilterPanel query={query} types={types} onChange={(next) => { setQuery({ ...next, page: 1 }); setSearchHits(null); }} />}

        {loading && !library ? <div className="empty-state"><LoaderCircle className="spin" /><p>Loading your documents</p></div> : shownDocuments.length === 0 ? (
          <div className="empty-state"><FileSearch size={40} /><h3>No documents here</h3><p>Upload a file or change the current filters.</p></div>
        ) : (
          <div className={`document-collection ${view}`}>
            {shownDocuments.map((document) => <DocumentCard key={document.document_id} document={document} hit={searchHits?.find((item) => item.document.document_id === document.document_id)} onOpen={() => openDocument(document)} />)}
          </div>
        )}

        {!searchHits && library && library.total > query.pageSize && <nav className="pagination" aria-label="Document pages"><button disabled={query.page === 1} onClick={() => setQuery((value) => ({ ...value, page: value.page - 1 }))}>Previous</button><span>Page {query.page} of {Math.ceil(library.total / query.pageSize)}</span><button disabled={query.page * query.pageSize >= library.total} onClick={() => setQuery((value) => ({ ...value, page: value.page + 1 }))}>Next</button></nav>}
      </main>

      {selected && <DocumentDetail documentId={selected.id} initialPage={selected.page} types={types} onClose={() => setSelected(null)} onChanged={() => { void refresh(); void getDocumentTypes().then(setTypes); }} />}
    </div>
  );
}

function FilterPanel({ query, types, onChange }: { query: LibraryQuery; types: string[]; onChange: (query: LibraryQuery) => void }) {
  return <section className="filter-panel">
    <label>Document type<select value={query.documentType} onChange={(event) => onChange({ ...query, documentType: event.target.value })}><option value="">All types</option>{types.map((type) => <option key={type}>{type}</option>)}</select></label>
    <label>From<input type="date" value={query.createdFrom} onChange={(event) => onChange({ ...query, createdFrom: event.target.value })} /></label>
    <label>To<input type="date" value={query.createdTo} onChange={(event) => onChange({ ...query, createdTo: event.target.value })} /></label>
    <label>Sort<select value={query.sort} onChange={(event) => onChange({ ...query, sort: event.target.value as DocumentSort })}><option value="document_date_desc">Document date · newest</option><option value="document_date_asc">Document date · oldest</option><option value="added_date_desc">Added · newest</option><option value="added_date_asc">Added · oldest</option><option value="title_asc">Title · A–Z</option><option value="title_desc">Title · Z–A</option><option value="file_size_desc">File size · largest</option><option value="file_size_asc">File size · smallest</option></select></label>
    <button className="text-button" onClick={() => onChange(initialQuery)}>Reset filters</button>
  </section>;
}

function DocumentCard({ document, hit, onOpen }: { document: Document; hit?: SearchHit; onOpen: () => void }) {
  const date = document.created_at || document.added_at;
  return <button className="document-card" onClick={onOpen}>
    <div className="thumbnail-wrap"><img src={`/api/documents/${document.document_id}/thumbnails/1`} alt="" loading="lazy" /><span className={`status status-${document.status.toLowerCase()}`}>{document.status.toLowerCase().replaceAll("_", " ")}</span></div>
    <div className="card-body"><div className="card-title-row"><h3>{document.title || document.filename}</h3><span>{formatBytes(document.file_size)}</span></div><p className="card-meta">{document.document_type || "Unclassified"} · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(date))}</p>{hit && <p className="snippet">{hit.snippet}</p>}{document.last_error && <p className="card-error">{document.last_error}</p>}</div>
  </button>;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}
