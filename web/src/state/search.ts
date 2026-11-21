import { createProjection, from, type Accessor } from "solid-js";
import { searchDocuments, streamAgentSearch, type AgentProgress, type Document, type LibraryQuery, type SearchPassage } from "../client/api";

export type SearchResult = { document: Document; reason?: string; passages: SearchPassage[] };
export type SearchAnswer = { text: string; citations: number[] };
type SearchState = {
  running: boolean;
  exact: string | null;
  steps: AgentProgress[];
  current: string;
  seconds: number;
  results: SearchResult[];
  answer: SearchAnswer | null;
  notice: { kind: "empty" } | { kind: "failed"; message: string } | null;
};

const QUOTE_PAIRS = [['"', '"'], ["„", "“"], ["“", "”"], ["»", "«"], ["«", "»"]];

/** The text inside quotes when the whole query is quoted, as in "285 334 268". */
export function exactText(query: string): string | null {
  const value = query.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (value.length > open.length + close.length && value.startsWith(open) && value.endsWith(close)) {
      return value.slice(open.length, value.length - close.length).trim() || null;
    }
  }
  return null;
}

function initialSearch(): SearchState {
  return { running: false, exact: null, steps: [], current: "", seconds: 0, results: [], answer: null, notice: null };
}

export function createSearchState(text: Accessor<string>, filters: Accessor<LibraryQuery>, run: Accessor<number>) {
  return createProjection<SearchState>(() => {
    const query = text();
    if (!query) return initialSearch();
    run();
    const { sender, createdFrom, createdTo } = filters();
    const limits = {
      sender: sender || null,
      created_from: createdFrom ? new Date(`${createdFrom}T00:00:00`).toISOString() : null,
      created_to: createdTo ? new Date(`${createdTo}T23:59:59`).toISOString() : null,
    };
    const exact = exactText(query);

    return from<SearchState>((next, _error, complete) => {
      const controller = new AbortController();
      const { signal } = controller;
      const started = performance.now();
      let state: SearchState = { ...initialSearch(), exact, running: true };
      next(state);

      const request = exact
        ? searchDocuments({ query: exact, exact: true, semantic: true, summaries: true, page: 1, page_size: 50, ...limits }, signal)
          .then((response) => ({ results: response.items.map((hit) => ({ document: hit.document, passages: hit.passages })), answer: null }))
        : streamAgentSearch({ query, ...limits }, (step) => {
          if (signal.aborted) return;
          // Later emissions include all prior lookups even if two stream events land in one render.
          const steps = step.kind === "thinking" ? state.steps : [...state.steps, step];
          state = { ...state, current: step.label, steps };
          next(state);
        }, signal).then((result) => ({
          results: result.results.map((item) => ({ document: item.document, reason: item.reason, passages: [item.passage] })),
          answer: result.answer ? { text: result.answer, citations: result.citations } : null,
        }));

      void request.then(({ results, answer }) => {
        if (signal.aborted) return;
        next({
          ...state, running: false, results, answer, seconds: (performance.now() - started) / 1000,
          notice: results.length > 0 ? null : { kind: "empty" },
        });
        complete();
      }, (cause) => {
        if (signal.aborted) return;
        const message = cause instanceof Error ? cause.message : "The search failed.";
        next({ ...state, running: false, notice: { kind: "failed", message } });
        complete();
      });

      return () => controller.abort();
    });
  }, initialSearch(), { key: null, name: "search" });
}
