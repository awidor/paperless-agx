/**
 * Scores the search agent on a set of queries with known answers.
 *
 *   bun src/eval.ts <queries.json> [--model openrouter/model-id] [--concurrency 4]
 *
 * queries.json: [{ "query": "...", "expected": [document ids that should be found] }]
 * A query scores the share of its expected documents that appear in the top 5.
 */
import { parseArgs } from "node:util";
import { runAgentSearch } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { createRuntime } from "./runtime.ts";

type Case = { query: string; expected: number[] };
type Score = { query: string; recall: number | null; seconds: number; cost: number; error?: string };

const TOP = 5;
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: { model: { type: "string" }, concurrency: { type: "string", default: "4" } },
  allowPositionals: true,
});
if (positionals.length !== 1) {
  console.error("usage: bun src/eval.ts <queries.json> [--model id] [--concurrency n]");
  process.exit(2);
}
const cases = (await Bun.file(positionals[0]).json()) as Case[];
const config = await loadConfig(process.env.PAPERLESS_AGENT_CONFIG ?? "config/paperless-agent.toml");
const runtime = createRuntime(config, { modelId: values.model });

function recall(found: number[], expected: number[]): number {
  const top = found.slice(0, TOP);
  return expected.filter((id) => top.includes(id)).length / expected.length;
}

async function score(item: Case): Promise<Score> {
  const started = performance.now();
  const seconds = () => (performance.now() - started) / 1000;
  try {
    const run = await runAgentSearch({ query: item.query }, runtime, () => {});
    const found = run.result.results.map((result) => result.document.document_id);
    return { query: item.query, recall: recall(found, item.expected), seconds: seconds(), cost: run.costUsd };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { query: item.query, recall: null, seconds: seconds(), cost: 0, error: message };
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

console.log(`model ${values.model ?? config.model.id} · recall in the top ${TOP}\n`);
console.log("recall  seconds  query");
for (const item of scores) {
  const failure = item.error ? `  (${item.error})` : "";
  console.log(`${percent(item.recall).padEnd(8)}${item.seconds.toFixed(1).padStart(7)}  ${item.query}${failure}`);
}
const recalls = scores.map((item) => item.recall ?? 0);
const durations = scores.map((item) => item.seconds).sort((left, right) => left - right);
const median = durations[Math.floor(durations.length / 2)] ?? 0;
const cost = scores.reduce((total, item) => total + item.cost, 0);
const failed = scores.filter((item) => item.error).length;
const mean = recalls.reduce((total, value) => total + value, 0) / Math.max(recalls.length, 1);
console.log(`\nrecall ${percent(mean)} · median ${median.toFixed(1)} s · cost $${cost.toFixed(4)} · ${failed} failed`);
