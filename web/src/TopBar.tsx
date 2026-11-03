import type { FormEvent, RefObject } from "react";
import { Search, TriangleAlert, Upload, X } from "lucide-react";
import type { HealthResponse } from "./api";
import { ThemeControl } from "./ThemeControl";
import { Spinner } from "./ui";

function HealthNotice({ health }: { health: HealthResponse | null }) {
  if (!health) return null;
  const missing = [
    !health.ocr_configured && `OCR (${health.ocr_model || "no model"})`,
    !health.embedding_configured && `search embeddings (${health.embedding_model || "no model"})`,
    health.agent_configured === false && "the search agent",
  ].filter((part): part is string => Boolean(part));
  if (missing.length === 0) return null;
  return <p className="health" title={`Not configured: ${missing.join(", ")}`}>
    <TriangleAlert size={16} aria-hidden="true" />
    <span className="health__label">Models not configured</span>
  </p>;
}

export function TopBar({ inputRef, text, searching, busy, uploading, health, onText, onSubmit, onClear, onHome, onUpload }: {
  inputRef: RefObject<HTMLInputElement | null>;
  text: string;
  searching: boolean;
  busy: boolean;
  uploading: boolean;
  health: HealthResponse | null;
  onText: (text: string) => void;
  onSubmit: (event: FormEvent) => void;
  onClear: () => void;
  onHome: () => void;
  onUpload: () => void;
}) {
  return <header className="bar">
    <div className="container bar__inner">
      <a className="wordmark" href="/" onClick={(event) => { event.preventDefault(); onHome(); }}>Paperless AGX</a>
      <form className="search-field" role="search" onSubmit={onSubmit} aria-busy={busy}>
        <Search className="search-field__icon" size={18} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          value={text}
          enterKeyHint="search"
          onChange={(event) => onText(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.blur(); }}
          placeholder="Ask a question, describe a document, or “quote” exact text"
          aria-label="Search documents"
        />
        <span className="search-field__end">
          {busy && <Spinner label="Searching" />}
          {text || searching
            ? <button type="button" className="icon-btn icon-btn--sm" aria-label="Clear search" onClick={onClear}><X size={16} aria-hidden="true" /></button>
            : <kbd className="search-field__key" title="Press / to search">/</kbd>}
        </span>
      </form>
      <div className="bar__actions">
        <HealthNotice health={health} />
        <ThemeControl />
        <button type="button" className="btn btn--ink" disabled={uploading} aria-busy={uploading} onClick={onUpload}>
          {uploading ? <Spinner /> : <Upload size={16} aria-hidden="true" />}
          <span className="btn__label">{uploading ? "Uploading" : "Upload"}</span>
        </button>
      </div>
    </div>
  </header>;
}
