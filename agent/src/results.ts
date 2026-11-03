import type { RunContext } from "./context.ts";
import type { SearchPassage } from "./types.ts";

export type SubmittedItem = {
  document_id: number;
  page: number | null;
  passage_id: number | null;
  quote: string | null;
  reason: string;
};

export type Submission = {
  results: SubmittedItem[];
  answer: string | null;
  answer_citations: number[] | null;
};

export type CheckedResult = {
  answer: string | null;
  citations: number[];
  results: { documentId: number; reason: string; passage: SearchPassage }[];
};

/**
 * Checks the agent's submission against what its tools returned. Strict mode rejects unknown
 * document IDs so the model can correct them; otherwise they are dropped. Passage text always
 * comes from the archive: a passage the search returned, or a quote found on the page.
 */
export function checkSubmission(
  context: RunContext,
  submission: Submission,
  options: { strict: boolean; maxResults: number },
): CheckedResult {
  const unknown = submission.results
    .map((item) => item.document_id)
    .filter((documentId) => !context.documents.has(documentId));
  if (options.strict && unknown.length > 0) {
    throw new Error(
      `Unknown document_id ${[...new Set(unknown)].join(", ")}. Cite only documents that search, list_documents or read_pages returned.`,
    );
  }

  const results: CheckedResult["results"] = [];
  const position = new Map<number, number>();
  const positionByDocument = new Map<number, number>();
  submission.results.forEach((item, index) => {
    const document = context.documents.get(item.document_id);
    if (!document) return;
    const existing = positionByDocument.get(item.document_id);
    if (existing !== undefined) {
      position.set(index, existing);
      return;
    }
    if (results.length >= options.maxResults) return;
    positionByDocument.set(item.document_id, results.length);
    position.set(index, results.length);
    results.push({
      documentId: item.document_id,
      reason: item.reason.trim().slice(0, 400),
      passage: evidence(context, item, Math.max(document.page_count, 1)),
    });
  });

  const citations = [
    ...new Set(
      (submission.answer_citations ?? [])
        .map((index) => position.get(index))
        .filter((index): index is number => index !== undefined),
    ),
  ];
  const answer = submission.answer?.trim() || null;
  return answer && citations.length > 0
    ? { answer, citations, results }
    : { answer: null, citations: [], results };
}

function evidence(context: RunContext, item: SubmittedItem, pageCount: number): SearchPassage {
  const known = item.passage_id === null ? undefined : context.passages.get(item.passage_id);
  if (known && known.documentId === item.document_id) return known.passage;
  const page = Math.min(Math.max(item.page ?? 1, 1), pageCount);
  const quote = item.quote ? context.verifyQuote(item.document_id, page, item.quote) : null;
  return {
    chunk_id: 0,
    page,
    char_start: 0,
    char_end: quote?.length ?? 0,
    snippet: quote ?? "",
    score: 0,
    kind: "page",
  };
}
