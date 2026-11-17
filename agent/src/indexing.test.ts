import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import type { AgentRuntime } from "./agent.ts";
import { IndexingError, runIndexing, transientModelError } from "./indexing.ts";
import type { Paperless } from "./paperless.ts";
import type { Document } from "./types.ts";

const document: Document = {
  document_id: 3,
  content_hash: [],
  media_type: "pdf",
  filename: "bescheid.pdf",
  title: null,
  sender: null,
  created_at: null,
  added_at: "2025-05-20T00:00:00Z",
  updated_at: "2025-05-20T00:00:00Z",
  title_source: null,
  sender_source: null,
  created_at_source: null,
  page_count: 2,
  file_size: 1,
  status: "OCR",
  last_error: null,
  retry_count: 0,
  deleted_at: null,
  summary: null,
};

const viewed: number[] = [];
const paperless: Paperless = {
  search: async () => ({ items: [], page: 1, page_size: 1, total: 0 }),
  listDocuments: async () => ({ items: [], page: 1, page_size: 1, total: 0 }),
  pages: async () => [],
  document: async (id) => (id === 3 ? document : null),
  senders: async () => ["IKK classic"],
  pageImage: async (_id, page) => {
    viewed.push(page);
    return { data: "aW1hZ2U=", mimeType: "image/webp" };
  },
};

function runtime() {
  const faux = fauxProvider({ models: [{ id: "scripted", input: ["text", "image"] }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const settings: AgentRuntime = {
    paperless,
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    reasoning: "off",
    maxTurns: 8,
    timeoutMs: 5_000,
    maxResults: 10,
    search: { semantic: true, summaries: true },
    indexing: { timeoutMs: 5_000, pagesPerView: 4 },
  };
  return { faux, settings };
}

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const block = (text: string): JsonObject => ({ label: "Text", bbox: [100, 120, 900, 180], html: `<p>${text}</p>` });
const details = {
  title: "Beitragsbescheid 2025",
  sender: "IKK classic",
  created_at: "2025-05-14",
  summary: "Beitragsbescheid der IKK classic.",
};

test("indexes a document in one session and checks every step", async () => {
  viewed.length = 0;
  const { faux, settings } = runtime();
  faux.setResponses([
    // Saving before viewing and finishing early are rejected, and the agent corrects itself.
    call("save_page", { page: 1, blocks: [block("Beitrag")] }),
    call("view_pages", { pages: [1, 2] }),
    call("save_page", { page: 1, blocks: [block("Ihr Beitrag ab 01.06.2025")] }),
    call("finish", details),
    call("save_page", { page: 2, blocks: [{ label: "Text", bbox: [900, 120, 100, 180], html: "<p>x</p>" }] }),
    call("save_page", { page: 2, blocks: [{ ...block("Mit freundlichen Grüßen"), label: "text" }] }),
    call("finish", details),
  ]);
  const labels: string[] = [];
  const run = await runIndexing(3, settings, (progress) => labels.push(progress.label));

  expect(faux.state.callCount).toBe(7);
  expect(viewed).toEqual([1, 2]);
  expect(run.result).toEqual({
    pages: [
      { page: 1, blocks: [{ label: "Text", bbox: [100, 120, 900, 180], html: "<p>Ihr Beitrag ab 01.06.2025</p>" }] },
      { page: 2, blocks: [{ label: "Text", bbox: [100, 120, 900, 180], html: "<p>Mit freundlichen Grüßen</p>" }] },
    ],
    ...details,
  });
  expect(labels).toContain("Reading pages 1, 2");
});

test("tells the model what was wrong with a rejected call and how to fix it", async () => {
  const { faux, settings } = runtime();
  faux.setResponses([
    call("view_pages", { pages: [1, 2] }),
    call("save_page", {
      page: 1,
      blocks: [
        { label: "Paragraph", bbox: [100, 120, 900, 180], html: "<p>a</p>" },
        { label: "Text", bbox: [0.1, 0.2, 0.9, 0.3], html: "<p>b</p>" },
      ],
    }),
    call("finish", { title: "T", created_at: "14.05.2025" }),
    call("save_page", { page: 1, blocks: [block("a")] }),
    call("save_page", { page: 2, blocks: [block("b")] }),
    call("finish", { title: "T", created_at: "14.05.2025" }),
    call("finish", { title: "T", created_at: "2025-05-14" }),
  ]);
  const rejected: string[] = [];
  const run = await runIndexing(3, settings, () => {}, undefined, (line) => {
    if (line.includes("rejected")) rejected.push(line);
  });

  expect(rejected).toHaveLength(3);
  expect(rejected[0]).toContain('label "Paragraph" is not one of');
  expect(rejected[0]).toContain("looks like fractions of the page");
  expect(rejected[1]).toContain("Call save_page for pages 1, 2, which you have viewed but not saved.");
  expect(rejected[2]).toContain('Write it like "2025-05-14"');
  expect(run.result.created_at).toBe("2025-05-14");
  expect(run.result.sender).toBeNull();
});

test("retries only model errors that may pass", () => {
  expect(transientModelError('429: {"message":"rate limited"}')).toBe(true);
  expect(transientModelError("503: unavailable")).toBe(true);
  expect(transientModelError("Connection error.")).toBe(true);
  expect(transientModelError('402: {"message":"This request requires more credits"}')).toBe(false);
  expect(transientModelError("400: bad request")).toBe(false);
});

test("reports an unknown document as a permanent failure", async () => {
  const { settings } = runtime();
  const failure = await runIndexing(99, settings, () => {}).catch((error) => error);
  expect(failure).toBeInstanceOf(IndexingError);
  expect(failure.transient).toBe(false);
});
