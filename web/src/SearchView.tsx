import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, FileText, List, Search } from "lucide-react";
import { getDocument, getPages, type AgentProgress, type Document, type PageInfo, type SearchPassage } from "./api";
import { documentDate, documentName, formatDay, plural } from "./format";
import { Marked } from "./Marked";
import { PageView } from "./PageView";
import type { SearchAnswer, SearchResult, SearchState } from "./search";
import { EmptyState, Spinner, Thumbnail, useRevealMark } from "./ui";

type Selection = { documentId: number; chunkId: number | null };

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

/** Matches narrow screens, where the reader takes the place of the side preview. */
function useNarrow(): boolean {
  const query = "(max-width: 60rem)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

/**
 * The search results: the answer once, each document once with the one line
 * that says why it matched, and the evidence as the page itself with the
 * passage marked on it.
 */
function Results({ results, answer, exact, terms, onOpen }: {
  results: SearchResult[];
  answer: SearchAnswer | null;
  /** The quoted text for an exact-text search; it is what gets marked on the page. */
  exact: string | null;
  terms: string[];
  onOpen: (document: Document, page: number, highlight?: string) => void;
}) {
  const [selection, setSelection] = useState<Selection>(() => firstSelection(results[0]));
  const [browsedPage, setBrowsedPage] = useState<number | null>(null);
  const [document, setDocument] = useState<Document | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState("");
  const narrow = useNarrow();
  const deskRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSelection(firstSelection(results[0])), [results]);
  useEffect(() => setBrowsedPage(null), [selection.documentId, selection.chunkId]);

  const selectedResult = results.find((result) => result.document.document_id === selection.documentId) ?? results[0];
  const selectedPassage = selectedResult?.passages.find((passage) => passage.chunk_id === selection.chunkId) ?? selectedResult?.passages[0];

  /** The page a passage sits on, and the text to mark there; summaries and bare page references have no place to mark. */
  function evidenceOf(passage: SearchPassage | undefined): { page: number; highlight?: string } {
    const highlight = passage?.kind === "page" && passage.snippet ? exact ?? passage.snippet : undefined;
    return { page: passage?.page ?? 1, highlight };
  }
  const evidence = evidenceOf(selectedPassage);
  const page = browsedPage ?? evidence.page;
  const highlight = page === evidence.page ? evidence.highlight : undefined;

  useEffect(() => {
    if (!selectedResult || narrow) return;
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
  }, [selectedResult?.document.document_id, selectedResult?.document.status, narrow]);

  // Answer citations are indexes into the results; each cited document carries its number in the list too.
  const citations = (answer?.citations ?? []).filter((index, position, all) => results[index] && all.indexOf(index) === position);
  const citationNumber = new Map(citations.map((index, position) => [index, position + 1]));
  const previewMatchesSelection = document?.document_id === selectedResult?.document.document_id;
  const currentPage = previewMatchesSelection ? pages.find((candidate) => candidate.page === page) : undefined;
  const previewDocument = previewMatchesSelection ? document : selectedResult?.document;
  const pageCount = previewDocument?.page_count || 1;
  useRevealMark(deskRef, highlight && previewMatchesSelection && !previewLoading ? `${selectedResult?.document.document_id}-${selectedPassage?.chunk_id}-${page}` : null);

  /** Shows a passage beside the list; on a narrow screen there is no room beside it, so the passage opens in the reader. */
  function show(result: SearchResult, passage: SearchPassage | undefined) {
    if (narrow) {
      const target = evidenceOf(passage);
      onOpen(result.document, target.page, target.highlight);
      return;
    }
    setSelection({ documentId: result.document.document_id, chunkId: passage?.chunk_id ?? null });
  }

  return <>
    {answer && citations.length > 0 && <section className="answer stock" aria-labelledby="answer-heading" aria-live="polite">
      <h2 id="answer-heading" className="visually-hidden">Answer</h2>
      <p className="answer__text">
        {answer.text}
        <span className="cites">
          {citations.map((index) => {
            const result = results[index];
            const passage = result.passages[0];
            return <button
              key={index}
              type="button"
              className="cite"
              aria-pressed={!narrow && result.document.document_id === selectedResult?.document.document_id}
              aria-label={`Source ${citationNumber.get(index)}: ${documentName(result.document)}, page ${passage?.page ?? 1}`}
              title={`${documentName(result.document)}, page ${passage?.page ?? 1}`}
              onClick={() => show(result, passage)}
            >{citationNumber.get(index)}</button>;
          })}
        </span>
      </p>
    </section>}

    <div className="evidence-split">
      <ol className="results" aria-label="Matching documents">
        {results.map((result, index) => {
          const selected = !narrow && result.document.document_id === selectedResult?.document.document_id;
          const name = documentName(result.document);
          const first = result.passages[0];
          const number = citationNumber.get(index);
          // One line says why the document matched: the agent's reason, or the text an exact search found.
          const why = exact
            ? first?.snippet && <Marked text={excerptAround(first.snippet, exact)} terms={terms} />
            : result.reason || (first?.snippet && <Marked text={first.snippet} terms={terms} words />);
          return <li key={result.document.document_id} className={`result${selected ? " is-selected" : ""}`}>
            <button type="button" className="cover" aria-label={`Show ${name}`} aria-pressed={selected} onClick={() => show(result, first)} />
            <span className="sheet sheet--mini"><Thumbnail document={result.document} /></span>
            <div className="result__body">
              <h3 className="result__name">
                {number && <span className="result__n" aria-label={`Source ${number}`}>{number}</span>}
                {name}
              </h3>
              <p className="result__meta">
                {[result.document.sender, formatDay(documentDate(result.document))].filter(Boolean).join(", ")}
              </p>
              {why && <p className="result__why">{why}</p>}
              {result.passages.length > 1 && <p className="found-on">
                <span>Found on</span>
                {result.passages.map((passage) => <button
                  key={passage.chunk_id}
                  type="button"
                  className="found-on__page"
                  aria-pressed={selected && selectedPassage?.chunk_id === passage.chunk_id}
                  onClick={() => show(result, passage)}
                >{passage.kind === "summary" ? "summary" : `p.\u00a0${passage.page}`}</button>)}
              </p>}
            </div>
          </li>;
        })}
      </ol>

      {!narrow && selectedResult && <section className="evidence" aria-label={`Page ${page} of ${documentName(selectedResult.document)}`}>
        <header className="evidence__head">
          <div className="page-nav">
            <button type="button" className="icon-btn" aria-label="Previous page" disabled={page <= 1} onClick={() => setBrowsedPage(page - 1)}><ChevronLeft size={18} aria-hidden="true" /></button>
            <p className="page-nav__where" aria-live="polite">Page {page} of {pageCount}</p>
            <button type="button" className="icon-btn" aria-label="Next page" disabled={page >= pageCount} onClick={() => setBrowsedPage(page + 1)}><ChevronRight size={18} aria-hidden="true" /></button>
          </div>
          {page !== evidence.page && <button type="button" className="btn btn--text" onClick={() => setBrowsedPage(null)}>Back to page {evidence.page}</button>}
          <button type="button" className="btn evidence__open" onClick={() => onOpen(selectedResult.document, page, highlight)}><FileText size={16} aria-hidden="true" /> Open document</button>
        </header>
        <div className="evidence__desk" ref={deskRef} aria-busy={previewLoading || !previewMatchesSelection}>
          {previewError ? <p className="viewer-error">{previewError}</p>
            : previewLoading || !previewMatchesSelection ? <div className="page-loading" role="status"><span className="skeleton skeleton--page" /><span className="status-line"><Spinner /> Loading the page</span></div>
              : previewDocument ? <PageView document={previewDocument} page={page} blocks={currentPage?.blocks ?? []} highlight={highlight} />
                : <p className="viewer-error">The page is unavailable.</p>}
        </div>
      </section>}
    </div>
  </>;
}
