import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, ChevronDown, FileText, List, Search } from "lucide-react";
import { getDocument, getPages, type AgentProgress, type Document, type PageInfo, type SearchPassage } from "./api";
import { documentDate, documentName, formatDay, plural } from "./format";
import { Marked } from "./Marked";
import { PageView } from "./PageView";
import type { SearchAnswer, SearchResult, SearchState } from "./search";
import { EmptyState, Spinner, Thumbnail } from "./ui";

type Selection = { documentId: number; chunkId: number | null };
type EvidenceTarget = { result: SearchResult; passage: SearchPassage };

const EXCERPT_CHARS = 220;

function firstSelection(result: SearchResult | undefined): Selection {
  return { documentId: result?.document.document_id ?? 0, chunkId: result?.passages[0]?.chunk_id ?? null };
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
    reads > 0 && `read ${plural(reads, "document")}`,
  ].filter((part): part is string => Boolean(part));
  const actions = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "looked through the library";
  const ending = seconds === null ? " before it stopped" : ` in ${seconds.toFixed(1)} s`;
  return `${actions[0].toUpperCase()}${actions.slice(1)}${ending}`;
}

function StepIcon({ kind }: { kind: AgentProgress["kind"] }) {
  if (kind === "list") return <List size={15} aria-hidden="true" />;
  if (kind === "read") return <BookOpen size={15} aria-hidden="true" />;
  return <Search size={15} aria-hidden="true" />;
}

function TrailSteps({ steps, running }: { steps: AgentProgress[]; running: boolean }) {
  const lookups = steps.filter((step) => step.kind !== "thinking");
  const last = steps.at(-1);
  return <ol className="trail__steps">
    {lookups.map((step, index) => {
      const current = running && step === last;
      return <li key={index} className={`trail__step${current ? " is-current" : ""}`}>
        {current ? <Spinner size={15} /> : <StepIcon kind={step.kind} />}
        <span>{step.label}</span>
      </li>;
    })}
    {running && (!last || last.kind === "thinking") && <li className="trail__step is-current">
      <Spinner size={15} />
      <span>{last?.label ?? "Starting the search"}</span>
    </li>}
  </ol>;
}

/** The lookups the agent made, folded into one line once the search is done. */
function TrailSummary({ steps, seconds }: { steps: AgentProgress[]; seconds: number | null }) {
  return <details className="trail">
    <summary>{trailSummary(steps, seconds)}<ChevronDown size={14} aria-hidden="true" /></summary>
    <TrailSteps steps={steps} running={false} />
  </details>;
}

export function SearchView({ query, state, terms, hasFilters, toolbar, filters, onOpen, onRetry, onClearFilters }: {
  query: string;
  state: SearchState | null;
  terms: string[];
  hasFilters: boolean;
  toolbar: ReactNode;
  filters: ReactNode;
  onOpen: (document: Document, page: number, highlight?: string) => void;
  onRetry: () => void;
  onClearFilters: () => void;
}) {
  const exact = state?.mode === "exact" && "text" in state ? state.text : null;
  const done = state?.status === "done" ? state : null;
  const count = !state ? "" : state.status === "running" ? "Searching" : state.status === "failed" ? "" : exact
    ? `${plural(state.results.length, "document")} ${state.results.length === 1 ? "contains" : "contain"} this text`
    : plural(state.results.length, "document");

  const trail = done?.mode === "agent"
    ? <TrailSummary steps={done.steps} seconds={done.seconds} />
    : state?.status === "failed" && state.steps.some((step) => step.kind !== "thinking")
      ? <TrailSummary steps={state.steps} seconds={null} />
      : null;

  let body: ReactNode = null;
  if (state?.status === "running") {
    body = state.mode === "agent"
      ? <section className="trail trail--live stock" aria-live="polite" aria-label="What the search is doing"><TrailSteps steps={state.steps} running /></section>
      : <p className="status-line" role="status"><Spinner /> Finding “{state.text}”</p>;
  } else if (state?.status === "failed") {
    body = <>
      <EmptyState alert title={state.mode === "agent" ? "The search stopped before it found anything" : "The exact-text search failed"} action={<button type="button" className="btn" onClick={onRetry}>Search again</button>}>
        {state.message}
      </EmptyState>
    </>;
  } else if (done) {
    body = done.results.length === 0 ? <>
      <EmptyState title="No document matches" action={hasFilters && <button type="button" className="btn" onClick={onClearFilters}>Clear filters</button>}>
        {done.mode === "exact"
          ? `No page contains “${done.text}” as written. Search without quotes to find it by what it means.`
          : hasFilters
            ? "Nothing within the current filters matches. Clear them to search the whole library."
            : "Describe the document differently, or put words in quotes to find that exact text."}
      </EmptyState>
    </> : <>
      <Results
        results={done.results}
        answer={done.mode === "agent" ? done.answer : null}
        exact={exact}
        terms={exact ? [exact] : terms}
        onOpen={onOpen}
      />
    </>;
  }

  return <section className="view search" aria-labelledby="search-title">
    <header className="view-head">
      <div className="view-head__title view-head__title--search">
        <h1 id="search-title" className="search-title">{exact ? `“${exact}”` : query}</h1>
        <div className="search-meta">
          <p className="view-head__count" aria-live="polite">{count}</p>
          {trail}
        </div>
      </div>
      <div className="view-head__tools">{toolbar}</div>
    </header>
    {filters}
    {body}
  </section>;
}

function Results({ results, answer, exact, terms, onOpen }: {
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
    if (reveal && window.matchMedia("(max-width: 60rem)").matches) {
      window.requestAnimationFrame(() => previewRef.current?.scrollIntoView({ block: "start" }));
    }
  }

  const isCurrent = (target: EvidenceTarget) =>
    target.result.document.document_id === selectedResult?.document.document_id && target.passage.chunk_id === selectedPassage?.chunk_id;

  return <>
    {answer && citedTargets.length > 0 && <section className="answer stock" aria-labelledby="answer-heading" aria-live="polite">
      <h2 id="answer-heading" className="visually-hidden">Answer</h2>
      <p className="answer__text">{answer.text}</p>
      <ol className="answer__sources" aria-label="Where the answer comes from">
        {citedTargets.map((target, index) => <li key={target.result.document.document_id}>
          <button type="button" className="source" aria-pressed={isCurrent(target)} onClick={() => selectTarget(target, true)}>
            <span className="source__n">{index + 1}</span>
            <span className="source__name">{documentName(target.result.document)}</span>
            <span className="source__page">p.&nbsp;{target.passage.page}</span>
          </button>
        </li>)}
      </ol>
    </section>}

    <div className="evidence-split">
      <ol className="results" aria-label="Matching documents">
        {results.map((result) => {
          const selected = result.document.document_id === selectedResult?.document.document_id;
          const name = documentName(result.document);
          return <li key={result.document.document_id} className={`result${selected ? " is-selected" : ""}`}>
            <button type="button" className="result__head" aria-pressed={selected} onClick={() => setSelection(firstSelection(result))}>
              <span className="sheet sheet--mini"><Thumbnail document={result.document} /></span>
              <span className="result__titles">
                <span className="result__name">{name}</span>
                <span className="result__meta">
                  {[result.document.sender, formatDay(documentDate(result.document)), result.document.page_count ? plural(result.document.page_count, "page") : null].filter(Boolean).join(", ")}
                </span>
              </span>
            </button>
            {result.reason && <p className="result__reason">{result.reason}</p>}
            {result.passages.length > 0 && <ul className="passages" aria-label={`Evidence in ${name}`}>
              {result.passages.map((passage) => {
                const current = selected && selectedPassage?.chunk_id === passage.chunk_id;
                return <li key={passage.chunk_id}>
                  <button type="button" className="passage" aria-pressed={current} onClick={() => selectTarget({ result, passage })}>
                    <span className="passage__where">{passage.kind === "summary" ? "Summary" : `Page ${passage.page}`}</span>
                    {passage.snippet && <span className="passage__text"><Marked text={exact ? excerptAround(passage.snippet, exact) : passage.snippet} terms={terms} words={!exact} /></span>}
                  </button>
                </li>;
              })}
            </ul>}
          </li>;
        })}
      </ol>

      <section className="evidence" ref={previewRef} aria-labelledby="evidence-title">
        <header className="evidence__head">
          <div className="evidence__titles">
            <h2 id="evidence-title" className="evidence__title">{selectedResult && documentName(selectedResult.document)}</h2>
            <p className="evidence__where">
              {selectedResult?.document.sender ? `${selectedResult.document.sender}, page ${page}` : `Page ${page}`}
              {previewDocument?.page_count ? ` of ${previewDocument.page_count}` : ""}
            </p>
          </div>
          {selectedResult && <button type="button" className="btn" onClick={() => onOpen(selectedResult.document, page, highlight)}><FileText size={16} aria-hidden="true" /> Open document</button>}
        </header>
        {evidenceText && <blockquote className="evidence__quote"><Marked text={evidenceText} terms={terms} words={!exact} /></blockquote>}
        <div className="evidence__desk" aria-busy={previewLoading || !previewMatchesSelection}>
          {previewError ? <p className="viewer-error">{previewError}</p>
            : previewLoading || !previewMatchesSelection ? <div className="page-loading" role="status"><span className="skeleton skeleton--page" /><span className="status-line"><Spinner /> Loading the page</span></div>
              : previewDocument ? <PageView document={previewDocument} page={page} blocks={currentPage?.blocks ?? []} highlight={highlight} />
                : <p className="viewer-error">The page is unavailable.</p>}
        </div>
      </section>
    </div>
  </>;
}
