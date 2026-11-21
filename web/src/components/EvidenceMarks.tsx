import { For } from "solid-js";
import type { Box } from "../lib/evidenceHighlight";

/** Shared outlines for crop strips and full reader pages. */
export function EvidenceMarks(props: { boxes: Box[] }) {
  return <For each={props.boxes}>{(box) => <span
    class="evidence-mark evidence-match"
    style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%` }}
  />}</For>;
}
