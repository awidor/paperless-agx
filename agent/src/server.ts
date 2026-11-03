import { runAgentSearch } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { createRuntime } from "./runtime.ts";
import type { AgentSearchRequest } from "./types.ts";

const config = await loadConfig(process.env.PAPERLESS_AGENT_CONFIG ?? "config/paperless-agent.toml");
const runtime = createRuntime(config);
const encoder = new TextEncoder();

Bun.serve({
  hostname: config.host,
  port: config.port,
  // The stream sends an event whenever the agent starts a lookup; this only bounds a stalled model.
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", model: runtime.model.id });
    }
    if (request.method !== "POST" || url.pathname !== "/search") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as AgentSearchRequest | null;
    if (!body || typeof body.query !== "string" || !body.query.trim()) {
      return Response.json({ error: "search query must not be empty" }, { status: 400 });
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            // The client went away; the abort signal stops the agent.
          }
        };
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
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed by the client.
          }
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  },
});

log("listening", { address: `${config.host}:${config.port}`, model: runtime.model.id, reasoning: runtime.reasoning });

function elapsed(started: number): number {
  return Number(((performance.now() - started) / 1000).toFixed(1));
}

function log(message: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));
}
