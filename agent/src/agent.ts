import { Agent, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, UserMessage } from "@earendil-works/pi-ai";
import { RunContext } from "./context.ts";
import type { Paperless } from "./paperless.ts";
import { systemPrompt, type ArchiveOverview } from "./prompt.ts";
import { createTools, SUBMIT_TOOL } from "./tools.ts";
import type { AgentProgress, AgentSearchRequest, AgentSearchResult, Document } from "./types.ts";

export type AgentRuntime = {
  paperless: Paperless;
  model: Model<any>;
  streamFn: StreamFn;
  getApiKey?: (provider: string) => string | undefined;
  reasoning: ThinkingLevel;
  maxTurns: number;
  timeoutMs: number;
  maxResults: number;
  now?: () => Date;
};

export type AgentRun = {
  result: AgentSearchResult;
  turns: number;
  toolCalls: number;
  costUsd: number;
};

/** Runs one agentic search: the model looks things up with the tools, then submits ranked results. */
export async function runAgentSearch(
  request: AgentSearchRequest,
  runtime: AgentRuntime,
  onProgress: (progress: AgentProgress) => void,
  signal?: AbortSignal,
): Promise<AgentRun> {
  const query = request.query.trim();
  if (!query) throw new Error("search query must not be empty");
  const context = new RunContext({
    sender: request.sender ?? null,
    createdFrom: request.created_from ?? null,
    createdTo: request.created_to ?? null,
  });
  onProgress({ kind: "thinking", label: "Planning the search" });
  const archive = await describeArchive(runtime.paperless, signal);
  const tools = createTools(context, runtime.paperless, { maxResults: runtime.maxResults });
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt({
        today: (runtime.now?.() ?? new Date()).toISOString().slice(0, 10),
        archive,
        maxResults: runtime.maxResults,
      }),
      model: runtime.model,
      thinkingLevel: runtime.reasoning,
      tools,
    },
    streamFn: runtime.streamFn,
    getApiKey: runtime.getApiKey,
    toolExecution: "parallel",
  });

  let turns = 0;
  let toolCalls = 0;
  agent.finishTurn = async ({ message, toolResults }) => {
    turns += 1;
    if (context.submission) return { action: "end" };
    if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) return;
    if (turns >= runtime.maxTurns) return { action: "end" };
    if (turns === runtime.maxTurns - 1) {
      context.finalTurn = true;
      agent.state.tools = tools.filter((tool) => tool.name === SUBMIT_TOOL);
      agent.steer(user("You are out of lookups. Call submit_results now with the best results you found."));
      return { action: "continue" };
    }
    if (toolResults.length === 0) {
      agent.steer(user("Call submit_results to return your results."));
      return { action: "continue" };
    }
    return undefined;
  };
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      onProgress(progressFor(event.toolName, event.args, context));
    } else if (event.type === "turn_start" && turns > 0 && !context.submission) {
      onProgress({ kind: "thinking", label: "Reviewing what it found" });
    }
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, runtime.timeoutMs);
  const cancel = () => agent.abort();
  signal?.addEventListener("abort", cancel);
  try {
    await agent.prompt(user(task(query, context)));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }

  const costUsd = agent.state.messages
    .filter((message): message is AssistantMessage => message.role === "assistant")
    .reduce((total, message) => total + (message.usage?.cost?.total ?? 0), 0);
  const submission = context.submission;
  if (!submission) {
    if (signal?.aborted) throw new Error("the search was cancelled");
    if (timedOut) throw new Error(`the search agent ran out of time after ${runtime.timeoutMs / 1000} seconds`);
    throw new Error(agent.state.errorMessage || "the search agent stopped without results");
  }
  return {
    result: {
      answer: submission.answer,
      citations: submission.citations,
      results: submission.results.map((item) => ({
        document: context.documents.get(item.documentId) as Document,
        reason: item.reason,
        passage: item.passage,
      })),
    },
    turns,
    toolCalls,
    costUsd,
  };
}

async function describeArchive(paperless: Paperless, signal?: AbortSignal): Promise<ArchiveOverview> {
  const [senders, newest, oldest] = await Promise.all([
    paperless.senders(signal),
    paperless.listDocuments({ sort: "document_date_desc", pageSize: 1 }, signal),
    paperless.listDocuments({ sort: "document_date_asc", pageSize: 1 }, signal),
  ]);
  const day = (document?: Document) => (document ? (document.created_at ?? document.added_at).slice(0, 10) : null);
  return { documents: newest.total, newest: day(newest.items[0]), oldest: day(oldest.items[0]), senders };
}

function task(query: string, context: RunContext): string {
  const { sender, createdFrom, createdTo } = context.limits;
  const limits = [
    sender ? `from "${sender}"` : null,
    createdFrom ? `dated from ${createdFrom.slice(0, 10)}` : null,
    createdTo ? `dated until ${createdTo.slice(0, 10)}` : null,
  ].filter(Boolean);
  const scope = limits.length > 0 ? `\n\nThe user limited the search to documents ${limits.join(", ")}. Every lookup applies this limit.` : "";
  return `Search query: ${query}${scope}`;
}

function progressFor(tool: string, args: any, context: RunContext): AgentProgress {
  if (tool === "search") {
    const scope = [args?.sender ? `from ${args.sender}` : null, dateRange(args?.date_from, args?.date_to)].filter(Boolean);
    const verb = args?.exact ? "Looking for the exact text" : "Searching";
    return { kind: "search", label: `${verb} “${args?.query ?? ""}”${scope.length ? ` ${scope.join(" ")}` : ""}` };
  }
  if (tool === "list_documents") {
    const scope = [
      args?.text ? `matching “${args.text}”` : null,
      args?.sender ? `from ${args.sender}` : null,
      dateRange(args?.date_from, args?.date_to),
    ].filter(Boolean);
    return { kind: "list", label: `Listing documents${scope.length ? ` ${scope.join(" ")}` : ""}` };
  }
  if (tool === "read_pages") {
    const document = context.documents.get(args?.document_id);
    const name = document ? document.title || document.filename : `document ${args?.document_id}`;
    const pages = Array.isArray(args?.pages) ? args.pages.join(", ") : "";
    return { kind: "read", label: `Reading ${name}${pages ? `, p. ${pages}` : ""}` };
  }
  return { kind: "thinking", label: "Ranking the results" };
}

function dateRange(from?: string | null, to?: string | null): string | null {
  if (from && to) return `between ${from} and ${to}`;
  if (from) return `since ${from}`;
  if (to) return `until ${to}`;
  return null;
}

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}
