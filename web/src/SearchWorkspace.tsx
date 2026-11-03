import { useEffect, useRef, useState } from "react";
import { BookOpen, FileSearch, FileText, List, LoaderCircle, Search } from "lucide-react";
import { getDocument, getPages, type AgentProgress, type Document, type PageInfo, type SearchPassage } from "./api";
import { DocumentTitle } from "./DocumentTitle";
import { Marked } from "./library";
import { OcrTextLayer } from "./OcrTextLayer";
import { PdfViewer } from "./PdfViewer";
import type { SearchAnswer, SearchResult, SearchState } from "./search";

type Selection = { documentId: number; chunkId: number | null };
type EvidenceTarget = { result: SearchResult; passage: SearchPassage };

const EXCERPT_CHARS = 220;

function firstSelection(result: SearchResult | undefined): Selection {
  return { documentId: result?.document.document_id ?? 0, chunkId: result?.passages[0]?.chunk_id ?? null };
}

function formatDate(document: Document): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(document.created_at || document.added_at));
}

/** A short window of the passage around the exact text, so the match is visible in the list. */
function excerptAround(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const index = flat.toLocaleLowerCase().indexOf(needle.replace(/\s+/g, " ").toLocaleLowerCase());
  if (flat.length <= EXCERPT_CHARS || index < 0) return flat;
  const start = Math.max(0, Math.min(index - Math.floor(EXCERPT_CHARS / 3), flat.length - EXCERPT_CHARS));
  const end = start + EXCERPT_CHARS;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

function times(count: number): string {
  return count === 1 ? "once" : `${count} times`;
}

function trailSummary(steps: AgentProgress[], seconds: number | null): string {
  const count = (kind: AgentProgress["kind"]) => steps.filter((step) => step.kind === kind).length;
  const searches = count("search");
  const lists = count("list");
  const reads = count("read");
  const parts = [
    searches > 0 && `searched ${times(searches)}`,
    lists > 0 && `listed documents ${times(lists)}`,
    reads > 0 && `read ${reads} ${reads === 1 ? "document" : "documents"}`,
  ].filter((part): part is string => Boolean(part));
  const actions = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "looked through the library";
  const ending = seconds === null ? " before it stopped" : ` in ${seconds.toFixed(1)} s`;
  return `${actions[0].toUpperCase()}${actions.slice(1)}${ending}`;
}

function StepIcon({ kind }: { kind: AgentProgress["kind"] }) {
  if (kind === "list") return <List size={14} aria-hidden="true" />;
  if (kind === "read") return <BookOpen size={14} aria-hidden="true" />;
  return <Search size={14} aria-hidden="true" />;
}

/**
 * The lookups the agent made: live while it works, folded into one line once it is done.
 * `seconds` is undefined while running and null when the search stopped early.
 */
function AgentTrail({ steps, seconds }: { steps: AgentProgress[]; seconds?: number | null }) {
  const lookups = steps.filter((step) => step.kind !== "thinking");
  const last = steps.at(-1);
  const running = seconds === undefined;
  const items = <ol>
    {lookups.map((step, index) => {
      const current = running && step === last;
      return <li key={index} className={`trail-step${current ? " current" : ""}`}>
        {current ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <StepIcon kind={step.kind} />}
        <span>{step.label}</span>
      </li>;
    })}
    {running && (!last || last.kind === "thinking") && <li className="trail-step current">
      <LoaderCircle className="spin" size={14} aria-hidden="true" />
      <span>{last?.label ?? "Starting the search"}</span>
    </li>}
  </ol>;
  if (running) return <section className="agent-trail" aria-live="polite" aria-label="What the search is doing">{items}</section>;
  return <details className="agent-trail">
    <summary>{trailSummary(steps, seconds)}</summary>
    {items}
  </details>;
}

export function SearchView({ state, terms, hasFilters, onOpen, onRetry, onClearFilters }: {
  state: SearchState;
  terms: string[];
  hasFilters: boolean;
  onOpen: (document: Document, page: number, highlight?: string) => void;
  onRetry: () => void;
  onClearFilters: () => void;
}) {
  if (state.status === "running") {
    return state.mode === "agent"
      ? <AgentTrail steps={state.steps} />
      : <div className="empty-state" role="status"><LoaderCircle className="spin" aria-hidden="true" /><p>Finding “{state.text}”</p></div>;
  }
  if (state.status === "failed") {
    return <>
      {state.steps.some((step) => step.kind !== "thinking") && <AgentTrail steps={state.steps} seconds={null} />}
      <div className="empty-state" role="alert">
        <h3>{state.mode === "agent" ? "The search stopped before it found anything" : "The exact-text search failed"}</h3>
        <p>{state.message}</p>
        <div className="empty-actions"><button onClick={onRetry}>Search again</button></div>
      </div>
    </>;
  }
  const trail = state.mode === "agent" ? <AgentTrail steps={state.steps} seconds={state.seconds} /> : null;
  if (state.results.length === 0) {
    return <>
      {trail}
      <div className="empty-state">
        <FileSearch size={36} aria-hidden="true" />
        <h3>No document matches</h3>
        <p>{state.mode === "exact"
          ? `No page contains “${state.text}” as written. Search without quotes to find it by what it means.`
          : hasFilters
            ? "Nothing within the current filters matches. Clear them to search the whole library."
            : "Describe the document differently, or put words in quotes to find that exact text."}</p>
        {hasFilters && <div className="empty-actions"><button onClick={onClearFilters}>Clear filters</button></div>}
      </div>
    </>;
  }
  return <>
    {trail}
    <ResultsWorkspace
      results={state.results}
      answer={state.mode === "agent" ? state.answer : null}
      exact={state.mode === "exact" ? state.text : null}
      terms={state.mode === "exact" ? [state.text] : terms}
      onOpen={onOpen}
    />
  </>;
}

function ResultsWorkspace({ results, answer, exact, terms, onOpen }: {
  results: SearchResult[];
  answer: SearchAnswer | null;
  /** The quoted text for an exact-text search; it is what gets marked on the page. */
  exact: string | null;
  terms: string[];
  onOpen: (document: Document, page: number, highlight?: string) => void;
}) {
  const [selection, setSelection] = useState<Selection>(() => firstSelection(results[0]));
  const [document, setDocument] = useState<Document | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState("");
  const previewRef = useRef<HTMLElement>(null);

  useEffect(() => setSelection(firstSelection(results[0])), [results]);

  const selectedResult = results.find((result) => result.document.document_id === selection.documentId) ?? results[0];
  const selectedPassage = selectedResult?.passages.find((passage) => passage.chunk_id === selection.chunkId) ?? selectedResult?.passages[0];
  const page = selectedPassage?.page ?? 1;
  // Summaries and bare page references have no place on the page to mark.
  const highlight = selectedPassage?.kind === "page" && selectedPassage.snippet ? exact ?? selectedPassage.snippet : undefined;
  const evidenceText = selectedPassage?.snippet || selectedResult?.reason;

  useEffect(() => {
    if (!selectedResult) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError("");
    void Promise.all([getDocument(selectedResult.document.document_id), getPages(selectedResult.document.document_id)])
      .then(([nextDocument, nextPages]) => {
        if (cancelled) return;
        setDocument(nextDocument);
        setPages(nextPages);
      })
      .catch((cause) => {
        if (!cancelled) setPreviewError(cause instanceof Error ? cause.message : "The page preview failed to load.");
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedResult?.document.document_id, selectedResult?.document.status]);

  const citedTargets: EvidenceTarget[] = (answer?.citations ?? []).flatMap((index) => {
    const result = results[index];
    const passage = result?.passages[0];
    return result && passage ? [{ result, passage }] : [];
  });
  const previewMatchesSelection = document?.document_id === selectedResult?.document.document_id;
  const currentPage = previewMatchesSelection ? pages.find((candidate) => candidate.page === page) : undefined;
  const previewDocument = previewMatchesSelection ? document : selectedResult?.document;

  function selectTarget(target: EvidenceTarget, reveal = false) {
    setSelection({ documentId: target.result.document.document_id, chunkId: target.passage.chunk_id });
    if (reveal && window.matchMedia("(max-width: 760px)").matches) {
      window.requestAnimationFrame(() => previewRef.current?.scrollIntoView({ block: "start" }));
    }
  }

  return <section className="search-experience">
    {answer && citedTargets.length > 0 && <section className="search-answer" aria-labelledby="answer-heading" aria-live="polite">
      <h3 id="answer-heading">{answer.text}</h3>
      <div className="answer-citations" aria-label="Where the answer comes from">
        {citedTargets.map((target, index) => <button key={target.result.document.document_id} onClick={() => selectTarget(target, true)}>
          <span>{index + 1}</span>
          {target.result.document.title || target.result.document.filename}, p. {target.passage.page}
        </button>)}
      </div>
    </section>}

    <div className="search-workspace">
      <section className="result-rail" aria-label="Matching documents">
        {results.map((result) => {
          const selected = result.document.document_id === selectedResult?.document.document_id;
          return <article key={result.document.document_id} className={`search-result${selected ? " selected" : ""}`}>
            <button className="result-heading" aria-pressed={selected} onClick={() => setSelection(firstSelection(result))}>
              <img src={`/api/documents/${result.document.document_id}/thumbnails/1`} alt="" loading="lazy" />
              <span>
                <strong><DocumentTitle document={result.document} /></strong>
                <small>{formatDate(result.document)}{result.document.page_count ? `, ${result.document.page_count} p.` : ""}</small>
              </span>
            </button>
            {result.reason && <p className="result-reason">{result.reason}</p>}
            {result.passages.length > 0 && <div className="result-passages" aria-label={`Evidence in ${result.document.title || result.document.filename}`}>
              {result.passages.map((passage) => {
                const current = selected && selectedPassage?.chunk_id === passage.chunk_id;
                return <button
                  key={passage.chunk_id}
                  aria-pressed={current}
                  className={current ? "selected" : ""}
                  onClick={() => selectTarget({ result, passage })}
                >
                  <span className="passage-page">{passage.kind === "summary" ? "Summary" : `Page ${passage.page}`}</span>
                  {passage.snippet && <Marked text={exact ? excerptAround(passage.snippet, exact) : passage.snippet} terms={terms} />}
                </button>;
              })}
            </div>}
          </article>;
        })}
      </section>

      <section className="evidence-preview" ref={previewRef} aria-labelledby="evidence-preview-title">
        <header>
          <div>
            <p className="evidence-label">Page {page}</p>
            <h3 id="evidence-preview-title">{selectedResult && <DocumentTitle document={selectedResult.document} />}</h3>
          </div>
          {selectedResult && <button className="open-document" onClick={() => onOpen(selectedResult.document, page, highlight)}><FileText size={16} aria-hidden="true" /> Open document</button>}
        </header>
        {evidenceText && <blockquote className="evidence-strip"><Marked text={evidenceText} terms={terms} /></blockquote>}
        <div className="evidence-page" aria-busy={previewLoading || !previewMatchesSelection}>
          {previewError ? <p className="preview-status viewer-error">{previewError}</p>
            : previewLoading || !previewMatchesSelection ? <p className="preview-status" role="status"><LoaderCircle className="spin" aria-hidden="true" /> Loading the page</p>
              : previewDocument?.media_type === "pdf" ? <PdfViewer url={`/api/documents/${previewDocument.document_id}/file`} page={page} blocks={currentPage?.blocks ?? []} highlight={highlight} />
                : previewDocument ? <div className="ocr-page-frame image-page-frame"><img src={`/api/documents/${previewDocument.document_id}/file`} alt={previewDocument.title || previewDocument.filename} /><OcrTextLayer blocks={currentPage?.blocks ?? []} highlight={highlight} /></div>
                  : <p className="preview-status">The page is unavailable.</p>}
        </div>
      </section>
    </div>
  </section>;
}
