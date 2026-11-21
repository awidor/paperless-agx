import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type * as Pdfjs from "pdfjs-dist";
import type { PageViewport, PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import type { Run } from "./evidenceHighlight";

export type Pdf = { module: typeof Pdfjs; document: PDFDocumentProxy; retain: () => () => void };
type Entry = {
  result: Promise<Pdf>;
  task?: PDFDocumentLoadingTask;
  opened: boolean;
  references: number;
  disposed: boolean;
};

const MAX_DOCUMENTS = 4;
const documents = new Map<string, Entry>();
const overflow = new Map<string, Entry>();
let pdfjs: typeof Pdfjs | undefined;

async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  const module = await import("pdfjs-dist");
  module.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs = module;
}

function dispose(entry: Entry) {
  entry.disposed = true;
  void entry.task?.destroy().catch(() => {});
}

function retain(entry: Entry, url: string, cache: Map<string, Entry>) {
  if (entry.disposed) throw new DOMException("PDF was closed", "AbortError");
  entry.references += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    entry.references -= 1;
    if (entry.references || (entry.opened && cache === documents)) return;
    if (cache.get(url) === entry) cache.delete(url);
    if (!entry.disposed) dispose(entry);
  };
}

function open(url: string, cache: Map<string, Entry>) {
  const entry: Entry = {
    result: loadPdfjs().then(async (module) => {
      if (entry.disposed) throw new DOMException("PDF load cancelled", "AbortError");
      entry.task = module.getDocument(url);
      const document = await entry.task.promise;
      entry.opened = true;
      return { module, document, retain: () => retain(entry, url, cache) };
    }).catch((error) => {
      if (cache.get(url) === entry) cache.delete(url);
      if (!entry.disposed) dispose(entry);
      throw error;
    }),
    references: 0,
    opened: false,
    disposed: false,
  };
  cache.set(url, entry);
  return entry;
}

function cacheForNewDocument() {
  if (documents.size < MAX_DOCUMENTS) return documents;
  for (const [url, entry] of documents) {
    if (entry.references) continue;
    documents.delete(url);
    dispose(entry);
    return documents;
  }
  // Active callers can finish using their PDF even when every cache slot is leased.
  return overflow;
}

/** Lease a PDF for the lifetime of a viewer or text extraction. */
export async function acquirePdf(url: string, signal: AbortSignal): Promise<Pdf & { release: () => void }> {
  signal.throwIfAborted();
  let cache = documents;
  let entry = cache.get(url);
  if (entry) {
    cache.delete(url);
    cache.set(url, entry);
  } else {
    entry = overflow.get(url);
    cache = entry ? overflow : cacheForNewDocument();
    entry ??= open(url, cache);
  }
  const drop = retain(entry, url, cache);
  function release() {
    signal.removeEventListener("abort", release);
    drop();
  }
  // Drop the reference immediately if the requesting viewer leaves during a load.
  signal.addEventListener("abort", release, { once: true });

  try {
    const pdf = await entry.result;
    signal.throwIfAborted();
    return { ...pdf, release };
  } catch (error) {
    release();
    throw error;
  }
}

const readyPages = new WeakMap<PDFDocumentProxy, Map<number, PDFPageProxy>>();

/** pdf.js shares in-flight page loads. Keep the ready path synchronous for prefetched pages. */
export function pdfPage(document: PDFDocumentProxy, page: number): PDFPageProxy | Promise<PDFPageProxy> {
  const number = Math.min(Math.max(page, 1), document.numPages);
  let pages = readyPages.get(document);
  if (!pages) {
    pages = new Map();
    readyPages.set(document, pages);
  }
  const ready = pages.get(number);
  if (ready) return ready;
  return document.getPage(number).then((proxy) => {
    pages.set(number, proxy);
    return proxy;
  });
}

const pagePainters = new WeakMap<PDFPageProxy, number>();

/** Keep display resources while a page is visible, and release them after its last paint settles. */
export function renderPdfPage(pdf: Pdf, page: PDFPageProxy, params: Parameters<PDFPageProxy["render"]>[0]) {
  const releasePdf = pdf.retain();
  pagePainters.set(page, (pagePainters.get(page) ?? 0) + 1);

  function releasePage() {
    const remaining = pagePainters.get(page)! - 1;
    try {
      if (remaining) {
        pagePainters.set(page, remaining);
      } else {
        pagePainters.delete(page);
        // If a cancelled operator-list stream is still winding down, pdf.js finishes cleanup itself.
        page.cleanup();
      }
    } finally {
      releasePdf();
    }
  }

  try {
    const task = page.render(params);
    let settled = false;
    let released = false;
    const markSettled = () => { settled = true; };
    const settlement = task.promise.then(markSettled, markSettled);
    return {
      promise: task.promise,
      release() {
        if (released) return;
        released = true;
        // A resize can replace this paint with another lease of the same page in this flush.
        void settlement.then(releasePage);
        if (!settled) task.cancel();
      },
    };
  } catch (error) {
    releasePage();
    throw error;
  }
}

type PageText = { content: TextContent; runs: Run[] };
const MAX_TEXT_PAGES = 12;
const textByDocument = new WeakMap<PDFDocumentProxy, Map<PDFPageProxy, Promise<PageText>>>();

/** Share text extraction between the strip and reader, including on viewport resizes. */
export function pdfText(pdf: Pdf, page: PDFPageProxy): Promise<PageText> {
  let pageText = textByDocument.get(pdf.document);
  if (!pageText) {
    pageText = new Map();
    textByDocument.set(pdf.document, pageText);
  }
  const cache = pageText;
  const cached = cache.get(page);
  if (cached) {
    cache.delete(page);
    cache.set(page, cached);
    return cached;
  }
  const text = extractText(pdf, page).catch((error) => {
    if (cache.get(page) === text) cache.delete(page);
    throw error;
  });
  if (cache.size === MAX_TEXT_PAGES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(page, text);
  return text;
}

async function extractText(pdf: Pdf, page: PDFPageProxy): Promise<PageText> {
  const release = pdf.retain();
  try {
    const content = await page.getTextContent();
    return { content, runs: textRuns(pdf.module, page.getViewport({ scale: 1 }), content) };
  } finally {
    release();
  }
}

/** The text runs with boxes expressed as fractions of the unscaled page. */
function textRuns(module: typeof Pdfjs, viewport: PageViewport, content: TextContent): Run[] {
  const runs: Run[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const [, , c, d, e, f] = module.Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(c, d);
    const width = item.width * viewport.scale;
    runs.push({
      text: item.str,
      box: [e / viewport.width, (f - size * 0.85) / viewport.height, (e + width) / viewport.width, (f + size * 0.2) / viewport.height],
    });
  }
  return runs;
}
