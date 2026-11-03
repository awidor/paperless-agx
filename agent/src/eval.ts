/**
 * Scores the search agent on a set of queries with known answers.
 *
 *   bun src/eval.ts <queries.json> [--model id] [--reasoning level] [--providers a,b]
 *                   [--concurrency 4] [--json out.json]
 *
 * queries.json: [{ "query": "...", "expected": [document ids that should be found] }]
 * A query scores the share of its expected documents that appear in the top 5.
 * --json writes every query's results and answer, for comparing runs side by side.
 */
import { parseArgs } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { runAgentSearch } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { createRuntime } from "./runtime.ts";

type Case = { query: string; expected: number[] };
type Score = {
  query: string;
  expected: number[];
  found: number[];
  answer: string | null;
  recall: number | null;
  seconds: number;
  cost: number;
  turns: number;
  providers: string[];
  error?: string;
};

const TOP = 5;
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    model: { type: "string" },
    reasoning: { type: "string" },
    providers: { type: "string" },
    concurrency: { type: "string", default: "4" },
    json: { type: "string" },
  },
  allowPositionals: true,
});
if (positionals.length !== 1) {
  console.error("usage: bun src/eval.ts <queries.json> [--model id] [--reasoning level] [--providers a,b] [--concurrency n] [--json out.json]");
  process.exit(2);
}
const cases = (await Bun.file(positionals[0]).json()) as Case[];
const config = await loadConfig(process.env.PAPERLESS_AGENT_CONFIG ?? "config/paperless-agent.toml");
const runtime = createRuntime(config, {
  modelId: values.model,
  reasoning: values.reasoning as ThinkingLevel | undefined,
  providers: values.providers?.split(",").map((provider) => provider.trim()).filter(Boolean),
});

function recall(found: number[], expected: number[]): number {
  const top = found.slice(0, TOP);
  return expected.filter((id) => top.includes(id)).length / expected.length;
}

async function score(item: Case): Promise<Score> {
  const started = performance.now();
  const base = { query: item.query, expected: item.expected };
  try {
    const run = await runAgentSearch({ query: item.query }, runtime, () => {});
    const found = run.result.results.map((result) => result.document.document_id);
    return {
      ...base,
      found,
      answer: run.result.answer ?? null,
      recall: recall(found, item.expected),
      seconds: (performance.now() - started) / 1000,
      cost: run.costUsd,
      turns: run.turns,
      providers: run.providers,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, found: [], answer: null, recall: null, seconds: (performance.now() - started) / 1000, cost: 0, turns: 0, providers: [], error: message };
  }
}

const scores: Score[] = new Array(cases.length);
let next = 0;
const workers = Array.from({ length: Math.max(1, Number(values.concurrency)) }, async () => {
  while (next < cases.length) {
    const index = next++;
    scores[index] = await score(cases[index]);
  }
});
await Promise.all(workers);

function percent(value: number | null): string {
  return value === null ? "error" : `${Math.round(value * 100)}%`;
}

const model = values.model ?? config.model.id;
const reasoning = runtime.reasoning;
console.log(`model ${model} on ${reasoning} · recall in the top ${TOP}\n`);
console.log("recall  seconds   cost     query");
for (const item of scores) {
  const failure = item.error ? `  (${item.error})` : "";
  const cost = `$${item.cost.toFixed(4)}`;
  console.log(`${percent(item.recall).padEnd(8)}${item.seconds.toFixed(1).padStart(7)}  ${cost.padStart(8)}  ${item.query}${failure}`);
}
const recalls = scores.map((item) => item.recall ?? 0);
const durations = scores.map((item) => item.seconds).sort((left, right) => left - right);
const median = durations[Math.floor(durations.length / 2)] ?? 0;
const cost = scores.reduce((total, item) => total + item.cost, 0);
const failed = scores.filter((item) => item.error).length;
const mean = recalls.reduce((total, value) => total + value, 0) / Math.max(recalls.length, 1);
const providers = [...new Set(scores.flatMap((item) => item.providers))].join(", ") || "unknown";
console.log(`\nrecall ${percent(mean)} · median ${median.toFixed(1)} s · cost $${cost.toFixed(4)} ($${(cost / Math.max(scores.length, 1)).toFixed(4)} per search) · ${failed} failed`);
console.log(`served by ${providers}`);
if (values.json) await Bun.write(values.json, JSON.stringify({ model, reasoning, scores }, null, 2));
