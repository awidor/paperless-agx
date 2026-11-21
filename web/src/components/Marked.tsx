import { createMemo, For } from "solid-js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wraps each exact match in a mark. */
export function Marked(props: { text: string; term: string }) {
  const parts = createMemo(() => props.term
    ? props.text.split(new RegExp(`(${escapeRegExp(props.term)})`, "giu"))
    : [props.text], { name: "excerpt matches" });
  return <For each={parts()} keyed={false}>{(part, index) => index % 2 ? <mark>{part()}</mark> : <span>{part()}</span>}</For>;
}
