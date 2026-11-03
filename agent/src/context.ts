import type { CheckedResult } from "./results.ts";
import type { Document, SearchPassage } from "./types.ts";

/** Sender and dates the user picked in the UI; every lookup applies them. */
export type UserLimits = {
  sender: string | null;
  createdFrom: string | null;
  createdTo: string | null;
};

/** What one agent run has seen. Results may only cite documents and passages from here. */
export class RunContext {
  readonly documents = new Map<number, Document>();
  readonly passages = new Map<number, { documentId: number; passage: SearchPassage }>();
  /** Page text the agent read or saw in a passage, keyed by `documentId:page`. */
  private readonly pageText = new Map<string, string[]>();
  /** Set for the last turn: unknown document IDs are then dropped instead of rejected. */
  finalTurn = false;
  submission: CheckedResult | null = null;

  constructor(readonly limits: UserLimits) {}

  rememberDocument(document: Document): void {
    this.documents.set(document.document_id, document);
  }

  rememberPassage(documentId: number, passage: SearchPassage): void {
    this.passages.set(passage.chunk_id, { documentId, passage });
    if (passage.kind === "page") this.rememberPage(documentId, passage.page, passage.snippet);
  }

  rememberPage(documentId: number, page: number, text: string): void {
    const key = `${documentId}:${page}`;
    this.pageText.set(key, [...(this.pageText.get(key) ?? []), flatten(text)]);
  }

  /** Returns the quote as it appears on the page (whitespace collapsed), or null. */
  verifyQuote(documentId: number, page: number, quote: string): string | null {
    const wanted = flatten(quote.replace(/^["'„“”…\s.]+|["'„“”…\s.]+$/g, ""));
    if (wanted.length < 3) return null;
    const texts = this.pageText.get(`${documentId}:${page}`) ?? [];
    return texts.some((text) => text.includes(wanted)) ? wanted : null;
  }
}

export function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A window of the text around the first query term it contains. */
export function excerpt(text: string, query: string, maxChars: number): string {
  const flat = flatten(text);
  if (flat.length <= maxChars) return flat;
  const lower = flat.toLowerCase();
  let hit = -1;
  for (const term of query.toLowerCase().split(/\s+/).filter((term) => term.length >= 3)) {
    const index = lower.indexOf(term);
    if (index >= 0 && (hit < 0 || index < hit)) hit = index;
  }
  const start = hit < 0 ? 0 : Math.max(0, Math.min(hit - Math.floor(maxChars / 3), flat.length - maxChars));
  const end = start + maxChars;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
