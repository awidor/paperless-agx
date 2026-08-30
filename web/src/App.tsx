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
  type DocumentSort,
  type HealthResponse,
  type LibraryQuery,
  type SearchInterpretation,
} from "./api";
import { DocumentDetail } from "./DocumentDetail";
import { DocumentCard, FilterPanel, initialQuery } from "./library";
import { SearchWorkspace, type SearchResult } from "./SearchWorkspace";

type View = "grid" | "list";
type UploadState = {
  active: boolean;
  total: number;
  completed: number;
  current: string;
  uploaded: number;
  duplicates: number;
  failures: string[];
};
type UrlState = {
  query: LibraryQuery;
  search: string;
  view: View;
  selected: { id: number; page: number; highlight?: string; highlightPage?: number } | null;
};

const SORTS = new Set<DocumentSort>([
  "document_date_desc",
  "document_date_asc",
  "added_date_desc",
  "added_date_asc",
  "title_asc",
  "title_desc",
  "sender_asc",
  "sender_desc",
  "file_size_asc",
  "file_size_desc",
]);

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function dateValue(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00`);
  const [year, month, day] = value.split("-").map(Number);
  return date.getFullYear() === year && date.getMonth() + 1 === month && date.getDate() === day ? value : "";
}

function readUrlState(): UrlState {
  const params = new URLSearchParams(window.location.search);
  const sort = params.get("sort") as DocumentSort | null;
  const documentId = positiveInteger(params.get("document"), 0);
  return {
    query: {
      ...initialQuery,
      page: positiveInteger(params.get("page"), 1),
      sender: params.get("sender") || "",
      createdFrom: dateValue(params.get("from")),
      createdTo: dateValue(params.get("to")),
      sort: sort && SORTS.has(sort) ? sort : initialQuery.sort,
    },
    search: params.get("q")?.trim() || "",
    view: params.get("view") === "list" ? "list" : "grid",
    selected: documentId
      ? { id: documentId, page: positiveInteger(params.get("document_page"), 1) }
      : null,
  };
}

function matchesInterpretation(document: Document, interpretation: SearchInterpretation): boolean {
  if (interpretation.sender && document.sender !== interpretation.sender) return false;
  const timestamp = Date.parse(document.created_at || document.added_at);
  const from = interpretation.created_from ? Date.parse(interpretation.created_from) : Number.NaN;
  const to = interpretation.created_to ? Date.parse(interpretation.created_to) : Number.NaN;
  return (Number.isNaN(from) || timestamp >= from) && (Number.isNaN(to) || timestamp <= to);
}

function shortDate(value: string | null | undefined): string {
  return value?.slice(0, 10) ?? "";
}

export default function App() {
  const initial = useRef(readUrlState()).current;
  const [query, setQuery] = useState(initial.query);
  const [library, setLibrary] = useState<DocumentPageResult | null>(null);
  const [senders, setSenders] = useState<string[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [searchText, setSearchText] = useState(initial.search);
  const [activeSearch, setActiveSearch] = useState(initial.search);
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searchInterpretation, setSearchInterpretation] = useState<SearchInterpretation | null>(null);
  const [skipInferredSender, setSkipInferredSender] = useState(false);
  const [skipInferredDates, setSkipInferredDates] = useState(false);
  const [searchLimited, setSearchLimited] = useState(false);
  const [selected, setSelected] = useState(initial.selected);
  const [view, setView] = useState<View>(initial.view);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const [libraryError, setLibraryError] = useState("");
  const [searchError, setSearchError] = useState("");
  const [contextError, setContextError] = useState("");
  const [dataVersion, setDataVersion] = useState(0);
  const [searchVersion, setSearchVersion] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const uploadingRef = useRef(false);
  const openedFromUi = useRef(false);
  const detailDirty = useRef(false);
  const restoringHistory = useRef(false);
  const uploadRef = useRef<(files: FileList | File[]) => Promise<void>>(async () => {});

  const searching = activeSearch.length > 0;
  const uploading = uploadState?.active ?? false;
  const error = searchError || libraryError || contextError;

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await listDocuments(query));
      setLibraryError("");
    } catch (cause) {
      setLibraryError(cause instanceof Error ? cause.message : "The document library failed to load.");
    } finally {
      setInitialLoading(false);
    }
  }, [query]);

  const refreshContext = useCallback(async () => {
    try {
      const [nextSenders, nextHealth] = await Promise.all([getSenders(), getHealth()]);
      setSenders(nextSenders);
      setHealth(nextHealth);
      setContextError("");
    } catch (cause) {
      setContextError(cause instanceof Error ? cause.message : "Service status failed to load.");
    }
  }, []);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary, dataVersion]);

  useEffect(() => {
    void refreshContext();
  }, [refreshContext, dataVersion]);

  const hasProcessingDocuments = library?.items.some(
    (document) => document.status !== "READY" && document.status !== "FAILED",
  ) ?? false;

  useEffect(() => {
    if (!hasProcessingDocuments) return;
    const timer = window.setInterval(() => void refreshLibrary(), 2_000);
    return () => window.clearInterval(timer);
  }, [hasProcessingDocuments, refreshLibrary]);

  useEffect(() => {
    if (!searching) {
      setSearchResults(null);
      setSearchInterpretation(null);
      setSearchLimited(false);
      setSearchError("");
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    setSearchError("");
    void Promise.all([
      searchDocuments({
        query: activeSearch,
        page: 1,
        page_size: 100,
        sender: query.sender || null,
        created_from: query.createdFrom ? new Date(`${query.createdFrom}T00:00:00`).toISOString() : null,
        created_to: query.createdTo ? new Date(`${query.createdTo}T23:59:59`).toISOString() : null,
        skip_inferred_sender: skipInferredSender,
        skip_inferred_dates: skipInferredDates,
      }),
      listDocuments({ ...query, page: 1, pageSize: 100, metadataQuery: activeSearch }),
    ])
      .then(([content, metadata]) => {
        if (cancelled) return;
        const seen = new Set<number>();
        const results: SearchResult[] = content.items.map((hit) => {
          seen.add(hit.document.document_id);
          return { document: hit.document, hit };
        });
        for (const document of metadata.items) {
          if (!seen.has(document.document_id) && matchesInterpretation(document, content.interpretation)) {
            seen.add(document.document_id);
            results.push({ document });
          }
        }
        setSearchResults(results);
        setSearchInterpretation(content.interpretation);
        setSearchLimited(content.total > content.items.length || metadata.total > metadata.items.length);
      })
      .catch((cause) => {
        if (!cancelled) setSearchError(cause instanceof Error ? cause.message : "Search failed.");
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSearch, dataVersion, query.createdFrom, query.createdTo, query.sender, query.sort, searchVersion, searching, skipInferredDates, skipInferredSender]);

  const hasProcessingSearchResults = searchResults?.some(
    ({ document }) => document.status !== "READY" && document.status !== "FAILED",
  ) ?? false;

  useEffect(() => {
    if (!hasProcessingSearchResults) return;
    const timer = window.setInterval(() => setSearchVersion((version) => version + 1), 2_000);
    return () => window.clearInterval(timer);
  }, [hasProcessingSearchResults]);

  useEffect(() => {
    const url = new URL(window.location.href);
    for (const key of ["q", "page", "sender", "from", "to", "sort", "view", "document", "document_page"]) {
      url.searchParams.delete(key);
    }
    if (activeSearch) url.searchParams.set("q", activeSearch);
    if (query.page > 1) url.searchParams.set("page", String(query.page));
    if (query.sender) url.searchParams.set("sender", query.sender);
    if (query.createdFrom) url.searchParams.set("from", query.createdFrom);
    if (query.createdTo) url.searchParams.set("to", query.createdTo);
    if (query.sort !== initialQuery.sort) url.searchParams.set("sort", query.sort);
    if (view !== "grid") url.searchParams.set("view", view);
    if (selected) {
      url.searchParams.set("document", String(selected.id));
      if (selected.page > 1) url.searchParams.set("document_page", String(selected.page));
    }
    window.history.replaceState(null, "", url);
  }, [activeSearch, query, selected, view]);

  useEffect(() => {
    function onPopState() {
      if (restoringHistory.current) {
        restoringHistory.current = false;
        return;
      }
      if (selected && detailDirty.current && !window.confirm("Discard your unsaved document changes?")) {
        restoringHistory.current = true;
        window.history.forward();
        return;
      }
      const next = readUrlState();
      const searchChanged = next.search !== activeSearch;
      openedFromUi.current = false;
      detailDirty.current = false;
      setQuery(next.query);
      setSearchText(next.search);
      setActiveSearch(next.search);
      if (searchChanged) {
        setSearchResults(null);
        setSearchInterpretation(null);
        setSkipInferredSender(false);
        setSkipInferredDates(false);
      }
      setView(next.view);
      setSelected(next.selected);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [activeSearch, selected]);

  const shownDocuments = searching
    ? searchResults?.map((result) => result.document) ?? []
    : library?.items ?? [];
  const terms = useMemo(() => activeSearch.split(/\s+/).filter(Boolean), [activeSearch]);

  function checkpointHistory() {
    window.history.pushState(null, "", window.location.href);
  }

  function runSearch(event: React.FormEvent) {
    event.preventDefault();
    const value = searchText.trim();
    if (!value) {
      clearSearch();
      return;
    }
    if (value !== activeSearch) checkpointHistory();
    else setSearchVersion((version) => version + 1);
    if (value !== activeSearch) setSearchResults(null);
    setSearchInterpretation(null);
    setSkipInferredSender(false);
    setSkipInferredDates(false);
    setActiveSearch(value);
  }

  function clearSearch() {
    if (activeSearch) checkpointHistory();
    setActiveSearch("");
    setSearchText("");
    setSearchResults(null);
    setSearchInterpretation(null);
    setSkipInferredSender(false);
    setSkipInferredDates(false);
    setSearchError("");
  }

  async function upload(files: FileList | File[]) {
    const pending = Array.from(files);
    if (pending.length === 0 || uploadingRef.current) return;
    uploadingRef.current = true;
    const failures: string[] = [];
    let uploaded = 0;
    let duplicates = 0;
    setUploadState({ active: true, total: pending.length, completed: 0, current: pending[0].name, uploaded, duplicates, failures });
    for (const [index, file] of pending.entries()) {
      setUploadState({ active: true, total: pending.length, completed: index, current: file.name, uploaded, duplicates, failures: [...failures] });
      try {
        const result = await uploadDocument(file);
        if (result.duplicate) duplicates += 1;
        else uploaded += 1;
      } catch (cause) {
        failures.push(`${file.name} — ${cause instanceof Error ? cause.message : "upload failed"}`);
      }
    }
    uploadingRef.current = false;
    setUploadState({ active: false, total: pending.length, completed: pending.length, current: "", uploaded, duplicates, failures });
    setDataVersion((version) => version + 1);
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
      if (event.dataTransfer?.files.length) void uploadRef.current(event.dataTransfer.files);
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

  function updateQuery(next: LibraryQuery) {
    if (searching) setSearchResults(null);
    setQuery({ ...next, page: 1 });
  }

  function openDocument(document: Document, page = 1, highlight?: string) {
    checkpointHistory();
    openedFromUi.current = true;
    detailDirty.current = false;
    setSelected({ id: document.document_id, page, highlight, highlightPage: highlight ? page : undefined });
  }

  function closeDocument() {
    if (openedFromUi.current) {
      openedFromUi.current = false;
      window.history.back();
    } else {
      setSelected(null);
    }
  }

  function filterBySender(sender: string) {
    if (searching) setSearchResults(null);
    setQuery((value) => ({ ...value, sender, page: 1 }));
  }

  const activeFilters = [
    query.sender && { key: "sender", label: `Sender: ${query.sender}`, clear: () => updateQuery({ ...query, sender: "" }) },
    query.createdFrom && { key: "from", label: `From: ${query.createdFrom}`, clear: () => updateQuery({ ...query, createdFrom: "" }) },
    query.createdTo && { key: "to", label: `To: ${query.createdTo}`, clear: () => updateQuery({ ...query, createdTo: "" }) },
    !searching && query.sort !== initialQuery.sort && { key: "sort", label: "Custom sort", clear: () => updateQuery({ ...query, sort: initialQuery.sort }) },
  ].filter((filter): filter is { key: string; label: string; clear: () => void } => Boolean(filter));
  const inferredFilters = searching && searchInterpretation ? [
    !skipInferredSender && searchInterpretation.sender && {
      key: "inferred-sender",
      label: `Understood sender: ${searchInterpretation.sender}`,
      clear: () => setSkipInferredSender(true),
    },
    !skipInferredDates && (searchInterpretation.created_from || searchInterpretation.created_to) && {
      key: "inferred-dates",
      label: searchInterpretation.created_from && searchInterpretation.created_to
        ? `Understood dates: ${shortDate(searchInterpretation.created_from)} to ${shortDate(searchInterpretation.created_to)}`
        : searchInterpretation.created_from
          ? `Understood from: ${shortDate(searchInterpretation.created_from)}`
          : `Understood to: ${shortDate(searchInterpretation.created_to)}`,
      clear: () => setSkipInferredDates(true),
    },
  ].filter((filter): filter is { key: string; label: string; clear: () => void } => Boolean(filter)) : [];
  const shownFilters = [...activeFilters, ...inferredFilters];

  function clearAllFilters() {
    if (searching) {
      setSkipInferredSender(true);
      setSkipInferredDates(true);
    }
    updateQuery(initialQuery);
  }
  const nothingFiled = !searching && activeFilters.length === 0 && library?.total === 0;

  const uploadMessage = uploadState?.active
    ? `Uploading ${uploadState.completed + 1} of ${uploadState.total}: ${uploadState.current}`
    : uploadState
      ? [
          uploadState.uploaded > 0 && `${uploadState.uploaded} uploaded`,
          uploadState.duplicates > 0 && `${uploadState.duplicates} already in the library`,
          uploadState.failures.length > 0 && uploadState.failures.join(" · "),
        ].filter(Boolean).join(" · ")
      : "";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Paperless</span>
          <span className="brand-agx">AGX</span>
        </div>
        <form className="global-search" onSubmit={runSearch} aria-busy={searchLoading}>
          <button className="search-submit" aria-label="Search"><Search size={18} aria-hidden="true" /></button>
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Search documents"
            aria-label="Search documents"
          />
          {searchLoading && <LoaderCircle className="spin search-progress" size={16} aria-label="Searching" />}
          {searching ? (
            <button type="button" className="clear-search" onClick={clearSearch}><X size={15} /> Clear</button>
          ) : null}
        </form>
        {health && !(health.ocr_configured && health.embedding_configured) && (
          <div className="health-pill" title={`OCR: ${health.ocr_model}\nEmbeddings: ${health.embedding_model}`}>
            <span className="health-dot" />
            Models not ready
          </div>
        )}
      </header>

      <main>
        {error && <div className="error-banner" role="alert">{error}<button onClick={() => { setSearchError(""); setLibraryError(""); setContextError(""); }} aria-label="Dismiss error"><X size={16} /></button></div>}
        {uploadState && <div className={`upload-banner${uploadState.failures.length ? " has-errors" : ""}`} role={uploadState.failures.length && !uploadState.active ? "alert" : "status"}><span>{uploadMessage}</span>{!uploadState.active && <button onClick={() => setUploadState(null)} aria-label="Dismiss upload status"><X size={16} /></button>}</div>}

        <section className="library-toolbar">
          <div>
            <h2>{searching ? "Search results" : "Library"}</h2>
            <span className="toolbar-count" aria-live="polite">
              {searching
                ? searchLoading && searchResults === null
                  ? "Searching"
                  : <>“{activeSearch}” · {searchResults?.length ?? 0}{searchLimited ? "+" : ""} {(searchResults?.length ?? 0) === 1 ? "document" : "documents"}</>
                : library && <>{library.total} {library.total === 1 ? "document" : "documents"}</>}
            </span>
          </div>
          <div className="toolbar-actions">
            <button className="upload-button" disabled={uploading} onClick={() => fileInputRef.current?.click()}><Upload size={16} /> {uploading ? "Uploading" : "Upload"}</button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              disabled={uploading}
              accept="application/pdf,image/png,image/jpeg,image/tiff,image/webp"
              onChange={(event) => {
                if (event.target.files) void upload(event.target.files);
                event.target.value = "";
              }}
            />
            <button className={filtersOpen || shownFilters.length ? "active" : ""} aria-expanded={filtersOpen} aria-controls="document-filters" onClick={() => setFiltersOpen((value) => !value)}><SlidersHorizontal size={16} /> Filters{shownFilters.length > 0 && ` (${shownFilters.length})`}</button>
            {!searching && <div className="segmented" aria-label="Document view">
              <button aria-label="Grid view" aria-pressed={view === "grid"} className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}><Grid2X2 size={16} /></button>
              <button aria-label="List view" aria-pressed={view === "list"} className={view === "list" ? "active" : ""} onClick={() => setView("list")}><List size={17} /></button>
            </div>}
          </div>
        </section>

        {filtersOpen && <FilterPanel query={query} senders={senders} searching={searching} onChange={updateQuery} />}
        {shownFilters.length > 0 && <div className="active-filters" aria-label="Active filters">{shownFilters.map((filter) => <button key={filter.key} onClick={filter.clear} aria-label={`Remove ${filter.label}`}><span>{filter.label}</span><X size={13} aria-hidden="true" /></button>)}<button className="clear-all-filters" onClick={clearAllFilters}>Clear all</button></div>}

        {initialLoading && !library ? (
          <div className="empty-state"><LoaderCircle className="spin" aria-hidden="true" /><p>Loading your documents</p></div>
        ) : !library ? (
          <div className="empty-state">
            <h3>The library could not be loaded</h3>
            <p>Check that the Paperless AGX server is running, then try again.</p>
            <button onClick={() => void refreshLibrary()}>Try again</button>
          </div>
        ) : searching && searchLoading && searchResults === null ? (
          <div className="empty-state"><LoaderCircle className="spin" aria-hidden="true" /><p>Searching your documents</p></div>
        ) : nothingFiled ? (
          <div className="empty-state">
            <FileSearch size={36} aria-hidden="true" />
            <h3>No documents yet</h3>
            <p>Drop files anywhere on this page, or choose files to begin. PDF, PNG, JPEG, TIFF and WebP are processed on this machine.</p>
            <button onClick={() => fileInputRef.current?.click()}><Upload size={16} /> Upload documents</button>
          </div>
        ) : shownDocuments.length === 0 ? (
          <div className="empty-state">
            <FileSearch size={36} aria-hidden="true" />
            <h3>No matches</h3>
            <p>Try different words or remove a filter to search more of the library.</p>
            <div className="empty-actions">{searching && <button onClick={clearSearch}>Clear search</button>}{shownFilters.length > 0 && <button onClick={clearAllFilters}>Clear filters</button>}</div>
          </div>
        ) : searching && searchResults ? (
          <SearchWorkspace key={activeSearch} query={activeSearch} results={searchResults} terms={terms} loading={searchLoading} onOpen={openDocument} />
        ) : (
          <div className={`document-collection ${view}`} aria-busy={searchLoading}>
            {shownDocuments.map((document) => (
              <DocumentCard
                key={document.document_id}
                document={document}
                terms={[]}
                onOpen={() => openDocument(document)}
                onFilterSender={filterBySender}
              />
            ))}
          </div>
        )}

        {!searching && library && library.total > query.pageSize && (
          <nav className="pagination" aria-label="Document pages">
            <button disabled={query.page === 1} onClick={() => setQuery((value) => ({ ...value, page: value.page - 1 }))}>Previous</button>
            <span>Page {query.page} of {Math.ceil(library.total / query.pageSize)}</span>
            <button disabled={query.page * query.pageSize >= library.total} onClick={() => setQuery((value) => ({ ...value, page: value.page + 1 }))}>Next</button>
          </nav>
        )}
      </main>

      {dropping && <div className="drop-overlay" aria-hidden="true"><p><strong>{uploading ? "Upload in progress" : "Drop to upload"}</strong></p></div>}

      {selected && <DocumentDetail documentId={selected.id} initialPage={selected.page} highlight={selected.highlight} highlightPage={selected.highlightPage} senders={senders} onPageChange={(page) => setSelected((value) => value ? { ...value, page } : value)} onDirtyChange={(dirty) => { detailDirty.current = dirty; }} onClose={closeDocument} onChanged={() => setDataVersion((version) => version + 1)} />}
    </div>
  );
}
