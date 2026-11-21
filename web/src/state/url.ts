import { createEffect, createSignal, createStore, onSettled } from "solid-js";
import type { DocumentSort, LibraryQuery } from "../client/api";

export type View = "grid" | "list";
type Selection = { id: number; page: number; marks?: string[]; marksPage?: number };
type UrlState = { query: LibraryQuery; search: string; view: View; selected: Selection | null };

export const initialQuery: LibraryQuery = {
  page: 1,
  pageSize: 24,
  sender: "",
  createdFrom: "",
  createdTo: "",
  sort: "document_date_desc",
};

export const SORT_LABELS: Record<DocumentSort, string> = {
  document_date_desc: "Newest document date",
  document_date_asc: "Oldest document date",
  added_date_desc: "Recently added",
  added_date_asc: "First added",
  title_asc: "Title, A to Z",
  title_desc: "Title, Z to A",
  sender_asc: "Sender, A to Z",
  sender_desc: "Sender, Z to A",
  file_size_desc: "Largest file",
  file_size_asc: "Smallest file",
};

const PARAMS = ["q", "page", "sender", "from", "to", "sort", "view", "document", "document_page"];

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

export function readUrlState(params: URLSearchParams): UrlState {
  const sort = params.get("sort");
  const id = positiveInteger(params.get("document"), 0);
  return {
    query: {
      ...initialQuery,
      page: positiveInteger(params.get("page"), 1),
      sender: params.get("sender") || "",
      createdFrom: dateValue(params.get("from")),
      createdTo: dateValue(params.get("to")),
      sort: sort && Object.hasOwn(SORT_LABELS, sort) ? sort as DocumentSort : initialQuery.sort,
    },
    search: params.get("q")?.trim() || "",
    view: params.get("view") === "list" ? "list" : "grid",
    selected: id ? { id, page: positiveInteger(params.get("document_page"), 1) } : null,
  };
}

export function writeUrlState(url: URL, state: UrlState): URL {
  const params = url.searchParams;
  const { query, search, view, selected } = state;
  for (const key of PARAMS) params.delete(key);
  if (search) params.set("q", search);
  if (query.page > 1) params.set("page", String(query.page));
  if (query.sender) params.set("sender", query.sender);
  if (query.createdFrom) params.set("from", query.createdFrom);
  if (query.createdTo) params.set("to", query.createdTo);
  if (query.sort !== initialQuery.sort) params.set("sort", query.sort);
  if (view !== "grid") params.set("view", view);
  if (selected) {
    params.set("document", String(selected.id));
    if (selected.page > 1) params.set("document_page", String(selected.page));
  }
  return url;
}

export function createUrlState() {
  const initial = readUrlState(new URLSearchParams(location.search));
  const [state, setState] = createStore(initial, { name: "url" });
  const [draft, setDraft] = createSignal(initial.search, { name: "search draft" });
  const [run, setRun] = createSignal(0, { name: "search run" });
  let historyIndex = history.state?.paperlessIndex ?? 0;
  let committedUrl = location.href;
  let committedState = history.state;
  let restoring = false;
  let canLeaveReader: (() => boolean) | undefined;

  function checkpoint(reader = false) {
    historyIndex += 1;
    history.pushState({ paperlessIndex: historyIndex, paperlessReader: reader }, "", location.href);
  }

  createEffect(
    () => writeUrlState(new URL(location.href), state).href,
    (url) => {
      committedUrl = url;
      if (location.href !== url || history.state?.paperlessIndex === undefined) {
        history.replaceState({ ...history.state, paperlessIndex: historyIndex }, "", url);
      }
      committedState = history.state;
    },
    { name: "sync URL" },
  );

  onSettled(() => {
    function pop(event: PopStateEvent) {
      if (restoring) {
        restoring = false;
        return;
      }
      const nextIndex: number | undefined = event.state?.paperlessIndex;
      if (canLeaveReader && !canLeaveReader()) {
        if (nextIndex !== undefined && nextIndex !== historyIndex) {
          restoring = true;
          history.go(historyIndex - nextIndex);
        } else {
          history.pushState(committedState, "", committedUrl);
        }
        return;
      }
      historyIndex = nextIndex ?? 0;
      committedState = event.state;
      committedUrl = location.href;
      const next = readUrlState(new URLSearchParams(location.search));
      setState((current) => {
        Object.assign(current.query, next.query);
        current.search = next.search;
        current.view = next.view;
        current.selected = next.selected;
      });
      setDraft(next.search);
    }
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  });

  function clearSearch() {
    if (state.search) checkpoint();
    setState((current) => { current.search = ""; });
    setDraft("");
  }

  function submitSearch(event: SubmitEvent) {
    event.preventDefault();
    const search = draft().trim();
    if (!search) return clearSearch();
    if (search === state.search) return rerunSearch();
    checkpoint();
    setState((current) => { current.search = search; });
    setDraft(search);
  }

  function rerunSearch() {
    setRun((value) => value + 1);
  }

  function updateQuery(query: Partial<LibraryQuery>) {
    setState((current) => { Object.assign(current.query, query, { page: 1 }); });
  }

  function setPage(page: number) {
    setState((current) => { current.query.page = page; });
    window.scrollTo({ top: 0 });
  }

  function setView(view: View) {
    setState((current) => { current.view = view; });
  }

  function openDocument(id: number, page = 1, marks?: string[]) {
    checkpoint(true);
    setState((current) => { current.selected = { id, page, marks, marksPage: marks?.length ? page : undefined }; });
  }

  function setDocumentPage(page: number) {
    setState((current) => { if (current.selected) current.selected.page = page; });
  }

  function closeDocument() {
    canLeaveReader = undefined;
    if (history.state?.paperlessReader) history.back();
    else setState((current) => { current.selected = null; });
  }

  function guardReader(check: () => boolean) {
    canLeaveReader = check;
    return () => { if (canLeaveReader === check) canLeaveReader = undefined; };
  }

  return {
    state, draft, setDraft, run, submitSearch, clearSearch, rerunSearch, updateQuery, setPage, setView,
    openDocument, setDocumentPage, closeDocument, guardReader,
  };
}
