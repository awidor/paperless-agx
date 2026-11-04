import type { Box } from "./evidenceHighlight";

/**
 * The outlines of the evidence on a page, laid over the page at its own scale.
 * The same marks sit on a search result's strip of paper and on the page in the
 * reader, so the reader visibly continues the strip.
 */
export function EvidenceMarks({ boxes }: { boxes: Box[] }) {
  return <>{boxes.map((box, index) => <span
    key={index}
    className="evidence-mark evidence-match"
    style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%` }}
  />)}</>;
}
