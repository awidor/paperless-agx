import { useEffect, useState } from "react";
import { searchDocuments, streamAgentSearch, type AgentProgress, type Document, type SearchPassage } from "./api";

export type SearchFilters = { sender: string; createdFrom: string; createdTo: string };
export type SearchResult = { document: Document; reason?: string; passages: SearchPassage[] };
export type SearchAnswer = { text: string; citations: number[] };

export type SearchState =
  | { mode: "agent"; status: "running"; steps: AgentProgress[] }
  | { mode: "agent"; status: "done"; steps: AgentProgress[]; seconds: number; results: SearchResult[]; answer: SearchAnswer | null }
  | { mode: "exact"; status: "running"; text: string }
  | { mode: "exact"; status: "done"; text: string; results: SearchResult[] }
  | { mode: "agent" | "exact"; status: "failed"; message: string; steps: AgentProgress[] };

const QUOTE_PAIRS: [string, string][] = [['"', '"'], ["„", "“"], ["“", "”"], ["»", "«"], ["«", "»"]];

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

function dayStart(date: string): string | null {
  return date ? new Date(`${date}T00:00:00`).toISOString() : null;
}

function dayEnd(date: string): string | null {
  return date ? new Date(`${date}T23:59:59`).toISOString() : null;
}

function failure(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The search failed.";
}

/** Runs a search for `query`: quoted text as an exact-text search, anything else through the search agent. */
export function useSearch(query: string, filters: SearchFilters, run: number): SearchState | null {
  const [state, setState] = useState<SearchState | null>(null);

  useEffect(() => {
    if (!query) {
      setState(null);
      return;
    }
    const controller = new AbortController();
    const limits = { sender: filters.sender || null, created_from: dayStart(filters.createdFrom), created_to: dayEnd(filters.createdTo) };
    const exact = exactText(query);
    if (exact) {
      setState({ mode: "exact", status: "running", text: exact });
      searchDocuments({ query: exact, exact: true, page: 1, page_size: 50, ...limits }, controller.signal)
        .then((response) => setState({
          mode: "exact",
          status: "done",
          text: exact,
          results: response.items.map((hit) => ({ document: hit.document, passages: hit.passages })),
        }))
        .catch((cause) => {
          if (!controller.signal.aborted) setState({ mode: "exact", status: "failed", message: failure(cause), steps: [] });
        });
    } else {
      const started = performance.now();
      let steps: AgentProgress[] = [];
      setState({ mode: "agent", status: "running", steps });
      streamAgentSearch({ query, ...limits }, (step) => {
        steps = [...steps, step];
        setState({ mode: "agent", status: "running", steps });
      }, controller.signal)
        .then((result) => setState({
          mode: "agent",
          status: "done",
          steps,
          seconds: (performance.now() - started) / 1000,
          results: result.results.map((item) => ({ document: item.document, reason: item.reason, passages: [item.passage] })),
          answer: result.answer ? { text: result.answer, citations: result.citations } : null,
        }))
        .catch((cause) => {
          if (!controller.signal.aborted) setState({ mode: "agent", status: "failed", message: failure(cause), steps });
        });
    }
    return () => controller.abort();
  }, [query, filters.sender, filters.createdFrom, filters.createdTo, run]);

  return state;
}
