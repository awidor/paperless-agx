import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { getPages, type Document } from "./api";
import { EvidenceMarks } from "./EvidenceMarks";
import { frameEvidence, markBoxes, matchRuns, type Frame, type FrameShape, type Ink, type Run } from "./evidenceHighlight";
import { loadPdfjs, textRuns } from "./PdfViewer";

type Layout = { aspect: number; ink: Ink | null; runs: Run[] };

/** The page render is read at this width to find the blank paper between lines. */
const INK_WIDTH = 800;

const layouts = new Map<string, Promise<Layout | null>>();

function pageImage(document: Document, page: number): string {
  return `/api/documents/${document.document_id}/pages/${page}/image`;
}

/** The page render's proportions, and how dark each point of it is. */
function readImage(url: string): Promise<{ aspect: number; ink: Ink | null }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const aspect = image.naturalWidth / Math.max(1, image.naturalHeight);
      const width = INK_WIDTH;
      const height = Math.max(1, Math.round(width / aspect));
      const canvas = window.document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return resolve({ aspect, ink: null });
      context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      const data = new Uint8Array(width * height);
      for (let index = 0; index < data.length; index += 1) {
        const at = index * 4;
        data[index] = 255 - Math.round(0.299 * pixels[at] + 0.587 * pixels[at + 1] + 0.114 * pixels[at + 2]);
      }
      resolve({ aspect, ink: { width, height, data } });
    };
    image.onerror = () => reject(new Error("The page image failed to load."));
    image.src = url;
  });
}

/** The words of a PDF page where its own text layer puts them; scans without one return none. */
async function pdfRuns(document: Document, page: number): Promise<Run[]> {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument(`/api/documents/${document.document_id}/file`).promise;
  try {
    const pdfPage = await pdf.getPage(Math.min(Math.max(page, 1), pdf.numPages));
    return textRuns(pdfjs, pdfPage.getViewport({ scale: 1 }), await pdfPage.getTextContent());
  } finally {
    void pdf.destroy();
  }
}

/** The OCR blocks of the page; coarser than a PDF's words, but every page has them. */
async function ocrRuns(document: Document, page: number): Promise<Run[]> {
  const pages = await getPages(document.document_id);
  return (pages.find((candidate) => candidate.page === page)?.blocks ?? []).map((block) => ({
    text: block.text,
    box: [block.bbox[0] / 1000, block.bbox[1] / 1000, block.bbox[2] / 1000, block.bbox[3] / 1000],
  }));
}

function layoutOf(document: Document, page: number): Promise<Layout | null> {
  const key = `${document.document_id}:${page}:${document.updated_at}`;
  let layout = layouts.get(key);
  if (!layout) {
    layout = Promise.all([
      readImage(pageImage(document, page)),
      document.media_type === "pdf" ? pdfRuns(document, page).catch(() => []) : Promise.resolve([]),
    ]).then(([image, runs]) => ({ ...image, runs })).catch(() => null);
    layouts.set(key, layout);
  }
  return layout;
}

/** How many places on the page read one of the terms, and how many of them the strip shows. */
export type Found = { places: number; shown: number };
type Located = { frame: Frame; pageAspect: number; places: number };

/** Finds the terms on the page, from the PDF's own words when it has them and the OCR blocks when not, and frames them. */
async function locate(document: Document, page: number, terms: string[], shape: FrameShape): Promise<Located | null> {
  const layout = await layoutOf(document, page);
  if (!layout) return null;
  let runs = layout.runs;
  let groups = markBoxes(runs, terms);
  if (terms.length && groups.length === 0) {
    const blocks = await ocrRuns(document, page).catch(() => []);
    if (markBoxes(blocks, terms).length > 0) {
      runs = blocks;
      groups = markBoxes(blocks, terms);
    }
  }
  const places = terms.length ? matchRuns(runs.map((run) => run.text), terms).length : 0;
  const frame = frameEvidence(groups, runs.map((run) => run.box), layout.aspect, shape, layout.ink ?? undefined);
  return { frame, pageAspect: layout.aspect, places };
}

/**
 * A strip of the real page around the evidence, the matching words outlined
 * in place. It reads like the paper itself, at a size where the type is
 * legible; its height follows what it frames.
 */
export function PaperCrop({ document, page, terms, shape, label, onFound }: {
  document: Document;
  page: number;
  terms: string[];
  /** How wide a slice of the page the frame may show, and in what proportions. */
  shape: FrameShape;
  label: string;
  onFound?: (found: Found) => void;
}) {
  const [state, setState] = useState<Located | "missing" | null>(null);
  const termsKey = terms.join("\u0000");
  const shapeKey = `${shape.width}:${shape.minAspect}:${shape.maxAspect}`;

  useEffect(() => {
    let cancelled = false;
    setState(null);
    void locate(document, page, terms, shape).then((found) => {
      if (cancelled) return;
      setState(found ?? "missing");
      if (found) onFound?.({ places: found.places, shown: found.frame.marks.length });
    });
    return () => {
      cancelled = true;
    };
    // The terms and the shape are compared by value: a new array with the same terms is the same request.
  }, [document.document_id, document.updated_at, page, termsKey, shapeKey]);

  // Most frames come out near their widest proportions, so the placeholder takes those.
  const loadingAspect = shape.maxAspect;
  if (state === "missing") return <div className="paper paper--blank" style={{ aspectRatio: String(loadingAspect) }} role="img" aria-label={label}><FileText size={22} aria-hidden="true" /></div>;
  if (!state) return <div className="paper paper--loading" style={{ aspectRatio: String(loadingAspect) }} aria-hidden="true" />;
  const { frame, pageAspect } = state;
  const aspect = (frame.width * pageAspect) / frame.height;
  return <div className="paper" style={{ aspectRatio: aspect.toFixed(4) }} role="img" aria-label={label}>
    <div
      className="paper__plane"
      style={{
        width: `${100 / frame.width}%`,
        aspectRatio: String(pageAspect),
        transform: `translate(${-frame.x * 100}%, ${-frame.y * 100}%)`,
      }}
    >
      <img className="doc-image" src={pageImage(document, page)} alt="" draggable={false} />
      <EvidenceMarks boxes={frame.marks} />
    </div>
  </div>;
}
