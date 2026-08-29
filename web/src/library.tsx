import type { Document, DocumentSort, LibraryQuery, SearchHit } from "./api";

export const initialQuery: LibraryQuery = {
  page: 1,
  pageSize: 24,
  sender: "",
  createdFrom: "",
  createdTo: "",
  sort: "document_date_desc",
};

export function FilterPanel({ query, senders, onChange }: { query: LibraryQuery; senders: string[]; onChange: (query: LibraryQuery) => void }) {
  return <section className="filter-panel">
    <label>Sender<input list="sender-options" value={query.sender} placeholder="All senders" onChange={(event) => onChange({ ...query, sender: event.target.value })} /><datalist id="sender-options">{senders.map((sender) => <option key={sender} value={sender} />)}</datalist></label>
    <label>From<input type="date" value={query.createdFrom} onChange={(event) => onChange({ ...query, createdFrom: event.target.value })} /></label>
    <label>To<input type="date" value={query.createdTo} onChange={(event) => onChange({ ...query, createdTo: event.target.value })} /></label>
    <label>Sort<select value={query.sort} onChange={(event) => onChange({ ...query, sort: event.target.value as DocumentSort })}><option value="document_date_desc">Document date · newest</option><option value="document_date_asc">Document date · oldest</option><option value="added_date_desc">Added · newest</option><option value="added_date_asc">Added · oldest</option><option value="title_asc">Title · A–Z</option><option value="title_desc">Title · Z–A</option><option value="sender_asc">Sender · A–Z</option><option value="sender_desc">Sender · Z–A</option><option value="file_size_desc">File size · largest</option><option value="file_size_asc">File size · smallest</option></select></label>
    <button className="text-button" onClick={() => onChange(initialQuery)}>Reset filters</button>
  </section>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function Marked({ text, terms }: { text: string; terms: string[] }) {
  const clean = terms.filter((term) => term.length > 0);
  if (clean.length === 0) return <>{text}</>;
  let pattern: RegExp;
  try {
    pattern = new RegExp(`(${clean.map(escapeRegExp).join("|")})`, "giu");
  } catch {
    return <>{text}</>;
  }
  const parts = text.split(pattern);
  return <>{parts.map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>))}</>;
}

export function DocumentCard({ document, hit, terms, onOpen }: { document: Document; hit?: SearchHit; terms: string[]; onOpen: () => void }) {
  const date = document.created_at || document.added_at;
  return <button className="document-card" onClick={onOpen}>
    <div className="thumbnail-wrap"><img key={document.status} src={`/api/documents/${document.document_id}/thumbnails/1`} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} /></div>
    <div className="card-body">
      {document.sender && <p className="card-sender">{document.sender}</p>}
      <div className="card-title-row"><h3>{document.title || document.filename}</h3><span className="card-size">{formatBytes(document.file_size)}</span></div>
      <p className="card-meta">{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(date))}</p>
      {document.status !== "READY" && <p className="card-status"><span className={`status status-${document.status.toLowerCase()}`}>{document.status.toLowerCase().replaceAll("_", " ")}</span></p>}
      {hit && <p className="snippet"><Marked text={hit.snippet} terms={terms} /></p>}
      {document.last_error && <p className="card-error">{document.last_error}</p>}
    </div>
  </button>;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}
