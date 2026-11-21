import { createEffect, createMemo, createSignal, Errored, onCleanup, Show } from "solid-js";
import type { PDFPageProxy, TextLayer } from "pdfjs-dist";
import type { OcrBlock } from "../../client/api";
import { EvidenceMarks } from "../../components/EvidenceMarks";
import { Spinner } from "../../components/ui";
import { markBoxes, type Run } from "../../lib/evidenceHighlight";
import { bindPageTextSelection } from "../../lib/pageTextSelection";
import { acquirePdf, pdfPage, pdfText, renderPdfPage, type Pdf } from "../../lib/pdf";
import { createElementSize, type ElementSize } from "../../primitives/createElementSize";
import { EASE_OUT, motionAllowed } from "../../primitives/motion";
import { OcrTextLayer } from "./OcrTextLayer";

type Props = { url: string; page: number; blocks: OcrBlock[]; marks?: string[] };
type Page = { file: Pdf; proxy: PDFPageProxy };

function loadingPage() {
  return <p class="status-line" role="status"><Spinner /> Loading page</p>;
}

export function PdfViewer(props: Props) {
  const { size, ref } = createElementSize({ minWidth: 120, threshold: 8, widthOnly: true });
  const file = createMemo<Pdf | null>(() => {
    const url = props.url;
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    return acquirePdf(url, controller.signal);
  }, { name: "open PDF", loadingValue: null });

  return <div class="pdf-viewer" ref={ref}>
    <Errored fallback={(error) => <p class="viewer-error">{String(error())}</p>}>
      <Show when={file()} fallback={loadingPage()}>{(pdf) =>
        <PdfPage file={pdf()} page={props.page} blocks={props.blocks} marks={props.marks} size={size()} />
      }</Show>
    </Errored>
  </div>;
}

function PdfPage(props: { file: Pdf; size?: ElementSize; page: number; blocks: OcrBlock[]; marks?: string[] }) {
  let canvas!: HTMLCanvasElement;
  let textContainer!: HTMLDivElement;
  let painted: PDFPageProxy | undefined;
  let renderedText: { page: Page; layer: TextLayer } | undefined;
  const [paintError, failPaint] = createSignal("");
  const [hasPainted, setHasPainted] = createSignal(false, { name: "first PDF paint" });
  const [text, setText] = createSignal<{ page: Page; runs: Run[] } | undefined>(undefined, { name: "embedded PDF text" });
  const [scannedPage, setScannedPage] = createSignal<Page | undefined>(undefined, { name: "PDF page without embedded text" });
  const page = createMemo<Page | null>(() => {
    const file = props.file;
    const proxy = pdfPage(file.document, props.page);
    // Keep the cached page path synchronous. Each visit owns its own text layer.
    return proxy instanceof Promise ? proxy.then((proxy) => ({ file, proxy })) : { file, proxy };
  }, { name: "PDF page", loadingValue: null });
  const viewport = createMemo(() => {
    const current = page();
    if (!current) return undefined;
    const width = props.size?.width;
    if (!width) return undefined;
    const { proxy } = current;
    const base = proxy.getViewport({ scale: 1 });
    return { page: current, viewport: proxy.getViewport({ scale: Math.min(2, width / base.width) }) };
  }, { name: "PDF viewport" });
  const currentText = () => {
    const content = text();
    return content && content.page === page() ? content : undefined;
  };
  const showOcr = () => {
    const scanned = scannedPage();
    return scanned !== undefined && scanned === page() && props.blocks.length > 0;
  };
  const evidence = createMemo(() => props.marks?.length
    ? markBoxes(currentText()?.runs ?? [], props.marks).flat()
    : [], { name: "PDF evidence marks" });

  createEffect(viewport, (layout) => {
    if (!layout) return;
    failPaint("");
    const { page: { file, proxy }, viewport } = layout;
    const ratio = window.devicePixelRatio || 1;
    let task: ReturnType<typeof renderPdfPage> | undefined;
    let animation: Animation | undefined;
    let active = true;

    try {
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The PDF canvas is not available.");
      task = renderPdfPage(file, proxy, {
        canvas, canvasContext: context, viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      void task.promise.then(() => {
        if (!active || painted === proxy) return;
        if (!painted) setHasPainted(true);
        painted = proxy;
        if (motionAllowed()) animation = canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: EASE_OUT });
      }).catch((error) => {
        if (active) failPaint(error instanceof Error ? error.message : "The PDF page failed to render.");
      });
    } catch (error) {
      failPaint(error instanceof Error ? error.message : "The PDF page failed to render.");
    }
    return () => {
      active = false;
      task?.release();
      animation?.cancel();
    };
  }, { name: "paint PDF canvas" });

  // The page owns the text nodes and their selection binding across viewport changes.
  createEffect(
    page,
    (current) => {
      if (!current) return;
      const { file, proxy } = current;
      const layer = textContainer;
      let active = true;
      let textLayer: TextLayer | undefined;
      let unbind: (() => void) | undefined;
      void pdfText(file, proxy).then(async ({ content, runs }) => {
        if (!active) return;
        if (!runs.length) {
          setScannedPage(current);
          return;
        }
        const initial = viewport();
        const initialViewport = initial?.page === current ? initial.viewport : proxy.getViewport({ scale: 1 });
        textLayer = new file.module.TextLayer({ textContentSource: content, container: layer, viewport: initialViewport });
        await textLayer.render();
        if (!active) return;
        // A resize may have arrived while pdf.js was rendering these nodes.
        const latest = viewport();
        if (latest?.page === current) textLayer.update({ viewport: latest.viewport });
        unbind = bindPageTextSelection(layer);
        renderedText = { page: current, layer: textLayer };
        setText({ page: current, runs });
      }).catch(() => {
        // A damaged or absent text layer leaves the OCR overlay available.
        if (!active) return;
        layer.replaceChildren();
        setScannedPage(current);
      });
      return () => {
        active = false;
        renderedText = undefined;
        unbind?.();
        const task = textLayer;
        // Let any queued pdf.js read finish on the detached layer before cancel clears its reader.
        if (task) queueMicrotask(() => task.cancel());
      };
    },
    { name: "render PDF text layer" },
  );

  createEffect(viewport, (layout) => {
    if (layout && renderedText?.page === layout.page) renderedText.layer.update({ viewport: layout.viewport });
  }, { name: "update PDF text viewport" });

  createEffect(
    () => ({ document: props.file.document, number: props.page }),
    ({ document, number }) => {
      if (number >= document.numPages) return;
      const prefetch = () => { void Promise.resolve(pdfPage(document, number + 1)).catch(() => {}); };
      if (typeof window.requestIdleCallback === "function") {
        const id = window.requestIdleCallback(prefetch, { timeout: 500 });
        return () => window.cancelIdleCallback(id);
      }
      const timer = window.setTimeout(prefetch, 100);
      return () => window.clearTimeout(timer);
    },
    { name: "prefetch adjacent PDF page" },
  );

  const width = () => viewport() ? `${Math.floor(viewport()!.viewport.width)}px` : undefined;
  const height = () => viewport() ? `${Math.floor(viewport()!.viewport.height)}px` : undefined;
  return <>
    <Show when={paintError()}>{(message) => <p class="viewer-error">{message()}</p>}</Show>
    <p class="status-line" role="status" hidden={hasPainted() || Boolean(paintError())}><Spinner /> Loading page</p>
    <div class="ocr-page-frame pdf-page-frame" hidden={Boolean(paintError())} style={{ width: width(), height: height() }}>
      <canvas ref={canvas} class="pdf-canvas" aria-label={`PDF page ${props.page}`} style={{ width: width(), height: height() }} />
      <Show when={evidence().length > 0}><div class="page-marks" aria-hidden="true"><EvidenceMarks boxes={evidence()} /></div></Show>
      <Show when={page()} keyed>{(current) =>
        <div class="text-layer" ref={textContainer} aria-label="Selectable page text" hidden={!viewport() || text()?.page !== current}
          style={{ "--total-scale-factor": viewport()?.viewport.scale }} />
      }</Show>
      <Show when={showOcr()}><OcrTextLayer blocks={props.blocks} marks={props.marks} /></Show>
    </div>
  </>;
}
