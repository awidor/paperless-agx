import { useEffect, useRef, useState } from "react";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import type { OcrBlock } from "./api";
import { OcrTextLayer } from "./OcrTextLayer";

export function PdfViewer({ url, page, blocks }: { url: string; page: number; blocks: OcrBlock[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | undefined;
    setError("");
    void import("pdfjs-dist")
      .then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        loading = pdfjs.getDocument(url);
        return loading.promise;
      })
      .then((document) => document.getPage(Math.min(Math.max(page, 1), document.numPages)))
      .then(async (pdfPage) => {
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const available = Math.max(canvas.parentElement?.parentElement?.clientWidth ?? 720, 320);
        const viewport = pdfPage.getViewport({ scale: Math.min(2, available / base.width) });
        const width = Math.floor(viewport.width);
        const height = Math.floor(viewport.height);
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        setSize({ width, height });
        const context = canvas.getContext("2d");
        if (!context) throw new Error("The PDF canvas is not available.");
        await pdfPage.render({ canvas, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
      })
      .catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : "The PDF page failed to render."));
    return () => {
      cancelled = true;
      if (loading) void loading.destroy();
    };
  }, [page, url]);

  if (error) return <p className="viewer-error">{error}</p>;
  return (
    <div className="ocr-page-frame pdf-page-frame" style={size ?? undefined}>
      <canvas ref={canvasRef} className="pdf-canvas" aria-label={`PDF page ${page}`} />
      <OcrTextLayer blocks={blocks} />
    </div>
  );
}
