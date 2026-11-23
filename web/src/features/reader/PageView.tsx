import { Show } from "solid-js";
import type { Document, OcrBlock, PageInfo } from "../../client/api";
import { documentName } from "../../lib/format";
import { inkIn } from "../../primitives/motion";
import { OcrTextLayer } from "./OcrTextLayer";
import { PdfViewer } from "./PdfViewer";

const NO_BLOCKS: OcrBlock[] = [];

export function PageView(props: {
  document: Document;
  pages: PageInfo[];
  marks?: string[];
  marksPage?: number;
  scrollRoot: () => HTMLElement | undefined;
  onPagesReady?: () => void;
}) {
  const url = () => `/api/documents/${props.document.document_id}/file`;
  const firstBlocks = () => props.pages[0]?.blocks ?? NO_BLOCKS;
  const firstMarks = () => props.marksPage === 1 ? props.marks : undefined;
  return <Show when={props.document.media_type === "pdf"} fallback={
    <div class="reader__sheet" data-reader-page={1}>
      <div class="ocr-page-frame image-page-frame">
        <img ref={inkIn} class="ink" src={url()} alt={documentName(props.document)} draggable={false} />
        <OcrTextLayer blocks={firstBlocks()} marks={firstMarks()} />
      </div>
    </div>
  }>
    <PdfViewer
      url={url()}
      pageCount={props.document.page_count || 1}
      pages={props.pages}
      marks={props.marks}
      marksPage={props.marksPage}
      scrollRoot={props.scrollRoot}
      onPagesReady={props.onPagesReady}
    />
  </Show>;
}
