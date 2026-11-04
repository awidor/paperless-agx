import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";
import { excerpt, type RunContext } from "./context.ts";
import type { Paperless } from "./paperless.ts";
import { checkSubmission, type Submission } from "./results.ts";
import type { Document } from "./types.ts";

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
/** Pi turns these schemas into OpenAI strict schemas, so arguments always parse. */
const strict = { constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const } };

const PASSAGE_EXCERPT_CHARS = 700;
const SUMMARY_CHARS = 400;
const PAGE_TEXT_CHARS = 8_000;
const PAGES_PER_READ = 4;

const dateFrom = nullable(Type.String({ description: "Earliest document date, YYYY-MM-DD." }));
const dateTo = nullable(Type.String({ description: "Latest document date, YYYY-MM-DD." }));
const sender = nullable(Type.String({ description: "A sender exactly as written in the known senders list." }));

const searchParameters = Type.Object({
  query: Type.String({
    description: "Keywords or a short description of what the text says. A word also matches inside longer words.",
  }),
  exact: nullable(
    Type.Boolean({
      description: "True to find only passages containing the query exactly as written, such as a reference number or name.",
    }),
  ),
  sender,
  date_from: dateFrom,
  date_to: dateTo,
  limit: nullable(Type.Integer({ description: "Documents to return: 8 if null, at most 15." })),
});

const listParameters = Type.Object({
  text: nullable(Type.String({ description: "Words that must all appear in the title, file name or sender." })),
  sender,
  date_from: dateFrom,
  date_to: dateTo,
  sort: nullable(Type.Union([Type.Literal("newest"), Type.Literal("oldest")])),
  limit: nullable(Type.Integer({ description: "Documents to return: 15 if null, at most 30." })),
});

const readParameters = Type.Object({
  document_id: Type.Integer(),
  pages: Type.Array(Type.Integer(), { description: `Page numbers to read, at most ${PAGES_PER_READ}.` }),
});

const submitParameters = Type.Object({
  // Named first so the model settles the language before it writes reasons and the answer;
  // otherwise it drifts into the documents' German for queries in English.
  query_language: Type.String({
    description: "The language the search query is written in, such as English or German. Write every reason and the answer in it.",
  }),
  results: Type.Array(
    Type.Object({
      document_id: Type.Integer(),
      page: nullable(Type.Integer({ description: "The page with the best evidence." })),
      passage_id: nullable(Type.Integer({ description: "A passage from search that shows the evidence." })),
      quote: nullable(
        Type.String({ description: "When no passage fits: a short exact quote from that page, copied verbatim." }),
      ),
      reason: Type.String({ description: "One sentence in the query's language on why the document matches." }),
    }),
    { description: "Matching documents, best first. Empty when nothing matches." },
  ),
  answer: nullable(
    Type.String({
      description:
        "A short answer when the query asks something the documents state; else null. Written in the query's language, not the documents'. States the fact directly, without saying which document it comes from.",
    }),
  ),
  answer_citations: nullable(
    Type.Array(Type.Integer(), { description: "Indexes (from 0) into results of the documents that state the answer." }),
  ),
});

export function createTools(
  context: RunContext,
  paperless: Paperless,
  options: { maxResults: number },
): AgentTool<any>[] {
  const search: AgentTool<typeof searchParameters> = {
    name: "search",
    label: "Search",
    description:
      "Keyword and meaning search over the text of all documents and their summaries. Returns the best matching documents with their best passages.",
    parameters: searchParameters,
    ...strict,
    execute: async (_id, params, signal) => {
      const limits = applyLimits(context, params.sender, params.date_from, params.date_to);
      const response = await paperless.search(
        {
          query: params.query,
          page: 1,
          page_size: clamp(params.limit ?? 8, 1, 15),
          sender: limits.sender,
          created_from: limits.createdFrom,
          created_to: limits.createdTo,
          exact: params.exact ?? false,
        },
        signal,
      );
      const lines = [`${response.items.length} of ${response.total} matching documents.`];
      for (const hit of response.items) {
        context.rememberDocument(hit.document);
        lines.push("", describe(hit.document));
        for (const passage of hit.passages) {
          context.rememberPassage(hit.document.document_id, passage);
          if (passage.kind === "summary") continue;
          lines.push(
            `  passage ${passage.chunk_id}, page ${passage.page}: ${excerpt(passage.snippet, params.query, PASSAGE_EXCERPT_CHARS)}`,
          );
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { documents: response.items.length } };
    },
  };

  const listDocuments: AgentTool<typeof listParameters> = {
    name: "list_documents",
    label: "List documents",
    description:
      "Lists documents by title, sender or date, newest first unless sorted otherwise. Use it for requests such as all letters from a sender or period.",
    parameters: listParameters,
    ...strict,
    execute: async (_id, params, signal) => {
      const limits = applyLimits(context, params.sender, params.date_from, params.date_to);
      const response = await paperless.listDocuments(
        {
          query: params.text ?? undefined,
          sender: limits.sender ?? undefined,
          createdFrom: limits.createdFrom ?? undefined,
          createdTo: limits.createdTo ?? undefined,
          sort: params.sort === "oldest" ? "document_date_asc" : "document_date_desc",
          pageSize: clamp(params.limit ?? 15, 1, 30),
        },
        signal,
      );
      const lines = [`${response.total} documents match; showing ${response.items.length}.`];
      for (const document of response.items) {
        context.rememberDocument(document);
        lines.push("", describe(document));
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { documents: response.items.length } };
    },
  };

  const readPages: AgentTool<typeof readParameters> = {
    name: "read_pages",
    label: "Read pages",
    description: "Returns the full recognized text of pages of one document, to check details before relying on them.",
    parameters: readParameters,
    ...strict,
    execute: async (_id, params, signal) => {
      const document = context.documents.get(params.document_id) ?? (await paperless.document(params.document_id, signal));
      if (!document) throw new Error(`Document ${params.document_id} does not exist.`);
      context.rememberDocument(document);
      const wanted = [...new Set(params.pages)]
        .filter((page) => page >= 1 && page <= document.page_count)
        .slice(0, PAGES_PER_READ);
      if (wanted.length === 0) throw new Error(`Document ${document.document_id} has pages 1 to ${document.page_count}.`);
      const pages = await paperless.pages(document.document_id, signal);
      const lines = [describe(document)];
      for (const number of wanted) {
        const text = pages.find((page) => page.page === number)?.text ?? null;
        if (text) context.rememberPage(document.document_id, number, text);
        lines.push("", `--- page ${number} ---`, text ? clip(text, PAGE_TEXT_CHARS) : "(no recognized text)");
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { pages: wanted } };
    },
  };

  const submitResults: AgentTool<typeof submitParameters> = {
    name: "submit_results",
    label: "Submit results",
    description: "Returns the final ranked documents and the optional answer to the user. Call it once, at the end.",
    parameters: submitParameters,
    ...strict,
    execute: async (_id, params) => {
      const checked = checkSubmission(context, params as Submission, {
        strict: !context.finalTurn,
        maxResults: options.maxResults,
      });
      context.submission = checked;
      return {
        content: [{ type: "text", text: `Submitted ${checked.results.length} results.` }],
        details: { results: checked.results.length },
        terminate: true,
      };
    },
  };

  return [search, listDocuments, readPages, submitResults];
}

export const SUBMIT_TOOL = "submit_results";

/** The user's limits win over the agent's own filters; date ranges intersect. */
function applyLimits(
  context: RunContext,
  sender: string | null,
  dateFrom: string | null,
  dateTo: string | null,
): { sender: string | null; createdFrom: string | null; createdTo: string | null } {
  const from = dateFrom ? isoDate(dateFrom, "date_from", false) : null;
  const to = dateTo ? isoDate(dateTo, "date_to", true) : null;
  const { limits } = context;
  return {
    sender: limits.sender ?? sender ?? null,
    createdFrom: later(limits.createdFrom, from),
    createdTo: earlier(limits.createdTo, to),
  };
}

function isoDate(value: string, field: string, endOfDay: boolean): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be a date written as YYYY-MM-DD.`);
  }
  return `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
}

function later(left: string | null, right: string | null): string | null {
  if (!left || !right) return left ?? right;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function earlier(left: string | null, right: string | null): string | null {
  if (!left || !right) return left ?? right;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function describe(document: Document): string {
  const parts = [
    `[document ${document.document_id}] ${document.title || document.filename}`,
    document.sender ? `from ${document.sender}` : null,
    document.created_at ? `dated ${document.created_at.slice(0, 10)}` : null,
    `${document.page_count} ${document.page_count === 1 ? "page" : "pages"}`,
  ].filter(Boolean);
  const summary = document.summary ? `\n  summary: ${clip(document.summary, SUMMARY_CHARS)}` : "";
  return parts.join(" · ") + summary;
}

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}
