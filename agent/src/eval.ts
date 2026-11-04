/**
 * Scores the search agent on a set of queries with known answers.
 *
 *   bun src/eval.ts <queries.json> [--model id] [--reasoning level] [--providers a,b]
 *                   [--concurrency 4] [--repeat 1] [--json out.json]
 *
 * queries.json: [{ "query": "...", "expected": [document ids], "answer": true | false, "facts": ["regex"] }]
 * A query scores the share of its expected documents that appear in the top 5.
 * "answer" is optional: true when the query asks for a fact the agent should
 * answer, false when it asks for documents and the answer must stay empty.
 * "facts" is optional: patterns (case-insensitive) the answer must all contain.
 * --repeat runs every query that many times, since one run of a model varies.
 * --json writes every query's results and answer, for comparing runs side by side.
 */
import { parseArgs } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { runAgentSearch } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { createRuntime } from "./runtime.ts";

type Case = { query: string; expected: number[]; answer?: boolean; facts?: string[] };
type Score = {
  query: string;
  expected: number[];
  found: number[];
  answer: string | null;
  recall: number | null;
  /** Whether the agent answered exactly when the case says it should; null when the case does not say. */
  answered: boolean | null;
  /** Whether the answer states every fact the case lists; null when it lists none. */
  correct: boolean | null;
  /** Documents in the top 5 that the case does not expect. */
  extra: number;
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
    repeat: { type: "string", default: "1" },
    json: { type: "string" },
  },
  allowPositionals: true,
});
if (positionals.length !== 1) {
  console.error(
    "usage: bun src/eval.ts <queries.json> [--model id] [--reasoning level] [--providers a,b] [--concurrency n] [--repeat n] [--json out.json]",
  );
  process.exit(2);
}
const repeat = Math.max(1, Number(values.repeat));
const cases = ((await Bun.file(positionals[0]).json()) as Case[]).flatMap((item) => Array(repeat).fill(item) as Case[]);
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

function correct(answer: string | null, facts?: string[]): boolean | null {
  if (!facts?.length) return null;
  return answer !== null && facts.every((fact) => new RegExp(fact, "i").test(answer));
}

async function score(item: Case): Promise<Score> {
  const started = performance.now();
  const base = { query: item.query, expected: item.expected };
  try {
    const run = await runAgentSearch({ query: item.query }, runtime, () => {});
    const found = run.result.results.map((result) => result.document.document_id);
    const answer = run.result.answer ?? null;
    return {
      ...base,
      found,
      answer,
      recall: recall(found, item.expected),
      answered: item.answer === undefined ? null : item.answer === Boolean(answer),
      correct: correct(answer, item.facts),
      extra: found.slice(0, TOP).filter((id) => !item.expected.includes(id)).length,
      seconds: (performance.now() - started) / 1000,
      cost: run.costUsd,
      turns: run.turns,
      providers: run.providers,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      found: [],
      answer: null,
      recall: null,
      answered: null,
      correct: item.facts?.length ? false : null,
      extra: 0,
      seconds: (performance.now() - started) / 1000,
      cost: 0,
      turns: 0,
      providers: [],
      error: message,
    };
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

function mark(value: boolean | null): string {
  return value === null ? "-" : value ? "ok" : "wrong";
}

const model = values.model ?? config.model.id;
const reasoning = runtime.reasoning;
console.log(`model ${model} on ${reasoning} · recall in the top ${TOP}\n`);
console.log("recall  answer  facts   extra  seconds   cost     query");
for (const item of scores) {
  const failure = item.error ? `  (${item.error})` : "";
  const cost = `$${item.cost.toFixed(4)}`;
  console.log(
    `${percent(item.recall).padEnd(8)}${mark(item.answered).padEnd(8)}${mark(item.correct).padEnd(8)}${String(item.extra).padEnd(5)}${item.seconds.toFixed(1).padStart(7)}  ${cost.padStart(8)}  ${item.query}${failure}`,
  );
}
const recalls = scores.map((item) => item.recall ?? 0);
const durations = scores.map((item) => item.seconds).sort((left, right) => left - right);
const median = durations[Math.floor(durations.length / 2)] ?? 0;
const p90 = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.9))] ?? 0;
const cost = scores.reduce((total, item) => total + item.cost, 0);
const failed = scores.filter((item) => item.error).length;
const mean = recalls.reduce((total, value) => total + value, 0) / Math.max(recalls.length, 1);
const extra = scores.reduce((total, item) => total + item.extra, 0) / Math.max(scores.length, 1);
const providers = [...new Set(scores.flatMap((item) => item.providers))].join(", ") || "unknown";
const tally = (key: "answered" | "correct") => {
  const judged = scores.filter((item) => item[key] !== null);
  return `${judged.filter((item) => item[key]).length} of ${judged.length}`;
};
console.log(
  `\nrecall ${percent(mean)} · median ${median.toFixed(1)} s · p90 ${p90.toFixed(1)} s · cost $${cost.toFixed(4)} ($${(cost / Math.max(scores.length, 1)).toFixed(4)} per search) · ${failed} failed`,
);
console.log(`answered when it should ${tally("answered")} · facts right ${tally("correct")} · ${extra.toFixed(1)} unexpected documents in the top ${TOP}`);
console.log(`served by ${providers}`);
if (values.json) await Bun.write(values.json, JSON.stringify({ model, reasoning, scores }, null, 2));
