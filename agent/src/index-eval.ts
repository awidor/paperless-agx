/**
 * Benchmarks the indexing agent on documents already in the archive. It reads nothing back into
 * the archive: each document is indexed in a fresh session and compared with what is stored.
 *
 *   bun src/index-eval.ts (--documents 12,40 | --sample 10) [--model id] [--reasoning level]
 *                         [--concurrency 2] [--json out.json]
 *
 * Per document it reports the word accuracy of the new text against the stored text, how well
 * the new blocks overlap the stored blocks (a check that positions land where the text is),
 * whether title, sender and date agree, time, tokens (cached and not) and cost.
 */
import { parseArgs } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { loadConfig } from "./config.ts";
import { runIndexing, type IndexBlock, type IndexRun } from "./indexing.ts";
import { createRuntime } from "./runtime.ts";
import type { Document, PageInfo } from "./types.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    documents: { type: "string" },
    sample: { type: "string" },
    model: { type: "string" },
    reasoning: { type: "string" },
    concurrency: { type: "string", default: "2" },
    json: { type: "string" },
    trace: { type: "boolean", default: false },
  },
});
if (!values.documents && !values.sample) {
  console.error("usage: bun src/index-eval.ts (--documents 12,40 | --sample 10) [--model id] [--reasoning level] [--concurrency n] [--json out.json]");
  process.exit(2);
}
const config = await loadConfig(process.env.PAPERLESS_AGENT_CONFIG ?? "config/paperless-agent.toml");
const runtime = createRuntime(config, { modelId: values.model, reasoning: values.reasoning as ThinkingLevel | undefined });
const paperless = runtime.paperless;

type Score = {
  document_id: number;
  filename: string;
  pages: number;
  accuracy: number | null;
  overlap: number | null;
  title: [string | null, string | null];
  sender: [string | null, string | null];
  created_at: [string | null, string | null];
  seconds: number;
  run?: Omit<IndexRun, "result">;
  result?: IndexRun["result"];
  error?: string;
};

const ids = values.documents
  ? values.documents.split(",").map((id) => Number(id.trim())).filter((id) => Number.isInteger(id) && id > 0)
  : await sample(Number(values.sample));

async function sample(count: number): Promise<number[]> {
  const listing = await paperless.listDocuments({ sort: "added_date_desc", pageSize: 100 });
  const ready = listing.items.filter((document) => document.status === "READY");
  // Spread the sample over the archive instead of taking the newest.
  const step = Math.max(1, Math.floor(ready.length / Math.max(count, 1)));
  return ready.filter((_, index) => index % step === 0).slice(0, count).map((document) => document.document_id);
}

async function score(documentId: number): Promise<Score> {
  const started = performance.now();
  const [document, stored] = await Promise.all([paperless.document(documentId), paperless.pages(documentId)]);
  if (!document) throw new Error(`document ${documentId} does not exist`);
  const base = {
    document_id: documentId,
    filename: document.filename,
    pages: document.page_count,
    title: [document.title ?? null, null] as [string | null, string | null],
    sender: [document.sender ?? null, null] as [string | null, string | null],
    created_at: [document.created_at?.slice(0, 10) ?? null, null] as [string | null, string | null],
  };
  try {
    const run = await runIndexing(documentId, runtime, () => {}, undefined, values.trace ? (line) => console.error(`[${documentId}] ${line}`) : undefined);
    const { result, ...rest } = run;
    return {
      ...base,
      accuracy: wordAccuracy(stored, result.pages),
      overlap: blockOverlap(stored, result.pages),
      title: [document.title ?? null, result.title],
      sender: [document.sender ?? null, result.sender],
      created_at: [base.created_at[0], result.created_at],
      seconds: (performance.now() - started) / 1000,
      run: rest,
      result,
    };
  } catch (error) {
    return { ...base, accuracy: null, overlap: null, seconds: (performance.now() - started) / 1000, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 1 minus the word-level edit distance over the stored word count, over all pages. */
function wordAccuracy(stored: PageInfo[], pages: { page: number; blocks: IndexBlock[] }[]): number | null {
  const reference = stored.flatMap((page) => words(markdownText(page.text ?? "")));
  if (reference.length === 0) return null;
  const candidate = pages.flatMap((page) => page.blocks.flatMap((block) => words(htmlText(block.html))));
  return Math.max(0, 1 - editDistance(reference, candidate) / reference.length);
}

/** For each new block, the best intersection over union with a stored block; the mean over all. */
function blockOverlap(stored: PageInfo[], pages: { page: number; blocks: IndexBlock[] }[]): number | null {
  const values: number[] = [];
  for (const page of pages) {
    const old = stored.find((item) => item.page === page.page)?.blocks ?? [];
    if (old.length === 0) continue;
    for (const block of page.blocks) {
      if (block.label === "Blank-Page") continue;
      values.push(Math.max(...old.map((item) => iou(block.bbox, item.bbox as [number, number, number, number]))));
    }
  }
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const overlap = width * height;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - overlap;
  return union > 0 ? overlap / union : 0;
}

function htmlText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

function markdownText(text: string): string {
  return text.replace(/[*_#>|`]+/g, " ").replace(/^\s*[-+]\s+/gm, " ");
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function editDistance(a: string[], b: string[]): number {
  let previous = new Int32Array(b.length + 1).map((_, index) => index);
  let current = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

const scores: Score[] = new Array(ids.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.max(1, Number(values.concurrency)) }, async () => {
    while (next < ids.length) {
      const index = next++;
      scores[index] = await score(ids[index]);
    }
  }),
);

const percent = (value: number | null) => (value === null ? "-" : `${Math.round(value * 100)}%`);
const same = ([left, right]: [string | null, string | null]) =>
  left === null && right === null ? "-" : (left ?? "").trim().toLowerCase() === (right ?? "").trim().toLowerCase() ? "same" : "diff";
console.log(`model ${runtime.model.id} on ${runtime.reasoning} · ${ids.length} documents\n`);
console.log("words  boxes  title sender date  pages  seconds  cached/input    cost     document");
for (const item of scores) {
  const usage = item.run?.usage;
  const cached = usage ? `${usage.cacheRead}/${usage.input + usage.cacheRead}` : "-";
  console.log(
    `${percent(item.accuracy).padEnd(7)}${percent(item.overlap).padEnd(7)}${same(item.title).padEnd(6)}${same(item.sender).padEnd(7)}${same(item.created_at).padEnd(6)}${String(item.pages).padStart(5)}${item.seconds.toFixed(1).padStart(9)}  ${cached.padStart(13)}  ${`$${(item.run?.costUsd ?? 0).toFixed(4)}`.padStart(8)}  ${item.document_id} ${item.filename}${item.error ? `  (${item.error})` : ""}`,
  );
}
const done = scores.filter((item) => !item.error);
const mean = (list: (number | null)[]) => {
  const present = list.filter((value): value is number => value !== null);
  return present.length ? present.reduce((total, value) => total + value, 0) / present.length : null;
};
const pages = done.reduce((total, item) => total + item.pages, 0);
const cost = done.reduce((total, item) => total + (item.run?.costUsd ?? 0), 0);
const seconds = done.reduce((total, item) => total + item.seconds, 0);
const input = done.reduce((total, item) => total + (item.run ? item.run.usage.input + item.run.usage.cacheRead : 0), 0);
const cachedTotal = done.reduce((total, item) => total + (item.run?.usage.cacheRead ?? 0), 0);
console.log(
  `\nwords ${percent(mean(done.map((item) => item.accuracy)))} · boxes ${percent(mean(done.map((item) => item.overlap)))} · ${(seconds / Math.max(pages, 1)).toFixed(1)} s and $${(cost / Math.max(pages, 1)).toFixed(4)} per page · ${percent(input ? cachedTotal / input : null)} of input cached · ${scores.length - done.length} failed`,
);
if (values.json) await Bun.write(values.json, JSON.stringify({ model: runtime.model.id, reasoning: runtime.reasoning, scores }, null, 2));
