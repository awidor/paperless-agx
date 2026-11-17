import { runAgentSearch } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { IndexingError, runIndexing } from "./indexing.ts";
import { createRuntime } from "./runtime.ts";
import type { AgentSearchRequest } from "./types.ts";

const config = await loadConfig(process.env.PAPERLESS_AGENT_CONFIG ?? "config/paperless-agent.toml");
const runtime = createRuntime(config);
const encoder = new TextEncoder();
/** Comment lines that keep a long indexing stream open past Bun's idle limit. */
const KEEP_ALIVE_MS = 20_000;

type Send = (event: string, data: unknown) => void;

Bun.serve({
  hostname: config.host,
  port: config.port,
  // The streams send events while the agents work; this only bounds a stalled model.
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", model: runtime.model.id, reasoning: runtime.reasoning });
    }
    if (request.method === "POST" && url.pathname === "/search") return search(request);
    if (request.method === "POST" && url.pathname === "/index") return index(request);
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

log("listening", { address: `${config.host}:${config.port}`, model: runtime.model.id, reasoning: runtime.reasoning });

async function search(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as AgentSearchRequest | null;
  if (!body || typeof body.query !== "string" || !body.query.trim()) {
    return Response.json({ error: "search query must not be empty" }, { status: 400 });
  }
  return eventStream(async (send) => {
    const started = performance.now();
    try {
      const run = await runAgentSearch(body, runtime, (progress) => send("progress", progress), request.signal);
      send("result", run.result);
      log("search finished", {
        seconds: elapsed(started),
        turns: run.turns,
        tool_calls: run.toolCalls,
        results: run.result.results.length,
        answered: run.result.answer !== null,
        cost_usd: Number(run.costUsd.toFixed(5)),
        providers: run.providers,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send("error", { message });
      log("search failed", { seconds: elapsed(started), error: message });
    }
  });
}

async function index(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { document_id?: unknown } | null;
  const documentId = body?.document_id;
  if (typeof documentId !== "number" || !Number.isInteger(documentId) || documentId < 1) {
    return Response.json({ error: "document_id must be a positive integer" }, { status: 400 });
  }
  return eventStream(async (send) => {
    const started = performance.now();
    try {
      const run = await runIndexing(documentId, runtime, (progress) => send("progress", progress), request.signal);
      send("result", run.result);
      log("indexing finished", {
        document_id: documentId,
        pages: run.result.pages.length,
        seconds: elapsed(started),
        turns: run.turns,
        tool_calls: run.toolCalls,
        cost_usd: Number(run.costUsd.toFixed(5)),
        input_tokens: run.usage.input,
        cached_input_tokens: run.usage.cacheRead,
        output_tokens: run.usage.output,
        providers: run.providers,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = error instanceof IndexingError ? error.transient : false;
      send("error", { message, transient });
      log("indexing failed", { document_id: documentId, seconds: elapsed(started), transient, error: message });
    }
  });
}

function eventStream(work: (send: Send) => Promise<void>): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The client went away; the abort signal stops the agent.
        }
      };
      const keepAlive = setInterval(() => write(": keep-alive\n\n"), KEEP_ALIVE_MS);
      try {
        await work((event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      } finally {
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function elapsed(started: number): number {
  return Number(((performance.now() - started) / 1000).toFixed(1));
}

function log(message: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));
}
