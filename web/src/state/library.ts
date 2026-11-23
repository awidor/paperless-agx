import { affects, createEffect, createMemo, createProjection, createSignal, onCleanup, refresh, type Accessor } from "solid-js";
import { getHealth, getSenders, listDocuments, type Document, type LibraryQuery } from "../client/api";
import { isProcessing } from "../lib/format";
import { createPollRequest } from "../primitives/createPollRequest";
import { initialQuery } from "./url";

export const POLL_MS = 2_000;

export type LibraryDocument = Document & { processing: boolean; failed: boolean };

type Library = {
  items: LibraryDocument[];
  query: LibraryQuery;
  total: number;
  loadedPages: number;
  hasMore: boolean;
  loaded: boolean;
  hasProcessing: boolean;
  error: string;
  failureId: number;
};

function toLibraryDocument(document: Document): LibraryDocument {
  return { ...document, processing: isProcessing(document), failed: document.status === "FAILED" };
}

function mergePages(groups: LibraryDocument[][]): LibraryDocument[] {
  const seen = new Set<number>();
  const merged: LibraryDocument[] = [];
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item.document_id)) continue;
      seen.add(item.document_id);
      merged.push(item);
    }
  }
  return merged;
}

function queryKey(query: LibraryQuery): string {
  return `${query.sender}\0${query.createdFrom}\0${query.createdTo}\0${query.sort}\0${query.pageSize}`;
}

export function createLibraryState(query: Accessor<LibraryQuery>) {
  const seed: Library = {
    items: [], query: { ...initialQuery }, total: 0, loadedPages: 0, hasMore: false,
    loaded: false, hasProcessing: false, error: "", failureId: 0,
  };
  let lastGood = seed;
  let lastGoodKey = "";
  let failures = 0;
  const requestedQuery = createMemo(() => ({ ...query(), page: 1 }), { name: "library request parameters" });
  const filterKey = createMemo(() => queryKey(requestedQuery()), { name: "library filter key" });
  const [paging, setPaging] = createSignal<{ key: string; pages: number }>({ key: "", pages: 1 }, { name: "library paging" });
  const [loadingMore, setLoadingMore] = createSignal(false, { name: "library loading more" });
  const request = createPollRequest();

  // Reconcile incoming documents by ID so status updates and appended pages keep existing cards and images.
  const library = createProjection<Library>(() => {
    const input = requestedQuery();
    const key = filterKey();
    const currentPaging = paging();
    const pages = currentPaging.key === key ? currentPaging.pages : 1;
    const sameQuery = key === lastGoodKey && lastGood.loaded;
    const incremental = sameQuery && pages === lastGood.loadedPages + 1;
    const baseItems = incremental ? lastGood.items : [];

    return request.load(({ signal }) => {
      const fetchPages = incremental
        ? listDocuments({ ...input, page: pages }, signal).then((data) => {
          const added = data.items.map(toLibraryDocument);
          const items = mergePages([baseItems, added]);
          return { items, total: data.total, exhausted: added.length === 0 };
        })
        : Promise.all(
          Array.from({ length: pages }, (_, index) => listDocuments({ ...input, page: index + 1 }, signal)),
        ).then((results) => {
          const last = results.at(-1);
          const items = mergePages(results.map((data) => data.items.map(toLibraryDocument)));
          return { items, total: last?.total ?? 0, exhausted: (last?.items.length ?? 0) === 0 };
        });

      return fetchPages.then(
        ({ items, total, exhausted }) => {
          if (!signal.aborted) setLoadingMore(false);
          const next: Library = {
            items,
            query: input,
            total,
            loadedPages: pages,
            hasMore: !exhausted && items.length < total,
            loaded: true,
            hasProcessing: items.some((document) => document.processing),
            error: "",
            failureId: 0,
          };
          if (!signal.aborted) {
            lastGood = next;
            lastGoodKey = key;
          }
          return next;
        },
        (cause) => {
          if (signal.aborted) throw cause;
          setLoadingMore(false);
          return {
            ...(sameQuery ? lastGood : seed),
            query: input,
            error: cause instanceof Error ? cause.message : "The document library failed to load.",
            failureId: ++failures,
          };
        },
      );
    });
  }, seed, { key: "document_id", name: "library" });

  const context = createProjection(
    (previous) => {
      const controller = new AbortController();
      const { signal } = controller;
      onCleanup(() => controller.abort());
      return Promise.all([getSenders(signal), getHealth(signal)]).then(
        ([senders, health]) => ({ senders, health, error: "" }),
        (cause) => {
          if (!signal.aborted) previous.error = cause instanceof Error ? cause.message : "Service status failed to load.";
        },
      );
    },
    { senders: [] as string[], health: null as Awaited<ReturnType<typeof getHealth>> | null, error: "" },
    { seedLoadingValue: true, name: "library context" },
  );

  function loadMore() {
    if (!library.loaded || !library.hasMore || library.error || request.pending()) return;
    setLoadingMore(true);
    setPaging({ key: filterKey(), pages: library.loadedPages + 1 });
  }

  function update() {
    refresh(library);
    refresh(context);
  }

  function retry() {
    affects(library);
    refresh(library);
  }

  createEffect(() => library.hasProcessing, (processing) => {
    if (!processing) return;
    const timer = window.setInterval(() => {
      if (!request.pending()) refresh(library);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, { name: "poll library" });

  return { library, context, loadingMore, loadMore, retry, update };
}
