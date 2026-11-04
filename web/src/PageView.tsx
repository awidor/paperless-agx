import type { Document, OcrBlock } from "./api";
import { OcrTextLayer } from "./OcrTextLayer";
import { PdfViewer } from "./PdfViewer";

/** One page of the original file with its selectable text laid over it. */
export function PageView({ document, page, blocks, marks }: { document: Document; page: number; blocks: OcrBlock[]; marks?: string[] }) {
  const url = `/api/documents/${document.document_id}/file`;
  if (document.media_type === "pdf") return <PdfViewer url={url} page={page} blocks={blocks} marks={marks} />;
  return <div className="ocr-page-frame image-page-frame">
    <img src={url} alt={document.title || document.filename} draggable={false} />
    <OcrTextLayer blocks={blocks} marks={marks} />
  </div>;
}
