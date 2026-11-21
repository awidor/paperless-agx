import { affects, createEffect, createMemo, createProjection, onCleanup, refresh, type Accessor } from "solid-js";
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
  loaded: boolean;
  hasProcessing: boolean;
  error: string;
  failureId: number;
};

export function createLibraryState(query: Accessor<LibraryQuery>) {
  const seed: Library = { items: [], query: { ...initialQuery }, total: 0, loaded: false, hasProcessing: false, error: "", failureId: 0 };
  let lastGood = seed;
  let failures = 0;
  const requestedQuery = createMemo(() => ({ ...query() }), { name: "library request parameters" });
  const request = createPollRequest();
  // Reconcile incoming documents by ID so status updates keep the same card and image.
  const library = createProjection<Library>(() => {
    const input = requestedQuery();
    return request.load(({ signal }) => listDocuments(input, signal).then(
      (data) => {
        const items = data.items.map((document) => ({
          ...document, processing: isProcessing(document), failed: document.status === "FAILED",
        }));
        const next = { items, query: input, total: data.total, loaded: true, hasProcessing: items.some((document) => document.processing), error: "", failureId: 0 };
        if (!signal.aborted) lastGood = next;
        return next;
      },
      (cause) => {
        if (signal.aborted) throw cause;
        return {
          ...(input === lastGood.query ? lastGood : seed),
          query: input,
          error: cause instanceof Error ? cause.message : "The document library failed to load.",
          failureId: ++failures,
        };
      },
    ));
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

  return { library, context, retry, update };
}
