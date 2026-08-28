import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export default function App() {
  const [query, setQuery] = useState(initialQuery);
  const [library, setLibrary] = useState<DocumentPageResult | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [selected, setSelected] = useState<{ id: number; page: number } | null>(null);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dropping, setDropping] = useState(false);
  const [error, setError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const uploadRef = useRef<(files: FileList | File[]) => Promise<void>>(async () => {});

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

  const shownDocuments = searchHits?.map((hit) => hit.document) ?? library?.items ?? [];
  const terms = useMemo(() => searchText.trim().split(/\s+/).filter(Boolean), [searchText]);

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
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      try {
        await uploadDocument(file);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "upload failed";
        failures.push(`${file.name} — ${message}`);
      }
    }
    if (failures.length > 0) setError(`Upload failed — ${failures.join("; ")}`);
    await refresh();
  }
  uploadRef.current = upload;

  useEffect(() => {
    function onDragEnter(event: DragEvent) {
      if (event.dataTransfer?.types.includes("Files")) {
        dragDepth.current += 1;
        setDropping(true);
      }
    }
    function onDragLeave() {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDropping(false);
    }
    function onDragOver(event: DragEvent) {
      event.preventDefault();
    }
    function onDrop(event: DragEvent) {
      event.preventDefault();
      dragDepth.current = 0;
      setDropping(false);
      if (event.dataTransfer?.files.length) void uploadRef.current?.(event.dataTransfer.files);
    }
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement;
        if (target.matches("input, textarea, select") || target.isContentEditable) return;
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && selected) setSelected(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected]);

  function clearSearch() {
    setSearchHits(null);
    setSearchText("");
  }

  function openDocument(document: Document) {
    const hit = searchHits?.find((candidate) => candidate.document.document_id === document.document_id);
    setSelected({ id: document.document_id, page: hit?.page ?? 1 });
  }

  const nothingFiled = !searchHits && library?.total === 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">P</span>
          <span className="brand-name">Paperless</span>
          <span className="brand-chip">AGX</span>
        </div>
        <form className="global-search" onSubmit={runSearch}>
          <Search size={18} aria-hidden="true" />
          <input
            ref={searchRef}
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Search documents"
            aria-label="Search documents"
          />
          {searchHits ? (
            <button type="button" className="clear-search" onClick={clearSearch}><X size={15} /> Clear</button>
          ) : (
            <kbd className="search-key">/</kbd>
          )}
        </form>
        <div className="health-pill" title={health ? `OCR: ${health.ocr_model}\nEmbeddings: ${health.embedding_model}` : "Loading model status"}>
          <span className={health?.ocr_configured && health?.embedding_configured ? "health-dot good" : "health-dot"} />
          {health?.ocr_configured && health?.embedding_configured ? "Models ready" : "Models not ready"}
        </div>
      </header>

      <main>
        <section className="intake" aria-label="Upload documents">
          <label
            className="upload-drop"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files); }}
          >
            <UploadCloud size={20} aria-hidden="true" />
            <span>Drop files here or click to browse</span>
            <small>PDF, PNG, JPEG, TIFF, WebP — processed on this machine</small>
            <input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/tiff,image/webp" onChange={(event) => event.target.files && void upload(event.target.files)} />
          </label>
        </section>

        {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button></div>}

        <section className="library-toolbar">
          <div>
            <h2>{searchHits ? "Search results" : "Library"}</h2>
            <span className="toolbar-count">
              {searchHits
                ? <>“{searchText.trim()}” · {searchHits.length} {searchHits.length === 1 ? "document" : "documents"}</>
                : <>{library?.total ?? 0} {library?.total === 1 ? "document" : "documents"}</>}
            </span>
          </div>
          <div className="toolbar-actions">
            <button className={filtersOpen ? "active" : ""} onClick={() => setFiltersOpen((value) => !value)}><SlidersHorizontal size={16} /> Filters</button>
            <div className="segmented">
              <button aria-label="Grid view" className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}><Grid2X2 size={16} /></button>
              <button aria-label="List view" className={view === "list" ? "active" : ""} onClick={() => setView("list")}><List size={17} /></button>
            </div>
          </div>
        </section>

        {filtersOpen && <FilterPanel query={query} types={types} onChange={(next) => { setQuery({ ...next, page: 1 }); setSearchHits(null); }} />}

        {loading && !library ? (
          <div className="empty-state"><LoaderCircle className="spin" aria-hidden="true" /><p>Loading your documents</p></div>
        ) : nothingFiled ? (
          <div className="empty-state">
            <FileSearch size={36} aria-hidden="true" />
            <h3>No documents yet</h3>
            <p>Upload a PDF or an image to get started, or drag files anywhere on this page.</p>
          </div>
        ) : shownDocuments.length === 0 ? (
          <div className="empty-state">
            <FileSearch size={36} aria-hidden="true" />
            <h3>No matches</h3>
            <p>Try different words, or clear the filters to search the whole library.</p>
          </div>
        ) : (
          <div className={`document-collection ${view}`}>
            {shownDocuments.map((document) => (
              <DocumentCard
                key={document.document_id}
                document={document}
                hit={searchHits?.find((item) => item.document.document_id === document.document_id)}
                terms={searchHits ? terms : []}
                onOpen={() => openDocument(document)}
              />
            ))}
          </div>
        )}

        {!searchHits && library && library.total > query.pageSize && (
          <nav className="pagination" aria-label="Document pages">
            <button disabled={query.page === 1} onClick={() => setQuery((value) => ({ ...value, page: value.page - 1 }))}>Previous</button>
            <span>Page {query.page} of {Math.ceil(library.total / query.pageSize)}</span>
            <button disabled={query.page * query.pageSize >= library.total} onClick={() => setQuery((value) => ({ ...value, page: value.page + 1 }))}>Next</button>
          </nav>
        )}
      </main>

      {dropping && <div className="drop-overlay" aria-hidden="true"><p><strong>Drop to upload</strong></p></div>}

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function Marked({ text, terms }: { text: string; terms: string[] }) {
  const clean = terms.filter((term) => term.length > 0);
  if (clean.length === 0) return <>{text}</>;
  let pattern: RegExp;
  try {
    pattern = new RegExp(`(${clean.map(escapeRegExp).join("|")})`, "giu");
  } catch {
    return <>{text}</>;
  }
  const parts = text.split(pattern);
  return <>{parts.map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>))}</>;
}

function DocumentCard({ document, hit, terms, onOpen }: { document: Document; hit?: SearchHit; terms: string[]; onOpen: () => void }) {
  const date = document.created_at || document.added_at;
  return <button className="document-card" onClick={onOpen}>
    <div className="thumbnail-wrap"><img src={`/api/documents/${document.document_id}/thumbnails/1`} alt="" loading="lazy" /><span className={`status status-${document.status.toLowerCase()}`}>{document.status.toLowerCase().replaceAll("_", " ")}</span></div>
    <div className="card-body">
      <div className="card-title-row"><h3>{document.title || document.filename}</h3><span className="card-size">{formatBytes(document.file_size)}</span></div>
      <p className="card-meta">{document.document_type || "Unclassified"} · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(date))}</p>
      {hit && <p className="snippet"><Marked text={hit.snippet} terms={terms} /></p>}
      {document.last_error && <p className="card-error">{document.last_error}</p>}
    </div>
  </button>;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}
