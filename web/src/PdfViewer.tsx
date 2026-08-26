import { useEffect, useRef, useState } from "react";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";


export function PdfViewer({ url, page }: { url: string; page: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | undefined;
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
        const available = Math.max(canvas.parentElement?.clientWidth ?? 720, 320);
        const viewport = pdfPage.getViewport({ scale: Math.min(2, available / base.width) });
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
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

  return <canvas ref={canvasRef} className="pdf-canvas" aria-label={`PDF page ${page}`} />;
}
