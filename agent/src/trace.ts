import type { AgentEvent } from "@earendil-works/pi-agent-core";

/** One line per model reply and per rejected tool call, so a session can be followed. */
export function traceEvent(event: AgentEvent, trace: (line: string) => void): void {
  if (event.type === "tool_execution_end" && event.isError) {
    trace(`  rejected ${event.toolName}: ${toolText(event.result)}`);
  } else if (event.type === "message_end" && event.message.role === "assistant") {
    const reply = event.message;
    const text = reply.content
      .map((part) =>
        part.type === "text"
          ? part.text
          : part.type === "toolCall"
            ? `[${part.name} ${JSON.stringify(part.arguments).slice(0, 160)}]`
            : "",
      )
      .join(" ");
    trace(`reply (${reply.stopReason}${reply.errorMessage ? `: ${reply.errorMessage}` : ""}): ${text.slice(0, 600)}`);
  }
}

/** The text of a tool result. */
export function toolText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] } | null)?.content ?? [];
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join(" ");
}
