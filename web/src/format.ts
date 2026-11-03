import type { Document, DocumentSort } from "./api";

const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

export function documentName(document: Document): string {
  return document.title || document.filename;
}

/** The date the document carries, or the day it was added when it has none. */
export function documentDate(document: Document): Date {
  return new Date(document.created_at || document.added_at);
}

export function formatDay(value: Date | string): string {
  return dayFormat.format(typeof value === "string" ? new Date(value) : value);
}

export function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function isProcessing(document: Document): boolean {
  return document.status !== "READY" && document.status !== "FAILED";
}

/** The processing pipeline in the order the server runs it. */
const STAGES: Record<Document["status"], { label: string; step: number }> = {
  STORED: { label: "Waiting to start", step: 0 },
  PREVIEWING: { label: "Rendering pages", step: 1 },
  OCR: { label: "Reading the text", step: 2 },
  TEXT_READY: { label: "Text read", step: 3 },
  EMBEDDING: { label: "Indexing for search", step: 4 },
  INDEXING: { label: "Indexing for search", step: 5 },
  READY: { label: "Ready", step: 6 },
  FAILED: { label: "Failed", step: 0 },
};
const STAGE_COUNT = 6;

export function stage(document: Document): { label: string; progress: number } {
  const { label, step } = STAGES[document.status];
  return { label, progress: step / STAGE_COUNT };
}

export type Group = { key: string; label: string | null; items: Document[] };

/** Splits a sorted page of documents into month or sender runs, when the sort makes them meaningful. */
export function groupDocuments(items: Document[], sort: DocumentSort): Group[] {
  const keyOf = (document: Document): { key: string; label: string } | null => {
    if (sort.startsWith("document_date") || sort.startsWith("added_date")) {
      const date = sort.startsWith("added_date") ? new Date(document.added_at) : documentDate(document);
      return { key: `${date.getFullYear()}-${date.getMonth()}`, label: monthFormat.format(date) };
    }
    if (sort.startsWith("sender")) return { key: document.sender ?? "", label: document.sender || "No sender" };
    return null;
  };
  const groups: Group[] = [];
  for (const document of items) {
    const found = keyOf(document);
    const last = groups.at(-1);
    if (last && (found === null || last.key === found.key)) last.items.push(document);
    else groups.push({ key: found?.key ?? "all", label: found?.label ?? null, items: [document] });
  }
  return groups.map((group, index) => ({ ...group, key: `${index}-${group.key}` }));
}
