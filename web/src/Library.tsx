import { ChevronDown, ChevronLeft, ChevronRight, LayoutGrid, Rows3, SlidersHorizontal, Upload } from "lucide-react";
import type { Document, DocumentPageResult, DocumentSort, LibraryQuery } from "./api";
import { documentDate, documentName, formatBytes, formatDay, groupDocuments, isProcessing, plural, type Group } from "./format";
import { useGrooveThumb } from "./motion";
import { EmptyState, StageMeter, Thumbnail } from "./ui";

export type View = "grid" | "list";

export const initialQuery: LibraryQuery = {
  page: 1,
  pageSize: 24,
  sender: "",
  createdFrom: "",
  createdTo: "",
  sort: "document_date_desc",
};

const SORT_LABELS: Record<DocumentSort, string> = {
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

/** How many filters narrow the list; sort counts only where the list can be sorted. */
export function activeFilterCount(query: LibraryQuery, withSort: boolean): number {
  return [query.sender, query.createdFrom, query.createdTo, withSort && query.sort !== initialQuery.sort].filter(Boolean).length;
}

export function FilterToggle({ open, count, onToggle }: { open: boolean; count: number; onToggle: () => void }) {
  return <button type="button" className="btn filter-toggle" aria-expanded={open} aria-controls="document-filters" onClick={onToggle}>
    <SlidersHorizontal size={16} aria-hidden="true" />
    {count > 0 ? `Filters (${count})` : "Filters"}
  </button>;
}

export function FilterBar({ query, senders, open, withSort, onChange }: {
  query: LibraryQuery;
  senders: string[];
  open: boolean;
  withSort: boolean;
  onChange: (query: LibraryQuery) => void;
}) {
  const count = activeFilterCount(query, withSort);
  return <div className={`filters${open ? " is-open" : ""}`} id="document-filters" role="group" aria-label="Filter documents">
    <label className="field field--sender">
      <span className="field__label">Sender</span>
      <input className="input" list="sender-options" value={query.sender} placeholder="All senders" autoComplete="off" onChange={(event) => onChange({ ...query, sender: event.target.value })} />
      <datalist id="sender-options">{senders.map((sender) => <option key={sender} value={sender} />)}</datalist>
    </label>
    <label className="field field--date">
      <span className="field__label">From</span>
      <input className="input" type="date" value={query.createdFrom} max={query.createdTo || undefined} onChange={(event) => onChange({ ...query, createdFrom: event.target.value })} />
    </label>
    <label className="field field--date">
      <span className="field__label">To</span>
      <input className="input" type="date" value={query.createdTo} min={query.createdFrom || undefined} onChange={(event) => onChange({ ...query, createdTo: event.target.value })} />
    </label>
    {withSort && <label className="field field--sort">
      <span className="field__label">Sort</span>
      <span className="select">
        <select className="input" value={query.sort} onChange={(event) => onChange({ ...query, sort: event.target.value as DocumentSort })}>
          {Object.entries(SORT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <ChevronDown size={16} aria-hidden="true" />
      </span>
    </label>}
    {count > 0 && <button type="button" className="btn btn--text filters__reset" onClick={() => onChange(initialQuery)}>Reset filters</button>}
  </div>;
}

function ViewSwitch({ view, onView }: { view: View; onView: (view: View) => void }) {
  const groove = useGrooveThumb(view);
  return <div className="groove" ref={groove} role="group" aria-label="Document view">
    <button type="button" className="groove__option" aria-pressed={view === "grid"} onClick={() => onView("grid")}><LayoutGrid size={16} aria-hidden="true" /> Grid</button>
    <button type="button" className="groove__option" aria-pressed={view === "list"} onClick={() => onView("list")}><Rows3 size={16} aria-hidden="true" /> List</button>
  </div>;
}

type Handlers = { onOpen: (document: Document) => void; onFilterSender: (sender: string) => void };

function SenderLink({ sender, onFilterSender }: { sender: string; onFilterSender: (sender: string) => void }) {
  return <button type="button" className="sender-link" title={`Show only ${sender}`} onClick={() => onFilterSender(sender)}>{sender}</button>;
}

function SheetCard({ document, priority, onOpen, onFilterSender }: { document: Document; priority: boolean } & Handlers) {
  const name = documentName(document);
  const date = documentDate(document);
  return <article className="sheet-card">
    <button type="button" className="cover" aria-label={`Open ${name}`} onClick={() => onOpen(document)} />
    <div className="sheet sheet--thumb">
      <Thumbnail key={document.status} document={document} priority={priority} />
      {isProcessing(document) && <StageMeter document={document} className="stage--on-sheet" />}
    </div>
    <div className="sheet-card__text">
      <h3 className="sheet-card__title">{name}</h3>
      {document.sender && <SenderLink sender={document.sender} onFilterSender={onFilterSender} />}
      <p className="sheet-card__meta">
        <time dateTime={date.toISOString()}>{formatDay(date)}</time>
        <span>{document.page_count ? plural(document.page_count, "page") : formatBytes(document.file_size)}</span>
      </p>
      {document.status === "FAILED" && <p className="status status--failed">Processing failed</p>}
      {document.last_error && <p className="error-text">{document.last_error}</p>}
    </div>
  </article>;
}

/** The first row or so of sheets is on screen at once, so it loads before the rest. */
const EAGER_SHEETS = 6;

function Shelf({ groups, ...handlers }: { groups: Group[] } & Handlers) {
  let index = 0;
  return <div className="shelf">
    {groups.map((group) => <section key={group.key} className="shelf-group" aria-label={group.label ?? "Documents"}>
      {group.label && <h2 className="group-title">{group.label}</h2>}
      <ul className="sheet-grid" role="list">
        {group.items.map((document) => {
          const at = index++;
          return <li key={document.document_id} style={{ ["--i" as string]: at }}><SheetCard document={document} priority={at < EAGER_SHEETS} {...handlers} /></li>;
        })}
      </ul>
    </section>)}
  </div>;
}

function Ledger({ groups, onOpen, onFilterSender }: { groups: Group[] } & Handlers) {
  let index = 0;
  return <div className="ledger-wrap">
    <table className="ledger">
      <thead>
        <tr><th scope="col">Document</th><th scope="col">Sender</th><th scope="col">Date</th><th scope="col" className="num">Pages</th><th scope="col" className="num">Size</th><th scope="col">Added</th></tr>
      </thead>
      {groups.map((group) => <tbody key={group.key}>
        {group.label && <tr className="ledger__group"><th scope="colgroup" colSpan={6}>{group.label}</th></tr>}
        {group.items.map((document) => {
          const name = documentName(document);
          return <tr key={document.document_id} className="ledger__row" style={{ ["--i" as string]: index++ }}>
            <td className="ledger__doc">
              <button type="button" className="cover" aria-label={`Open ${name}`} onClick={() => onOpen(document)} />
              <div className="ledger__doc-inner">
                <span className="sheet sheet--mini"><Thumbnail key={document.status} document={document} /></span>
                <span className="ledger__name">
                  <span className="ledger__title">{name}</span>
                  {isProcessing(document) && <StageMeter document={document} className="stage--inline" />}
                  {document.status === "FAILED" && <span className="status status--failed">Processing failed</span>}
                </span>
              </div>
            </td>
            <td className="ledger__sender">{document.sender && <SenderLink sender={document.sender} onFilterSender={onFilterSender} />}</td>
            <td className="fig">{formatDay(documentDate(document))}</td>
            <td className="fig num">{document.page_count || ""}</td>
            <td className="fig num">{formatBytes(document.file_size)}</td>
            <td className="fig ledger__added">{formatDay(document.added_at)}</td>
          </tr>;
        })}
      </tbody>)}
    </table>
  </div>;
}

function ShelfSkeleton({ view }: { view: View }) {
  if (view === "list") {
    return <div className="ledger-skeleton" aria-busy="true" aria-label="Loading your documents">
      {Array.from({ length: 8 }, (_, index) => <span key={index} className="skeleton skeleton--row" />)}
    </div>;
  }
  return <ul className="sheet-grid" role="list" aria-busy="true" aria-label="Loading your documents">
    {Array.from({ length: 12 }, (_, index) => <li key={index} className="sheet-card">
      <span className="sheet sheet--thumb skeleton" />
      <span className="skeleton skeleton--line" />
      <span className="skeleton skeleton--line skeleton--short" />
    </li>)}
  </ul>;
}

export function Library({ query, library, loading, senders, view, filtersOpen, onToggleFilters, onView, onQuery, onPage, onOpen, onFilterSender, onUpload, onRetry }: {
  query: LibraryQuery;
  library: DocumentPageResult | null;
  loading: boolean;
  senders: string[];
  view: View;
  filtersOpen: boolean;
  onToggleFilters: () => void;
  onView: (view: View) => void;
  onQuery: (query: LibraryQuery) => void;
  onPage: (page: number) => void;
  onUpload: () => void;
  onRetry: () => void;
} & Handlers) {
  const filters = activeFilterCount(query, true);
  const narrowed = Boolean(query.sender || query.createdFrom || query.createdTo);
  const pages = library ? Math.max(1, Math.ceil(library.total / query.pageSize)) : 1;
  const groups = library ? groupDocuments(library.items, query.sort) : [];
  const empty = library !== null && !narrowed && library.total === 0;

  let body;
  if (loading && !library) body = <ShelfSkeleton view={view} />;
  else if (!library) {
    body = <EmptyState alert title="The library could not be loaded" action={<button type="button" className="btn" onClick={onRetry}>Try again</button>}>
      Check that the Paperless AGX server is running, then try again.
    </EmptyState>;
  } else if (empty) {
    body = <div className="dropzone">
      <span className="sheet dropzone__sheet" aria-hidden="true"><Upload size={28} /></span>
      <div className="dropzone__text">
        <h2 className="empty__title">Your library is empty</h2>
        <p>Drop scans and PDFs anywhere on this page, or choose them from your computer. PDF, PNG, JPEG, TIFF and WebP files are read and indexed for search.</p>
        <div className="empty__actions"><button type="button" className="btn" onClick={onUpload}><Upload size={16} aria-hidden="true" /> Choose files</button></div>
      </div>
    </div>;
  } else if (library.items.length === 0) {
    body = <EmptyState title="No documents match these filters" action={<button type="button" className="btn" onClick={() => onQuery(initialQuery)}>Clear filters</button>}>
      Remove a filter to see more of the library.
    </EmptyState>;
  } else if (view === "grid") body = <Shelf groups={groups} onOpen={onOpen} onFilterSender={onFilterSender} />;
  else body = <Ledger groups={groups} onOpen={onOpen} onFilterSender={onFilterSender} />;

  return <section className="view" aria-labelledby="library-title">
    <header className="view-head">
      <div className="view-head__title">
        <h1 id="library-title">Library</h1>
        <p className="view-head__count" aria-live="polite">{library ? plural(library.total, "document") : ""}</p>
      </div>
      {!empty && <div className="view-head__tools">
        <FilterToggle open={filtersOpen} count={filters} onToggle={onToggleFilters} />
        <ViewSwitch view={view} onView={onView} />
      </div>}
    </header>
    {!empty && <FilterBar query={query} senders={senders} open={filtersOpen} withSort onChange={onQuery} />}
    {body}
    {library && library.total > query.pageSize && <nav className="pager" aria-label="Library pages">
      <button type="button" className="btn" disabled={query.page === 1} onClick={() => onPage(query.page - 1)}><ChevronLeft size={16} aria-hidden="true" /> Previous</button>
      <p className="pager__where">Page {query.page} of {pages}</p>
      <button type="button" className="btn" disabled={query.page >= pages} onClick={() => onPage(query.page + 1)}>Next <ChevronRight size={16} aria-hidden="true" /></button>
    </nav>}
  </section>;
}
