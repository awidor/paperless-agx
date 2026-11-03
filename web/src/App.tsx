import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload } from "lucide-react";
import {
  getHealth,
  getSenders,
  listDocuments,
  uploadDocument,
  type Document,
  type DocumentPageResult,
  type DocumentSort,
  type HealthResponse,
  type LibraryQuery,
} from "./api";
import { activeFilterCount, FilterBar, FilterToggle, initialQuery, Library, type View } from "./Library";
import { Reader } from "./Reader";
import { useSearch } from "./search";
import { SearchView } from "./SearchView";
import { TopBar } from "./TopBar";
import { Alert } from "./ui";
import { UploadTray, type UploadState } from "./UploadTray";

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

const ACCEPTED = "application/pdf,image/png,image/jpeg,image/tiff,image/webp";

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

export default function App() {
  const initial = useRef(readUrlState()).current;
  const [query, setQuery] = useState(initial.query);
  const [library, setLibrary] = useState<DocumentPageResult | null>(null);
  const [senders, setSenders] = useState<string[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [searchText, setSearchText] = useState(initial.search);
  const [activeSearch, setActiveSearch] = useState(initial.search);
  const [selected, setSelected] = useState(initial.selected);
  const [view, setView] = useState<View>(initial.view);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [dropping, setDropping] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const [libraryError, setLibraryError] = useState("");
  const [contextError, setContextError] = useState("");
  const [dataVersion, setDataVersion] = useState(0);
  const [searchRun, setSearchRun] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const uploadingRef = useRef(false);
  const openedFromUi = useRef(false);
  const detailDirty = useRef(false);
  const restoringHistory = useRef(false);
  const uploadRef = useRef<(files: FileList | File[]) => Promise<void>>(async () => {});

  const searching = activeSearch.length > 0;
  const uploading = uploadState?.active ?? false;
  const error = libraryError || contextError;
  const search = useSearch(activeSearch, query, searchRun);
  const searchBusy = search?.status === "running";

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
      openedFromUi.current = false;
      detailDirty.current = false;
      setQuery(next.query);
      setSearchText(next.search);
      setActiveSearch(next.search);
      setView(next.view);
      setSelected(next.selected);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [activeSearch, selected]);

  // "/" jumps to the search field from anywhere outside a field or the reader.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], dialog[open]")) return;
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const terms = useMemo(() => activeSearch.split(/\s+/).filter((term) => term.length >= 3), [activeSearch]);

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
    else setSearchRun((run) => run + 1);
    setActiveSearch(value);
  }

  function clearSearch() {
    if (activeSearch) checkpointHistory();
    setActiveSearch("");
    setSearchText("");
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
        failures.push(`${file.name}: ${cause instanceof Error ? cause.message : "upload failed"}`);
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
    setQuery({ ...next, page: 1 });
  }

  function goToPage(page: number) {
    setQuery((value) => ({ ...value, page }));
    window.scrollTo({ top: 0 });
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
    setQuery((value) => ({ ...value, sender, page: 1 }));
  }

  const chooseFiles = () => fileInputRef.current?.click();
  const dismissUpload = useCallback(() => setUploadState(null), []);

  return (
    <div className="app">
      <TopBar
        inputRef={searchInputRef}
        text={searchText}
        searching={searching}
        busy={searchBusy}
        uploading={uploading}
        health={health}
        onText={setSearchText}
        onSubmit={runSearch}
        onClear={clearSearch}
        onHome={clearSearch}
        onUpload={chooseFiles}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        disabled={uploading}
        accept={ACCEPTED}
        onChange={(event) => {
          if (event.target.files) void upload(event.target.files);
          event.target.value = "";
        }}
      />

      <main className="main">
        <div className="container">
          {error && <Alert message={error} onDismiss={() => { setLibraryError(""); setContextError(""); }} />}
          {searching ? (
            <SearchView
              key={activeSearch}
              query={activeSearch}
              state={search}
              terms={terms}
              hasFilters={activeFilterCount(query, false) > 0}
              toolbar={<FilterToggle open={filtersOpen} count={activeFilterCount(query, false)} onToggle={() => setFiltersOpen((open) => !open)} />}
              filters={<FilterBar query={query} senders={senders} open={filtersOpen || activeFilterCount(query, false) > 0} withSort={false} onChange={updateQuery} />}
              onOpen={openDocument}
              onRetry={() => setSearchRun((run) => run + 1)}
              onClearFilters={() => updateQuery(initialQuery)}
            />
          ) : (
            <Library
              query={query}
              library={library}
              loading={initialLoading}
              senders={senders}
              view={view}
              filtersOpen={filtersOpen}
              onToggleFilters={() => setFiltersOpen((open) => !open)}
              onView={setView}
              onQuery={updateQuery}
              onPage={goToPage}
              onOpen={(document) => openDocument(document)}
              onFilterSender={filterBySender}
              onUpload={chooseFiles}
              onRetry={() => void refreshLibrary()}
            />
          )}
        </div>
      </main>

      <UploadTray state={uploadState} onDismiss={dismissUpload} />

      {dropping && <div className="drop" aria-hidden="true">
        <div className="drop__sheet">
          <Upload size={28} aria-hidden="true" />
          <p>{uploading ? "Upload in progress" : "Drop to add to the library"}</p>
        </div>
      </div>}

      {selected && <Reader
        documentId={selected.id}
        initialPage={selected.page}
        highlight={selected.highlight}
        highlightPage={selected.highlightPage}
        senders={senders}
        onPageChange={(page) => setSelected((value) => value ? { ...value, page } : value)}
        onDirtyChange={(dirty) => { detailDirty.current = dirty; }}
        onClose={closeDocument}
        onChanged={() => setDataVersion((version) => version + 1)}
      />}
    </div>
  );
}
