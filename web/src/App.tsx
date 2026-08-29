import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileSearch,
  Grid2X2,
  List,
  LoaderCircle,
  Search,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import {
  getHealth,
  getSenders,
  listDocuments,
  searchDocuments,
  uploadDocument,
  type Document,
  type DocumentPageResult,
  type HealthResponse,
  type SearchHit,
} from "./api";
import { DocumentDetail } from "./DocumentDetail";
import { DocumentCard, FilterPanel, initialQuery } from "./library";

export default function App() {
  const [query, setQuery] = useState(initialQuery);
  const [library, setLibrary] = useState<DocumentPageResult | null>(null);
  const [senders, setSenders] = useState<string[]>([]);
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
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    void Promise.all([getSenders(), getHealth()])
      .then(([nextSenders, nextHealth]) => {
        setSenders(nextSenders);
        setHealth(nextHealth);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Health data failed to load."));
  }, [query]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);



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
        sender: query.sender || null,
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
      if (event.key === "Escape") {
        if (selected) setSelected(null);
        else if (searchHits) clearSearch();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, searchHits]);

  function clearSearch() {
    setSearchHits(null);
    setSearchText("");
  }

  function openDocument(document: Document) {
    const hit = searchHits?.find((candidate) => candidate.document.document_id === document.document_id);
    setSelected({ id: document.document_id, page: hit?.page ?? 1 });
  }

  function filterBySender(sender: string) {
    setQuery((value) => ({ ...value, sender, page: 1 }));
    setSearchHits(null);
  }

  const nothingFiled = !searchHits && library?.total === 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Paperless</span>
          <span className="brand-agx">AGX</span>
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
        {health && !(health.ocr_configured && health.embedding_configured) && (
          <div className="health-pill" title={`OCR: ${health.ocr_model}\nEmbeddings: ${health.embedding_model}`}>
            <span className="health-dot" />
            Models not ready
          </div>
        )}
      </header>

      <main>
        {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button></div>}

        <section className="library-toolbar">
          <div>
            <h2>{searchHits ? "Search results" : "Library"}</h2>
            <span className="toolbar-count">
              {searchHits
                ? <>“{searchText.trim()}” · {searchHits.length} {searchHits.length === 1 ? "document" : "documents"}</>
                : library && <>{library.total} {library.total === 1 ? "document" : "documents"}</>}
            </span>
          </div>
          <div className="toolbar-actions">
            <button className="upload-button" onClick={() => fileInputRef.current?.click()}><Upload size={16} /> Upload</button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept="application/pdf,image/png,image/jpeg,image/tiff,image/webp"
              onChange={(event) => {
                if (event.target.files) void upload(event.target.files);
                event.target.value = "";
              }}
            />
            <button className={filtersOpen ? "active" : ""} onClick={() => setFiltersOpen((value) => !value)}><SlidersHorizontal size={16} /> Filters</button>
            <div className="segmented">
              <button aria-label="Grid view" className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}><Grid2X2 size={16} /></button>
              <button aria-label="List view" className={view === "list" ? "active" : ""} onClick={() => setView("list")}><List size={17} /></button>
            </div>
          </div>
        </section>

        {filtersOpen && <FilterPanel query={query} senders={senders} onChange={(next) => { setQuery({ ...next, page: 1 }); setSearchHits(null); }} />}
        {loading && !library ? (
          <div className="empty-state"><LoaderCircle className="spin" aria-hidden="true" /><p>Loading your documents</p></div>
        ) : !library ? (
          <div className="empty-state">
            <h3>The library could not be loaded</h3>
            <p>Check that the Paperless AGX server is running, then try again.</p>
            <button onClick={() => void refresh()}>Try again</button>
          </div>
        ) : nothingFiled ? (
          <div className="empty-state">
            <FileSearch size={36} aria-hidden="true" />
            <h3>No documents yet</h3>
            <p>Drop files anywhere on this page, or use the Upload button. PDF, PNG, JPEG, TIFF and WebP are processed on this machine.</p>
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
                onFilterSender={filterBySender}
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

      {selected && <DocumentDetail documentId={selected.id} initialPage={selected.page} senders={senders} onClose={() => setSelected(null)} onChanged={() => { void refresh(); }} />}
    </div>
  );
}

