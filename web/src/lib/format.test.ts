import { expect, test } from "bun:test";
import type { Document } from "../client/api";
import { activeFilterCount, documentDate, documentName, formatBytes, groupDocuments, isProcessing, plural, stage } from "./format";
import { initialQuery } from "../state/url";

const file: Document = {
  document_id: 1, filename: "original.pdf", content_hash: [], media_type: "pdf",
  added_at: "2026-09-08T12:00:00Z", updated_at: "2026-09-08T12:00:00Z",
  file_size: 100, page_count: 1, retry_count: 0, status: "READY",
};

test("uses the original file name and added date for missing metadata", () => {
  expect(documentName(file)).toBe("original.pdf");
  expect(documentDate(file).toISOString()).toBe("2026-09-08T12:00:00.000Z");
  expect(documentName({ ...file, title: "A new title" })).toBe("A new title");
});

test("formats bytes and regular and irregular counts", () => {
  expect([formatBytes(999), formatBytes(1024), formatBytes(1048576)]).toEqual(["999\u00a0B", "1.0\u00a0KB", "1.0\u00a0MB"]);
  expect(plural(1, "document")).toBe("1 document");
  expect(plural(2, "match", "matches")).toBe("2 matches");
});

test("groups adjacent senders and dates without reordering documents", () => {
  const items = [file, { ...file, document_id: 2, sender: "A" }, { ...file, document_id: 3, sender: "A", created_at: "2026-08-08T12:00:00Z" }];
  expect(groupDocuments(items, "sender_asc").map((group) => [group.label, group.start, group.items.map((item) => item.document_id)]))
    .toEqual([["No sender", 0, [1]], ["A", 1, [2, 3]]]);
  expect(groupDocuments(items, "document_date_desc").map((group) => group.items.length)).toEqual([2, 1]);
  expect(groupDocuments(items, "title_asc")[0].items).toEqual(items);
});

test("distinguishes transient stages and counts active filters", () => {
  expect(isProcessing(file)).toBe(false);
  expect(isProcessing({ ...file, status: "FAILED" })).toBe(false);
  expect(isProcessing({ ...file, status: "OCR" })).toBe(true);
  expect(stage({ ...file, status: "OCR" })).toEqual({ label: "Reading the text", progress: 2 / 6 });
  const query = { ...initialQuery, sender: "A", sort: "title_asc" as const };
  expect(activeFilterCount(query, false)).toBe(1);
  expect(activeFilterCount(query, true)).toBe(2);
});
