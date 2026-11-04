import { useState, type KeyboardEvent, type ReactNode } from "react";
import { BookOpen, ChevronDown, List, Search } from "lucide-react";
import type { AgentProgress, Document, SearchPassage } from "./api";
import { evidenceTerms, type FrameShape } from "./evidenceHighlight";
import { documentDate, documentName, formatDay, plural } from "./format";
import { Marked } from "./Marked";
import { PaperCrop, type Found } from "./PaperCrop";
import type { SearchAnswer, SearchResult, SearchState } from "./search";
import { EmptyState, Spinner } from "./ui";

const EXCERPT_CHARS = 220;

/**
 * The slice of paper beside each source: the same share of the page for every
 * row, so all strips show the paper at one scale and only their height varies.
 */
const STRIP: FrameShape = { width: 0.45, minAspect: 1.5, maxAspect: 3.2 };

/** A short window of a summary around the exact text, so the match is visible. */
function excerptAround(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const index = flat.toLocaleLowerCase().indexOf(needle.replace(/\s+/g, " ").toLocaleLowerCase());
  if (flat.length <= EXCERPT_CHARS || index < 0) return flat;
  const start = Math.max(0, Math.min(index - Math.floor(EXCERPT_CHARS / 3), flat.length - EXCERPT_CHARS));
  const end = start + EXCERPT_CHARS;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** Keeps a figure on the same line as its unit, so "367,54 €" never breaks before the euro sign. */
function tidy(text: string): string {
  return text.replace(/(\d) (€|%|EUR\b)/g, "$1\u00a0$2");
}

/** Whether a title already names the day, as 24.10.2025 or as the date line would print it. */
function namesDay(title: string, day: Date): boolean {
  const d = day.getDate();
  const m = day.getMonth() + 1;
  const y = day.getFullYear();
  const two = (value: number) => String(value).padStart(2, "0");
  return [`${two(d)}.${two(m)}.${y}`, `${d}.${m}.${y}`, `${y}-${two(m)}-${two(d)}`, formatDay(day)].some((form) => title.includes(form));
}

function StepIcon({ kind }: { kind: AgentProgress["kind"] }) {
  if (kind === "list") return <List size={15} aria-hidden="true" />;
  if (kind === "read") return <BookOpen size={15} aria-hidden="true" />;
  return <Search size={15} aria-hidden="true" />;
}

/**
 * The line under the search field. While the agent works, the step it is on;
 * once it is done, what it found and how long it took. Either way the line
 * opens into the lookups it made.
 */
function Trail({ steps, running, outcome }: { steps: AgentProgress[]; running: boolean; outcome: string }) {
  const lookups = steps.filter((step) => step.kind !== "thinking");
  const line = running
    // Each new step takes the line with a short tick, so the change reads as progress.
    ? <><Spinner size={15} /><span key={steps.length} className="trail__current">{steps.at(-1)?.label ?? "Starting the search"}</span></>
    : <span className="trail__outcome">{outcome}</span>;
  if (lookups.length === 0) return <p className={`trail__line${running ? " trail__line--live" : ""}`}>{line}</p>;
  return <details className="trail">
    <summary className={`trail__line${running ? " trail__line--live" : ""}`}>{line}<ChevronDown size={14} aria-hidden="true" /></summary>
    <ol className="trail__steps">
      {lookups.map((step, index) => <li key={index} className="trail__step"><StepIcon kind={step.kind} /><span>{step.label}</span></li>)}
    </ol>
  </details>;
}

type Open = (document: Document, page: number, marks?: string[]) => void;

/** The passage that has a place on the paper, or the first one when none has. */
function placedPassage(result: SearchResult): SearchPassage | undefined {
  return result.passages.find((passage) => passage.kind === "page") ?? result.passages[0];
}

/** What to look for on the page: the quoted text, or the figures in the agent's reason. */
function termsFor(result: SearchResult, exact: string | null): string[] {
  return exact ? [exact] : evidenceTerms(result.reason);
}

export function SearchView({ query, state, hasFilters, toolbar, filters, onOpen, onRetry, onClearFilters }: {
  query: string;
  state: SearchState | null;
  hasFilters: boolean;
  toolbar: ReactNode;
  filters: ReactNode;
  onOpen: Open;
  onRetry: () => void;
  onClearFilters: () => void;
}) {
  const exact = state?.mode === "exact" && "text" in state ? state.text : null;
  const done = state?.status === "done" ? state : null;
  const found = done ? done.results.length : 0;

  // The line beside Filters: what the search is doing, or what it found.
  let status: ReactNode = null;
  let announcement = "";
  if (state?.status === "running") {
    announcement = "Searching";
    status = state.mode === "agent"
      ? <Trail steps={state.steps} running outcome="" />
      : <p className="trail__line trail__line--live"><Spinner size={15} /><span className="trail__current">Looking for “{state.text}” as written</span></p>;
  } else if (state?.status === "failed") {
    status = <EmptyState alert title={state.mode === "agent" ? "The search stopped before it found anything" : "The exact-text search failed"} action={<button type="button" className="btn" onClick={onRetry}>Search again</button>}>
      {state.message}
    </EmptyState>;
  } else if (done && found === 0) {
    status = <EmptyState live title="No document matches" action={hasFilters && <button type="button" className="btn" onClick={onClearFilters}>Clear filters</button>}>
      {done.mode === "exact"
        ? `No page contains “${done.text}” as written. Search without quotes to find it by what it means.`
        : hasFilters
          ? "Nothing within the current filters matches. Clear them to search the whole library."
          : "Describe the document differently, or put words in quotes to find that exact text."}
    </EmptyState>;
  } else if (done?.mode === "agent") {
    announcement = `Found ${plural(found, "document")}`;
    status = <Trail steps={done.steps} running={false} outcome={`Found ${plural(found, "document")} in ${done.seconds.toFixed(1)} s`} />;
  } else if (done?.mode === "exact") {
    announcement = `${plural(found, "document")} ${found === 1 ? "contains" : "contain"} this text`;
    status = <p className="trail__line">{plural(found, "document")} {found === 1 ? "contains" : "contain"} <span className="ask__quote">“{done.text}”</span></p>;
  }

  const failedSteps = state?.status === "failed" ? state.steps.filter((step) => step.kind !== "thinking") : [];

  return <section className="view search" aria-labelledby="search-title">
    <h1 id="search-title" className="visually-hidden">Search results for “{exact ?? query}”</h1>
    <header className={`ask${state?.status === "failed" || (done && found === 0) ? " ask--empty" : ""}`}>
      <div className="ask__status">
        {status}
        {failedSteps.length > 0 && <Trail steps={failedSteps} running={false} outcome={`${plural(failedSteps.length, "lookup")} before it stopped`} />}
      </div>
      <div className="ask__tools">{toolbar}</div>
    </header>
    <p className="visually-hidden" aria-live="polite">{announcement}</p>
    {filters}
    {state?.status === "running" && <Placeholder answer={state.mode === "agent"} />}
    {done && found > 0 && <Results results={done.results} answer={done.mode === "agent" ? done.answer : null} exact={exact} onOpen={onOpen} />}
  </section>;
}

/** The shape of the results while the search runs, so they land without moving anything. */
function Placeholder({ answer }: { answer: boolean }) {
  return <div className="placeholder" aria-hidden="true">
    {answer && <div className="answer">
      <span className="skeleton skeleton--text" />
      <span className="skeleton skeleton--text skeleton--short" />
    </div>}
    <ol className="sources__list">
      {[0, 1, 2].map((index) => <li key={index} className="source">
        <div className="source__text">
          <span className="skeleton skeleton--line skeleton--title" />
          <span className="skeleton skeleton--line skeleton--short" />
        </div>
        <div className="source__paper"><span className="paper paper--loading" style={{ aspectRatio: String(STRIP.maxAspect) }} /></div>
      </li>)}
    </ol>
  </div>;
}

/** Up and Down step through the sources the way they step through a mail list; Enter opens one. */
function stepThroughSources(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const target = event.target as HTMLElement;
  if (!target.classList.contains("cover")) return;
  const covers = [...event.currentTarget.querySelectorAll<HTMLElement>(".source > .cover")];
  const next = covers[covers.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
  next.closest(".source")?.scrollIntoView({ block: "nearest" });
}

/**
 * The answer page: the agent's answer as prose, then each document once, its
 * title and sender beside a strip of the paper with the evidence outlined.
 *
 * The answer and the strip already carry the evidence of a cited document, so
 * its row leaves the agent's reason out. When the answer cites every result,
 * the list right under it is its citation; only an answer that cites some of
 * the results numbers them.
 */
function Results({ results, answer, exact, onOpen }: {
  results: SearchResult[];
  answer: SearchAnswer | null;
  /** The quoted text for an exact-text search; it is what gets marked on the paper. */
  exact: string | null;
  onOpen: Open;
}) {
  const [hinted, setHinted] = useState<number | null>(null);
  const text = answer?.text ? tidy(answer.text) : null;

  // Citations are indexes into the results; the cited documents come first, in the order the answer cites them.
  const citations = text ? (answer?.citations ?? []).filter((index, position, all) => results[index] && all.indexOf(index) === position) : [];
  const numbered = citations.length > 0 && citations.length < results.length;
  const cited = citations.map((index) => results[index]);
  const others = results.filter((_, index) => !citations.includes(index));

  function open(result: SearchResult) {
    onOpen(result.document, placedPassage(result)?.page ?? 1, termsFor(result, exact));
  }

  // Rows land one after another under the answer; `order` is a row's place on the page.
  const source = (result: SearchResult, number: number | null, why: boolean, order: number) => <Source
    key={result.document.document_id}
    order={order}
    result={result}
    number={number}
    why={why}
    exact={exact}
    hinted={number !== null && number === hinted}
    onOpen={onOpen}
  />;

  return <div className="results" onKeyDown={stepThroughSources}>
    {text && <section className="answer" aria-labelledby="answer-heading">
      <h2 id="answer-heading" className="visually-hidden">Answer</h2>
      <p className="answer__text">
        {text}
        {numbered && <span className="cites">
          {cited.map((result, position) => {
            const name = documentName(result.document);
            const page = placedPassage(result)?.page ?? 1;
            return <button
              key={result.document.document_id}
              type="button"
              className={`badge cite${hinted === position + 1 ? " is-hinted" : ""}`}
              aria-label={`Source ${position + 1}: open ${name}, page ${page}`}
              title={name}
              onMouseEnter={() => setHinted(position + 1)}
              onMouseLeave={() => setHinted(null)}
              onFocus={() => setHinted(position + 1)}
              onBlur={() => setHinted(null)}
              onClick={() => open(result)}
            >{position + 1}</button>;
          })}
        </span>}
      </p>
    </section>}

    {cited.length > 0 && <section className="sources" aria-labelledby="sources-heading">
      <h2 id="sources-heading" className="visually-hidden">{cited.length === 1 ? "Source" : "Sources"}</h2>
      <ol className="sources__list">{cited.map((result, position) => source(result, numbered ? position + 1 : null, false, position + 1))}</ol>
    </section>}

    {others.length > 0 && <section className="sources" aria-labelledby="others-heading">
      {cited.length > 0
        ? <h2 id="others-heading" className="group-title sources__title">{plural(others.length, "more document")}</h2>
        : <h2 id="others-heading" className="visually-hidden">Documents</h2>}
      <ol className="sources__list">{others.map((result, position) => source(result, null, true, cited.length + position + 1))}</ol>
    </section>}
  </div>;
}

/** Which page the strip shows, when the document has more than one, and how many matches it cannot show. */
function pageCaption(page: number, pageCount: number, found: Found | null, exact: boolean): string | null {
  if (pageCount <= 1) return null;
  if (exact && found && found.places > found.shown) return `${plural(found.places, "match", "matches")} on page ${page} of ${pageCount}`;
  return `Page ${page} of ${pageCount}`;
}

function Source({ order, result, number, why, exact, hinted, onOpen }: {
  order: number;
  result: SearchResult;
  number: number | null;
  /** Show the agent's reason; a cited document's evidence is already in the answer and on the strip. */
  why: boolean;
  exact: string | null;
  hinted: boolean;
  onOpen: Open;
}) {
  const [found, setFound] = useState<Found | null>(null);
  const { document } = result;
  const name = documentName(document);
  const passage = placedPassage(result);
  const page = passage?.page ?? 1;
  const terms = termsFor(result, exact);
  const day = documentDate(document);
  // A title that names the day already says what the date line would.
  const date = namesDay(name, day) ? null : formatDay(day);
  const reason = why && result.reason ? tidy(result.reason) : null;
  // An exact match found only in the summary has no place on the paper, so the summary line shows it.
  const summary = exact && passage?.kind === "summary" ? passage.snippet : null;
  const otherPages = [...new Set(result.passages.filter((item) => item.kind === "page" && item.page !== page).map((item) => item.page))];
  const caption = summary ? null : pageCaption(page, document.page_count, found, exact !== null);

  return <li className={`source${hinted ? " is-hinted" : ""}`} style={{ ["--i" as string]: order }}>
    <div className="source__text">
      <h3 className="source__title">
        {number !== null && <><span className="source__n" aria-hidden="true">{number}</span><span className="visually-hidden">Source {number}: </span></>}
        {name}
      </h3>
      {(document.sender || date) && <p className="source__meta">
        {document.sender && <span>{document.sender}{date ? ", " : ""}</span>}
        {date && <span className="source__date">{date}</span>}
      </p>}
      {reason && <p className="source__why">{reason}</p>}
      {summary && <p className="source__why"><Marked text={excerptAround(summary, exact ?? "")} terms={exact ? [exact] : []} /></p>}
      {otherPages.length > 0 && <p className="source__pages">
        <span>Also on</span>
        {otherPages.map((other) => <button key={other} type="button" className="page-link" onClick={() => onOpen(document, other, terms)}>page {other}</button>)}
      </p>}
    </div>
    <figure className="source__paper">
      <PaperCrop
        document={document}
        page={page}
        terms={summary ? [] : terms}
        shape={STRIP}
        label={`Page ${page} of ${name}${terms.length && !summary ? ", with the matching text outlined" : ""}`}
        onFound={setFound}
      />
      {caption && <figcaption className="source__where">{caption}</figcaption>}
    </figure>
    <button type="button" className="cover" aria-label={`Open ${name} at page ${page}`} onClick={() => onOpen(document, page, terms)} />
  </li>;
}
