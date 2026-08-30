import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, LoaderCircle } from "lucide-react";
import {
  answerSearch,
  getDocument,
  getPages,
  type Document,
  type PageInfo,
  type SearchAnswerResponse,
  type SearchHit,
  type SearchPassage,
} from "./api";
import { DocumentTitle } from "./DocumentTitle";
import { Marked } from "./library";
import { OcrTextLayer } from "./OcrTextLayer";
import { PdfViewer } from "./PdfViewer";

export type SearchResult = { document: Document; hit?: SearchHit };

type Selection = { documentId: number; chunkId: number | null };
type EvidenceTarget = { result: SearchResult; passage: SearchPassage };

function passagesFor(result: SearchResult): SearchPassage[] {
  if (result.hit?.passages.length) return result.hit.passages;
  if (!result.hit) return [];
  return [{
    chunk_id: result.hit.best_chunk_id,
    page: result.hit.page,
    char_start: 0,
    char_end: result.hit.snippet.length,
    snippet: result.hit.snippet,
    score: result.hit.score,
  }];
}

function firstSelection(result: SearchResult): Selection {
  return { documentId: result.document.document_id, chunkId: passagesFor(result)[0]?.chunk_id ?? null };
}

function formatDate(document: Document): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(document.created_at || document.added_at));
}

export function SearchWorkspace({ query, results, terms, loading, onOpen }: {
  query: string;
  results: SearchResult[];
  terms: string[];
  loading: boolean;
  onOpen: (document: Document, page: number, highlight?: string) => void;
}) {
  const [selection, setSelection] = useState<Selection>(() => firstSelection(results[0]));
  const [document, setDocument] = useState<Document | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState("");
  const [answer, setAnswer] = useState<SearchAnswerResponse | null>(null);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [answerError, setAnswerError] = useState("");
  const previewRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setSelection((current) => {
      const retained = results.find((result) => result.document.document_id === current.documentId);
      if (retained && (current.chunkId === null || passagesFor(retained).some((passage) => passage.chunk_id === current.chunkId))) return current;
      return firstSelection(results[0]);
    });
  }, [results]);

  const selectedResult = results.find((result) => result.document.document_id === selection.documentId) ?? results[0];
  const selectedPassage = selectedResult
    ? passagesFor(selectedResult).find((passage) => passage.chunk_id === selection.chunkId) ?? passagesFor(selectedResult)[0]
    : undefined;
  const page = selectedPassage?.page ?? selectedResult?.hit?.page ?? 1;
  const highlight = selectedPassage?.snippet ?? selectedResult?.hit?.snippet;

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
        if (!cancelled) setPreviewError(cause instanceof Error ? cause.message : "The evidence preview failed to load.");
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedResult?.document.document_id, selectedResult?.document.status]);

  const answerTargets = useMemo(() => {
    const targets = new Map<number, EvidenceTarget>();
    for (const result of results) {
      for (const passage of passagesFor(result)) {
        if (!targets.has(passage.chunk_id)) targets.set(passage.chunk_id, { result, passage });
      }
    }
    return [...targets.values()].sort((left, right) => right.passage.score - left.passage.score).slice(0, 12);
  }, [results]);
  const answerKey = answerTargets.map(({ passage }) => passage.chunk_id).join(",");

  useEffect(() => {
    setAnswer(null);
    setAnswerError("");
    if (!answerKey) {
      setAnswerLoading(false);
      return;
    }
    let cancelled = false;
    setAnswerLoading(true);
    void answerSearch(query, answerTargets.map(({ passage }) => passage.chunk_id))
      .then((response) => {
        if (!cancelled) setAnswer(response);
      })
      .catch(() => {
        if (!cancelled) setAnswerError("An answer could not be prepared. The evidence results are still available.");
      })
      .finally(() => {
        if (!cancelled) setAnswerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [answerKey, query]);

  const citedTargets = answer?.citations.flatMap((chunkId) => {
    const target = answerTargets.find(({ passage }) => passage.chunk_id === chunkId);
    return target ? [target] : [];
  }).filter((target, index, all) => all.findIndex(({ passage }) => passage.chunk_id === target.passage.chunk_id) === index) ?? [];
  const supportedAnswer = answer?.answer && citedTargets.length > 0 ? answer.answer : null;
  const previewMatchesSelection = document?.document_id === selectedResult?.document.document_id;
  const currentPage = previewMatchesSelection ? pages.find((candidate) => candidate.page === page) : undefined;
  const previewDocument = previewMatchesSelection ? document : selectedResult?.document;

  function selectTarget(target: EvidenceTarget, reveal = false) {
    setSelection({ documentId: target.result.document.document_id, chunkId: target.passage.chunk_id });
    if (reveal && window.matchMedia("(max-width: 760px)").matches) {
      window.requestAnimationFrame(() => previewRef.current?.scrollIntoView({ block: "start" }));
    }
  }

  return <section className="search-experience" aria-busy={loading}>
    {supportedAnswer && <section className="search-answer" aria-labelledby="answer-heading" aria-live="polite">
      <p className="evidence-label">Answer from your documents</p>
      <h3 id="answer-heading">{supportedAnswer}</h3>
      <div className="answer-citations" aria-label="Answer evidence">
        {citedTargets.map((target, index) => <button key={target.passage.chunk_id} onClick={() => selectTarget(target, true)}>
          <span>{index + 1}</span>
          {target.result.document.title || target.result.document.filename} · p. {target.passage.page}
        </button>)}
      </div>
    </section>}
    {answerLoading && <p className="answer-status" role="status"><LoaderCircle className="spin" size={13} aria-hidden="true" /> Finding a supported answer…</p>}
    {answerError && <p className="answer-status" role="status">{answerError}</p>}

    <div className="search-workspace">
      <section className="result-rail" aria-label="Matching documents">
        {results.map((result) => {
          const passages = passagesFor(result);
          const selected = result.document.document_id === selectedResult?.document.document_id;
          return <article key={result.document.document_id} className={`search-result${selected ? " selected" : ""}`}>
            <button className="result-heading" aria-pressed={selected} onClick={() => setSelection(firstSelection(result))}>
              <img src={`/api/documents/${result.document.document_id}/thumbnails/1`} alt="" loading="lazy" />
              <span>
                <strong><DocumentTitle document={result.document} /></strong>
                <small>{formatDate(result.document)}{result.document.page_count ? ` · ${result.document.page_count} p.` : ""}</small>
              </span>
            </button>
            {passages.length > 0 ? <div className="result-passages" aria-label={`Evidence in ${result.document.title || result.document.filename}`}>
              {passages.map((passage) => <button
                key={passage.chunk_id}
                aria-pressed={selected && selectedPassage?.chunk_id === passage.chunk_id}
                className={selected && selectedPassage?.chunk_id === passage.chunk_id ? "selected" : ""}
                onClick={() => selectTarget({ result, passage })}
              >
                <span className="passage-page">Page {passage.page}</span>
                <Marked text={passage.snippet} terms={terms} />
              </button>)}
            </div> : <p className="metadata-match">Matched document details · page 1</p>}
          </article>;
        })}
      </section>

      <section className="evidence-preview" ref={previewRef} aria-labelledby="evidence-preview-title">
        <header>
          <div>
            <p className="evidence-label">Evidence · page {page}</p>
            <h3 id="evidence-preview-title">{selectedResult && <DocumentTitle document={selectedResult.document} />}</h3>
          </div>
          {selectedResult && <button className="open-document" onClick={() => onOpen(selectedResult.document, page, highlight)}><FileText size={16} aria-hidden="true" /> Open document</button>}
        </header>
        <blockquote className="evidence-strip">
          {highlight ? <Marked text={highlight} terms={terms} /> : "This document matched its title, sender, or date."}
        </blockquote>
        <div className="evidence-page" aria-busy={previewLoading || !previewMatchesSelection}>
          {previewError ? <p className="preview-status viewer-error">{previewError}</p>
            : previewLoading || !previewMatchesSelection ? <p className="preview-status" role="status"><LoaderCircle className="spin" aria-hidden="true" /> Loading cited page</p>
              : previewDocument?.media_type === "pdf" ? <PdfViewer url={`/api/documents/${previewDocument.document_id}/file`} page={page} blocks={currentPage?.blocks ?? []} highlight={highlight} />
                : previewDocument ? <div className="ocr-page-frame image-page-frame"><img src={`/api/documents/${previewDocument.document_id}/file`} alt={previewDocument.title || previewDocument.filename} /><OcrTextLayer blocks={currentPage?.blocks ?? []} highlight={highlight} /></div>
                  : <p className="preview-status">Evidence is unavailable.</p>}
        </div>
      </section>
    </div>
  </section>;
}
