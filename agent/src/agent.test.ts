import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { runAgentSearch, type AgentRuntime } from "./agent.ts";
import type { Paperless } from "./paperless.ts";
import type { AgentProgress, Document, SearchPassage } from "./types.ts";

const document: Document = {
  document_id: 7,
  content_hash: [],
  media_type: "pdf",
  filename: "beitrag.pdf",
  title: "Beitragsbescheid 2025",
  sender: "IKK classic",
  created_at: "2025-05-14T00:00:00Z",
  added_at: "2025-05-20T00:00:00Z",
  updated_at: "2025-05-20T00:00:00Z",
  title_source: "ai",
  sender_source: "ai",
  created_at_source: "ai",
  page_count: 2,
  file_size: 1,
  status: "READY",
  last_error: null,
  retry_count: 0,
  deleted_at: null,
  summary: "Beitragsbescheid der IKK classic ab Juni 2025.",
};
const passage: SearchPassage = {
  chunk_id: (7 * 2 ** 32) + 1,
  page: 1,
  char_start: 0,
  char_end: 60,
  snippet: "Ihr monatlicher Beitrag ab 01.06.2025 beträgt 212,50 Euro.",
  score: 0.03,
  kind: "page",
};

const paperless: Paperless = {
  search: async (request) => ({
    items: [{ document, best_chunk_id: passage.chunk_id, page: 1, snippet: passage.snippet, score: 0.03, passages: [passage] }],
    page: 1,
    page_size: request.page_size,
    total: 1,
  }),
  listDocuments: async () => ({ items: [document], page: 1, page_size: 1, total: 1 }),
  pages: async () => [],
  document: async (id) => (id === 7 ? document : null),
  senders: async () => ["IKK classic"],
};

function runtime(maxTurns: number) {
  const faux = fauxProvider({ models: [{ id: "scripted" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const settings: AgentRuntime = {
    paperless,
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    reasoning: "off",
    maxTurns,
    timeoutMs: 5_000,
    maxResults: 10,
  };
  return { faux, settings };
}

const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const search = call("search", { query: "Beitrag", exact: null, sender: null, date_from: null, date_to: null, limit: null });
const result = (documentId: number, extra: JsonObject): JsonObject => ({
  document_id: documentId,
  page: 1,
  passage_id: null,
  quote: null,
  reason: "Nennt den Beitrag ab Juni.",
  ...extra,
});

test("rejects unknown documents, then returns checked results with archive text", async () => {
  const { faux, settings } = runtime(8);
  faux.setResponses([
    search,
    call("submit_results", { results: [result(99, {})], answer: "212,50 Euro", answer_citations: [0] }),
    call("submit_results", {
      results: [result(7, { passage_id: passage.chunk_id })],
      answer: "**212,50 Euro** im Monat",
      answer_citations: [0],
    }),
  ]);
  const progress: AgentProgress[] = [];
  const run = await runAgentSearch({ query: "Wie hoch ist mein Beitrag?" }, settings, (item) => progress.push(item));

  expect(faux.state.callCount).toBe(3);
  expect(run.result.answer).toBe("212,50 Euro im Monat");
  expect(run.result.citations).toEqual([0]);
  expect(run.result.results).toHaveLength(1);
  expect(run.result.results[0].document.document_id).toBe(7);
  expect(run.result.results[0].passage).toEqual(passage);
  expect(progress.map((item) => item.label)).toContain("Searching “Beitrag”");
});

test("forces a submission on the last turn and drops what it cannot verify", async () => {
  const { faux, settings } = runtime(3);
  faux.setResponses([
    search,
    search,
    call("submit_results", {
      results: [result(99, {}), result(7, { quote: "Beitrag ab 01.06.2025 beträgt" })],
      answer: "Nicht belegt",
      answer_citations: [0],
    }),
  ]);
  const run = await runAgentSearch({ query: "Beitrag" }, settings, () => {});

  expect(faux.state.callCount).toBe(3);
  expect(run.result.results.map((item) => item.document.document_id)).toEqual([7]);
  expect(run.result.results[0].passage).toMatchObject({ chunk_id: 0, page: 1, snippet: "Beitrag ab 01.06.2025 beträgt" });
  // The only citation pointed at the dropped document, so the answer is not supported.
  expect(run.result.answer).toBeNull();
});
