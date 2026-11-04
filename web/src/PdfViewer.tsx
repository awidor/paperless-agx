import { useEffect, useRef, useState } from "react";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type * as PdfjsModule from "pdfjs-dist";
import type { PageViewport, PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import type { OcrBlock } from "./api";
import { EvidenceMarks } from "./EvidenceMarks";
import { markBoxes, type Box, type Run } from "./evidenceHighlight";
import { OcrTextLayer } from "./OcrTextLayer";
import { bindPageTextSelection } from "./pageTextSelection";

let pdfjs: Promise<typeof PdfjsModule> | undefined;

export function loadPdfjs(): Promise<typeof PdfjsModule> {
  pdfjs ??= import("pdfjs-dist").then((module) => {
    module.GlobalWorkerOptions.workerSrc = workerUrl;
    return module;
  });
  return pdfjs;
}

/** The text runs of a page with their boxes as fractions of the page, from the ascender to the descender. */
export function textRuns(module: typeof PdfjsModule, viewport: PageViewport, content: TextContent): Run[] {
  const runs: Run[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const [, , c, d, e, f] = module.Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(c, d);
    const width = item.width * viewport.scale;
    runs.push({ text: item.str, box: [e / viewport.width, (f - size * 0.85) / viewport.height, (e + width) / viewport.width, (f + size * 0.2) / viewport.height] });
  }
  return runs;
}

export function PdfViewer({ url, page, blocks, marks }: { url: string; page: number; blocks: OcrBlock[]; marks?: string[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [available, setAvailable] = useState(0);
  const [embeddedText, setEmbeddedText] = useState(false);
  const [evidence, setEvidence] = useState<Box[]>([]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (width < 120) return;
      setAvailable((current) => (Math.abs(current - width) < 8 ? current : width));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // The file is fetched once per document, not once per page or resize.
  useEffect(() => {
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | undefined;
    setPdf(null);
    setError("");
    void loadPdfjs()
      .then((module) => {
        loading = module.getDocument(url);
        return loading.promise;
      })
      .then((opened) => {
        if (cancelled) return;
        setPdf(opened);
      })
      .catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : "The PDF failed to load."));
    return () => {
      cancelled = true;
      void loading?.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (!pdf || available <= 0) return;
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    let unbind: (() => void) | undefined;
    void (async () => {
      const module = await loadPdfjs();
      const pdfPage = await pdf.getPage(Math.min(Math.max(page, 1), pdf.numPages));
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: Math.min(2, available / base.width) });
      const width = Math.floor(viewport.width);
      const height = Math.floor(viewport.height);
      const ratio = window.devicePixelRatio || 1;
      // Assigning the size also clears the canvas, so no stale ink survives.
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      setSize({ width, height });
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The PDF canvas is not available.");
      renderTask = pdfPage.render({ canvas, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      const textContent = await pdfPage.getTextContent();
      const container = textLayerRef.current;
      if (cancelled || !container) return;
      container.replaceChildren();
      setEvidence(markBoxes(textRuns(module, viewport, textContent), marks).flat());
      const hasText = textContent.items.some((item) => "str" in item && item.str.trim() !== "");
      setEmbeddedText(hasText);
      if (!hasText) return;
      container.style.setProperty("--total-scale-factor", `${viewport.scale}`);
      textLayer = new module.TextLayer({ textContentSource: textContent, container, viewport });
      await textLayer.render();
      if (cancelled) return;
      unbind = bindPageTextSelection(container);
    })().catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : "The PDF page failed to render."));
    return () => {
      cancelled = true;
      unbind?.();
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [pdf, page, available, marks]);

  return (
    <div className="pdf-viewer" ref={hostRef}>
      {error ? (
        <p className="viewer-error">{error}</p>
      ) : (
        <div className="ocr-page-frame pdf-page-frame" style={size ?? undefined}>
          <canvas ref={canvasRef} className="pdf-canvas" aria-label={`PDF page ${page}`} />
          {embeddedText && evidence.length > 0 && <div className="page-marks" aria-hidden="true"><EvidenceMarks boxes={evidence} /></div>}
          <div className="text-layer" ref={textLayerRef} aria-label="Selectable page text" />
          {!embeddedText && <OcrTextLayer blocks={blocks} marks={marks} />}
        </div>
      )}
    </div>
  );
}
