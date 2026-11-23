import { createEffect, createMemo, createSignal, Errored, For, onCleanup, onSettled, Show } from "solid-js";
import type { PDFPageProxy, TextLayer } from "pdfjs-dist";
import type { OcrBlock, PageInfo } from "../../client/api";
import { EvidenceMarks } from "../../components/EvidenceMarks";
import { Spinner } from "../../components/ui";
import { markBoxes, type Run } from "../../lib/evidenceHighlight";
import { bindPageTextSelection } from "../../lib/pageTextSelection";
import { acquirePdf, pdfPage, pdfText, renderPdfPage, type Pdf } from "../../lib/pdf";
import { createElementSize, type ElementSize } from "../../primitives/createElementSize";
import { EASE_OUT, motionAllowed } from "../../primitives/motion";
import { OcrTextLayer } from "./OcrTextLayer";

const NO_BLOCKS: OcrBlock[] = [];
const DEFAULT_ASPECT = 210 / 297;
const OBSERVER_MARGIN = "200px 0px";

type Props = {
  url: string;
  pageCount: number;
  pages: PageInfo[];
  marks?: string[];
  marksPage?: number;
  scrollRoot: () => HTMLElement | undefined;
  onPagesReady?: () => void;
};

type Page = { file: Pdf; proxy: PDFPageProxy };
type VisibilityObserver = { observe: (element: Element, onChange: (visible: boolean) => void) => () => void };

function loadingPage() {
  return <p class="status-line" role="status"><Spinner /> Loading page</p>;
}

function createVisibilityObserver(root: () => HTMLElement | undefined): VisibilityObserver {
  const callbacks = new Map<Element, (visible: boolean) => void>();
  let observer: IntersectionObserver | undefined;

  onSettled(() => {
    if (typeof IntersectionObserver === "undefined") {
      for (const notify of callbacks.values()) notify(true);
      return;
    }
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
    }, { root: root() ?? null, rootMargin: OBSERVER_MARGIN });
    for (const element of callbacks.keys()) observer.observe(element);
    return () => {
      observer?.disconnect();
      observer = undefined;
    };
  });

  return {
    observe(element, onChange) {
      callbacks.set(element, onChange);
      if (observer) observer.observe(element);
      else if (typeof IntersectionObserver === "undefined") onChange(true);
      return () => {
        callbacks.delete(element);
        observer?.unobserve(element);
      };
    },
  };
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
        <PdfDocument
          file={pdf()}
          pageCount={Math.max(pdf().document.numPages, props.pageCount, 1)}
          pages={props.pages}
          marks={props.marks}
          marksPage={props.marksPage}
          size={size()}
          scrollRoot={props.scrollRoot}
          onReady={props.onPagesReady}
        />
      }</Show>
    </Errored>
  </div>;
}

function PdfDocument(props: {
  file: Pdf;
  pageCount: number;
  pages: PageInfo[];
  marks?: string[];
  marksPage?: number;
  size?: ElementSize;
  scrollRoot: () => HTMLElement | undefined;
  onReady?: () => void;
}) {
  const [defaultAspect, setDefaultAspect] = createSignal(DEFAULT_ASPECT, { name: "PDF default aspect" });
  const visibility = createVisibilityObserver(props.scrollRoot);
  const pageNumbers = createMemo(
    () => Array.from({ length: props.pageCount }, (_, index) => index + 1),
    { name: "PDF page numbers" },
  );

  function blocksFor(number: number): OcrBlock[] {
    const slot = props.pages[number - 1];
    const info = slot?.page === number ? slot : props.pages.find((candidate) => candidate.page === number);
    return info?.blocks ?? NO_BLOCKS;
  }

  onSettled(() => {
    props.onReady?.();
  });

  return <div class="pdf-pages">
    <For each={pageNumbers()}>{(number) => <PdfPageSlot
      file={props.file}
      page={number}
      size={props.size}
      defaultAspect={defaultAspect()}
      onAspect={(ratio) => { if (number === 1) setDefaultAspect(ratio); }}
      blocks={blocksFor(number)}
      marks={props.marksPage === number ? props.marks : undefined}
      visibility={visibility}
    />}</For>
  </div>;
}

function PdfPageSlot(props: {
  file: Pdf;
  page: number;
  size?: ElementSize;
  defaultAspect: number;
  onAspect: (ratio: number) => void;
  blocks: OcrBlock[];
  marks?: string[];
  visibility: VisibilityObserver;
}) {
  let slot!: HTMLDivElement;
  const [mounted, setMounted] = createSignal(false, { name: "PDF page mounted" });
  const [measured, setMeasured] = createSignal<{ width: number; height: number } | undefined>(undefined, { name: "PDF page natural size" });

  onSettled(() => props.visibility.observe(slot, setMounted));

  const dimensions = createMemo(() => {
    const containerWidth = props.size?.width;
    if (!containerWidth) return undefined;
    const base = measured();
    if (base) {
      const scale = Math.min(2, containerWidth / base.width);
      return { width: Math.floor(base.width * scale), height: Math.floor(base.height * scale) };
    }
    const width = Math.floor(containerWidth);
    return { width, height: Math.floor(width / props.defaultAspect) };
  }, { name: "PDF slot dimensions" });

  return <div
    class="reader__sheet"
    data-reader-page={props.page}
    ref={slot}
    style={dimensions() ? { "min-height": `${dimensions()!.height}px` } : undefined}
  >
    <Show when={mounted()} fallback={
      <div
        class="ocr-page-frame pdf-page-frame pdf-page-frame--placeholder"
        style={dimensions() ? { width: `${dimensions()!.width}px`, height: `${dimensions()!.height}px` } : undefined}
        aria-label={`PDF page ${props.page}`}
      />
    }>
      <PdfPage
        file={props.file}
        page={props.page}
        size={props.size}
        blocks={props.blocks}
        marks={props.marks}
        onMeasured={(width, height) => {
          setMeasured((previous) => (previous && previous.width === width && previous.height === height ? previous : { width, height }));
          if (props.page === 1) props.onAspect(width / height);
        }}
      />
    </Show>
  </div>;
}

function PdfPage(props: {
  file: Pdf;
  size?: ElementSize;
  page: number;
  blocks: OcrBlock[];
  marks?: string[];
  onMeasured: (width: number, height: number) => void;
}) {
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
    return { page: current, base, viewport: proxy.getViewport({ scale: Math.min(2, width / base.width) }) };
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
    props.onMeasured(layout.base.width, layout.base.height);
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
    <div class="ocr-page-frame pdf-page-frame" hidden={Boolean(paintError())} style={{ width: width(), height: height() }}>
      <p class="status-line pdf-page-status" role="status" hidden={hasPainted() || Boolean(paintError())}><Spinner /> Loading page</p>
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
