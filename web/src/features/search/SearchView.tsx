import { createMemo, createProjection, createSignal, For, Match, Repeat, Show, Switch, useContext } from "solid-js";
import type { AgentProgress, SearchPassage } from "../../client/api";
import { FilterBar, FilterToggle } from "../../components/FilterBar";
import { BookOpen, ChevronDown, List, Search } from "../../components/Icons";
import { Marked } from "../../components/Marked";
import { EmptyState, Spinner } from "../../components/ui";
import { evidenceTerms, type FrameShape } from "../../lib/evidenceHighlight";
import { activeFilterCount, documentDate, documentName, formatDay, plural } from "../../lib/format";
import { AppContext } from "../../state/app";
import type { SearchResult } from "../../state/search";
import { initialQuery } from "../../state/url";
import { PaperCrop } from "./PaperCrop";

const EXCERPT_CHARS = 220;
const STRIP: FrameShape = { width: 0.45, minAspect: 1.5, maxAspect: 3.2 };
const NO_TERMS: string[] = [];

function excerptAround(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const index = flat.toLocaleLowerCase().indexOf(needle.replace(/\s+/g, " ").toLocaleLowerCase());
  if (flat.length <= EXCERPT_CHARS || index < 0) return flat;
  const start = Math.max(0, Math.min(index - Math.floor(EXCERPT_CHARS / 3), flat.length - EXCERPT_CHARS));
  const end = start + EXCERPT_CHARS;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

function tidy(text: string): string {
  return text.replace(/(\d) (€|%|EUR\b)/g, "$1\u00a0$2");
}

function namesDay(title: string, day: Date): boolean {
  const d = day.getDate();
  const m = day.getMonth() + 1;
  const y = day.getFullYear();
  const two = (value: number) => String(value).padStart(2, "0");
  return [`${two(d)}.${two(m)}.${y}`, `${d}.${m}.${y}`, `${y}-${two(m)}-${two(d)}`, formatDay(day)].some((form) => title.includes(form));
}

function StepIcon(props: { kind: AgentProgress["kind"] }) {
  return <Switch fallback={<Search size={15} aria-hidden="true" />}>
    <Match when={props.kind === "list"}><List size={15} aria-hidden="true" /></Match>
    <Match when={props.kind === "read"}><BookOpen size={15} aria-hidden="true" /></Match>
  </Switch>;
}

function TrailLine(props: { running: boolean; outcome: string }) {
  const { search } = useContext(AppContext);
  return <Show when={props.running} fallback={<span class="trail__outcome">{props.outcome}</span>}>
    <Spinner size={15} />
    <Show when={search.current || "Starting the search"} keyed>{(label) => <span class="trail__current">{label}</span>}</Show>
  </Show>;
}

function Trail(props: { running: boolean; outcome: string }) {
  const { search } = useContext(AppContext);
  const lineClass = () => ["trail__line", { "trail__line--live": props.running }];
  return <Show when={search.steps[0]}
    fallback={<p class={lineClass()}><TrailLine running={props.running} outcome={props.outcome} /></p>}>
    <details class="trail">
      <summary class={lineClass()}><TrailLine running={props.running} outcome={props.outcome} /><ChevronDown size={14} aria-hidden="true" /></summary>
      <ol class="trail__steps">
        <For each={search.steps}>{(step) => <li class="trail__step"><StepIcon kind={step.kind} /><span>{step.label}</span></li>}</For>
      </ol>
    </details>
  </Show>;
}

function placedPassage(result: SearchResult): SearchPassage | undefined {
  return result.passages.find((passage) => passage.kind === "page") ?? result.passages[0];
}

function termsFor(result: SearchResult, exact: string | null): string[] {
  return exact ? [exact] : evidenceTerms(result.reason);
}

export function SearchView(props: { query: string }) {
  const { url, search } = useContext(AppContext);
  const count = () => activeFilterCount(url.state.query, false);

  return <>
    <h1 id="search-title" class="visually-hidden">Search results for “{search.exact ?? props.query}”</h1>
    <header class={["ask", { "ask--empty": Boolean(search.notice) }]}>
      <div class="ask__status">
        <Show when={search.notice} keyed fallback={
          <Show when={search.exact} keyed fallback={<Trail running={search.running}
            outcome={`Found ${plural(search.results.length, "document")} in ${search.seconds.toFixed(1)} s`} />}>
            {(quote) => <Show when={search.running} fallback={<p class="trail__line">{plural(search.results.length, "document")} {search.results.length === 1 ? "contains" : "contain"} <span class="ask__quote">“{quote}”</span></p>}>
              <p class="trail__line trail__line--live"><Spinner size={15} /><span class="trail__current">Looking for “{quote}” as written</span></p>
            </Show>}
          </Show>
        }>{(notice) => <Show when={notice.kind === "failed"} fallback={
          <EmptyState live title="No document matches" action={count() > 0 && <button type="button" class="btn" onClick={() => url.updateQuery(initialQuery)}>Clear filters</button>}>
            {search.exact
              ? `No page contains “${search.exact}” as written. Search without quotes to find it by what it means.`
              : count() > 0
                ? "Nothing within the current filters matches. Clear them to search the whole library."
                : "Describe the document differently, or put words in quotes to find that exact text."}
          </EmptyState>
        }>
            <EmptyState alert title={search.exact ? "The exact-text search failed" : "The search stopped before it found anything"}
              action={<button type="button" class="btn" onClick={url.rerunSearch}>Search again</button>}>
              {notice.kind === "failed" ? notice.message : undefined}
            </EmptyState>
            <Show when={search.steps[0]}><Trail running={false} outcome={`${plural(search.steps.length, "lookup")} before it stopped`} /></Show>
          </Show>}
        </Show>
      </div>
      <div class="ask__tools"><FilterToggle count={count()} /></div>
    </header>
    <p class="visually-hidden" aria-live="polite">{search.running ? "Searching" : search.results.length > 0 ? `Found ${plural(search.results.length, "document")}` : ""}</p>
    <FilterBar count={count()} />
    <Show when={search.running}><Placeholder answer={!search.exact} /></Show>
    <Show when={search.results[0]}><Results /></Show>
  </>;
}

function Placeholder(props: { answer: boolean }) {
  return <div class="placeholder" aria-hidden="true">
    <Show when={props.answer}><div class="answer"><span class="skeleton skeleton--text" /><span class="skeleton skeleton--text skeleton--short" /></div></Show>
    <ol class="sources__list">
      <Repeat count={3}>{() => <li class="source">
        <div class="source__text">
          <span class="skeleton skeleton--line skeleton--title" />
          <span class="skeleton skeleton--line skeleton--short" />
        </div>
        <div class="source__paper"><span class="paper paper--loading" style={{ "aspect-ratio": String(STRIP.maxAspect) }} /></div>
      </li>}</Repeat>
    </ol>
  </div>;
}

function stepThroughSources(event: KeyboardEvent & { currentTarget: HTMLDivElement }) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches(".source > .cover")) return;
  const covers = [...event.currentTarget.querySelectorAll<HTMLElement>(".source > .cover")];
  const next = covers[covers.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
  next.closest(".source")?.scrollIntoView({ block: "nearest" });
}

function Results() {
  const { search, url } = useContext(AppContext);
  const [hinted, setHinted] = createSignal<number | null>(null, { name: "hinted citation" });
  const hints = createProjection<Record<number, true>>(() => {
    const id = hinted();
    return id === null ? {} : { [id]: true };
  }, {}, { name: "citation hints" });
  const text = () => search.answer?.text ? tidy(search.answer.text) : null;
  const lists = createMemo(() => {
    const results = search.results;
    const cited = new Set(text() ? search.answer?.citations.filter((index) => results[index]) : []);
    return {
      cited: Array.from(cited, (index) => results[index]),
      others: results.filter((_, index) => !cited.has(index)),
      numbered: cited.size > 0 && cited.size < results.length,
    };
  }, { name: "citation order" });
  const cited = () => lists().cited;
  const others = () => lists().others;

  function open(result: SearchResult) {
    url.openDocument(result.document.document_id, placedPassage(result)?.page ?? 1, termsFor(result, search.exact));
  }

  return <div class="results" onKeyDown={stepThroughSources}>
    <Show when={text()}>{(answer) => <section class="answer" aria-labelledby="answer-heading">
      <h2 id="answer-heading" class="visually-hidden">Answer</h2>
      <p class="answer__text">
        {answer()}
        <Show when={lists().numbered}><span class="cites">
          <For each={cited()}>{(result, index) => {
            const id = () => result.document.document_id;
            const name = () => documentName(result.document);
            return <button
              type="button"
              class={["badge", "cite", { "is-hinted": hints[id()] }]}
              aria-label={`Source ${index() + 1}: open ${name()}, page ${placedPassage(result)?.page ?? 1}`}
              title={name()}
              onMouseEnter={() => setHinted(id())}
              onMouseLeave={() => setHinted(null)}
              onFocus={() => setHinted(id())}
              onBlur={() => setHinted(null)}
              onClick={() => open(result)}
            >{index() + 1}</button>;
          }}</For>
        </span></Show>
      </p>
    </section>}</Show>

    <Show when={cited().length > 0}><section class="sources" aria-labelledby="sources-heading">
      <h2 id="sources-heading" class="visually-hidden">{cited().length === 1 ? "Source" : "Sources"}</h2>
      <ol class="sources__list"><For each={cited()}>{(result, index) => <Source
        result={result} order={index() + 1} number={lists().numbered ? index() + 1 : null} hinted={hints[result.document.document_id] === true}
      />}</For></ol>
    </section></Show>

    <Show when={others().length > 0}><section class="sources" aria-labelledby="others-heading">
      <Show when={cited().length > 0} fallback={<h2 id="others-heading" class="visually-hidden">Documents</h2>}>
        <h2 id="others-heading" class="group-title sources__title">{plural(others().length, "more document")}</h2>
      </Show>
      <ol class="sources__list"><For each={others()}>{(result, index) => <Source
        result={result} order={cited().length + index() + 1} number={null} why
      />}</For></ol>
    </section></Show>
  </div>;
}

function Source(props: { result: SearchResult; order: number; number: number | null; why?: boolean; hinted?: boolean }) {
  const { url, search } = useContext(AppContext);
  const doc = () => props.result.document;
  const name = createMemo(() => documentName(doc()), { name: "source title" });
  const passage = createMemo(() => placedPassage(props.result), { name: "source passage" });
  const page = () => passage()?.page ?? 1;
  const terms = createMemo(() => termsFor(props.result, search.exact), { name: "source terms" });
  const date = createMemo(() => {
    const day = documentDate(doc());
    return namesDay(name(), day) ? null : formatDay(day);
  }, { name: "source date" });
  const reason = () => props.why && props.result.reason ? tidy(props.result.reason) : null;
  const summary = () => search.exact && passage()?.kind === "summary" ? passage()?.snippet : null;
  const otherPages = createMemo(() => [...new Set(props.result.passages.filter((item) => item.kind === "page" && item.page !== page()).map((item) => item.page))], { name: "other source pages" });

  function open(onPage: number) {
    url.openDocument(doc().document_id, onPage, terms());
  }

  return <li class={["source", { "is-hinted": props.hinted }]} style={{ "--i": props.order }}>
    <div class="source__text">
      <h3 class="source__title">
        <Show when={props.number}>{(number) => <><span class="source__n" aria-hidden="true">{number()}</span><span class="visually-hidden">Source {number()}: </span></>}</Show>
        {name()}
      </h3>
      <Show when={doc().sender || date()}><p class="source__meta">
        <Show when={doc().sender}>{(sender) => <span>{sender()}{date() ? ", " : ""}</span>}</Show>
        <Show when={date()}>{(day) => <span class="source__date">{day()}</span>}</Show>
      </p></Show>
      <Show when={reason()}>{(text) => <p class="source__why">{text()}</p>}</Show>
      <Show when={summary()}>{(text) => <p class="source__why"><Marked text={excerptAround(text(), search.exact ?? "")} term={search.exact ?? ""} /></p>}</Show>
      <Show when={otherPages().length > 0}><p class="source__pages">
        <span>Also on</span>
        <For each={otherPages()}>{(other) => <button type="button" class="page-link" onClick={() => open(other)}>page {other}</button>}</For>
      </p></Show>
    </div>
    <PaperCrop document={doc()} page={page()} terms={summary() ? NO_TERMS : terms()} exact={search.exact !== null}
      summary={Boolean(summary())} shape={STRIP}
      label={`Page ${page()} of ${name()}${terms().length && !summary() ? ", with the matching text outlined" : ""}`} />
    <button type="button" class="cover" aria-label={`Open ${name()} at page ${page()}`} onClick={() => open(page())} />
  </li>;
}
