import { Show } from "solid-js";
import type { Document, OcrBlock } from "../../client/api";
import { documentName } from "../../lib/format";
import { inkIn } from "../../primitives/motion";
import { OcrTextLayer } from "./OcrTextLayer";
import { PdfViewer } from "./PdfViewer";

export function PageView(props: { document: Document; page: number; blocks: OcrBlock[]; marks?: string[] }) {
  const url = () => `/api/documents/${props.document.document_id}/file`;
  return <Show when={props.document.media_type === "pdf"} fallback={
    <div class="ocr-page-frame image-page-frame">
      <img ref={inkIn} class="ink" src={url()} alt={documentName(props.document)} draggable={false} />
      <OcrTextLayer blocks={props.blocks} marks={props.marks} />
    </div>
  }>
    <PdfViewer url={url()} page={props.page} blocks={props.blocks} marks={props.marks} />
  </Show>;
}
