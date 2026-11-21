import type { BrowserContext, Page } from "@playwright/test";
import type { Document } from "../../src/client/api";
import { pageImage, sampleDocuments, samplePage } from "./documents";

export const documentFixtures: Document[] = sampleDocuments.map((entry) => ({
  ...entry, content_hash: [], updated_at: entry.added_at, retry_count: 0, status: "READY", media_type: "image",
}));

export const passage = (page = 1) => ({ chunk_id: page, page, char_start: 0, char_end: 20, snippet: "", score: 1, kind: "page" });
export const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

export function pdfWithPages(titles: string[]): Buffer {
  const pageRefs = titles.map((_, index) => `${index * 2 + 4} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${titles.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const title of titles) {
    const stream = `BT /F1 22 Tf 60 710 Td (${title}) Tj 0 -60 Td /F1 12 Tf (Payment due 30.09.2026) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

type Options = {
  documents?: Document[];
  thumbnail?: (id: number) => boolean;
  scan?: string | true;
  onList?: (params: URLSearchParams) => void | Promise<void>;
  onExact?: (body: unknown) => object | Promise<object>;
  onPages?: (id: number) => void | Promise<void>;
  onPatch?: (body: Record<string, string | null>) => void | Promise<void>;
};

/** Serve deterministic data and record asset traffic, including requests from workers. */
export async function mockArchive(context: BrowserContext, options: Options = {}) {
  let documents = options.documents ?? documentFixtures.map((document) => ({ ...document }));
  const imageRequests: number[] = [];
  const pdfRequests: number[] = [];
  const thumbnailRequests: number[] = [];
  const listRequests: URLSearchParams[] = [];
  const documentRequests: number[] = [];
  const pagesRequests: number[] = [];
  const raster = Buffer.from(RASTER, "base64");

  await context.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const url = new URL(route.request().url());
    const [, , resource, idText, asset, , image] = url.pathname.split("/");
    const id = Number(idText);
    const document = documents.find((item) => item.document_id === id);
    const sample = sampleDocuments.find((item) => item.document_id === id);
    const method = route.request().method();
    if (resource === "health") {
      return route.fulfill({ json: { embedding_configured: true, scanner_configured: Boolean(options.scan) } });
    }
    if (resource === "senders") return route.fulfill({ json: [...new Set(documents.map((item) => item.sender).filter(Boolean))] });
    if (resource === "scan") return route.fulfill({ contentType: "text/event-stream", body: typeof options.scan === "string" ? options.scan : "" });
    if (resource === "search" && !idText) return route.fulfill({ json: await options.onExact?.(route.request().postDataJSON()) ?? { items: [] } });
    if (resource === "documents" && !idText) {
      const params = url.searchParams;
      listRequests.push(params);
      await options.onList?.(params);
      const sender = params.get("sender");
      const from = params.get("created_from");
      const to = params.get("created_to");
      const list = documents.filter((item) => (!sender || item.sender === sender)
        && (!from || (item.created_at ?? item.added_at) >= from) && (!to || (item.created_at ?? item.added_at) <= to));
      if (params.get("sort") === "title_asc") list.sort((left, right) => left.title!.localeCompare(right.title!));
      const page = Number(params.get("page") ?? 1);
      const pageSize = Number(params.get("page_size") ?? 24);
      return route.fulfill({ json: { items: list.slice((page - 1) * pageSize, page * pageSize), total: list.length, page, page_size: pageSize } });
    }
    if (!document) return route.fulfill({ status: 404, json: { error: "Document missing" } });
    if (asset === "thumbnails") {
      thumbnailRequests.push(id);
      return options.thumbnail?.(id) === false
        ? route.fulfill({ status: 404 })
        : route.fulfill({ contentType: "image/webp", body: raster });
    }
    if (asset === "pages" && image === "image") {
      imageRequests.push(id);
      return route.fulfill({ contentType: "image/webp", body: raster });
    }
    if (asset === "file") {
      if (document.media_type === "pdf") {
        pdfRequests.push(id);
        const titles = Array.from({ length: document.page_count }, (_, index) => index ? `Statement page ${index + 1}` : "Electricity statement");
        return route.fulfill({ contentType: "application/pdf", body: pdfWithPages(titles) });
      }
      return route.fulfill({ contentType: "image/svg+xml", body: pageImage(sample) });
    }
    if (asset === "pages") {
      pagesRequests.push(id);
      await options.onPages?.(id);
      return route.fulfill({ json: Array.from({ length: document.page_count }, (_, index) => ({
        ...samplePage(sample),
        page: index + 1,
        text: `Document OCR for page ${index + 1}`,
        blocks: [{ label: "Text", bbox: [100, 100, 300, 130], text: index ? "Second page OCR" : "Electricity statement 30.09.2026" }],
      })) });
    }
    if (asset === "retry") {
      document.status = "OCR";
      return route.fulfill({ json: document });
    }
    if (method === "PATCH") {
      const patch = route.request().postDataJSON() as Record<string, string | null>;
      await options.onPatch?.(patch);
      Object.assign(document, patch, { title_source: "manual", sender_source: "manual" });
    }
    if (method === "DELETE") {
      documents = documents.filter((item) => item.document_id !== id);
      return route.fulfill({ status: 204 });
    }
    if (method === "GET") documentRequests.push(id);
    return route.fulfill({ json: document });
  });

  return { documents, listRequests, imageRequests, pdfRequests, thumbnailRequests, documentRequests, pagesRequests };
}

type TestStream = { body: unknown; signal?: AbortSignal | null; send: (data: string, close: boolean) => void };

declare global {
  interface Window { testStreams: TestStream[] }
}

/** Deliver one SSE response in controllable chunks, with the same abort behavior as fetch. */
export async function installEventStream(page: Page, endpoint: string) {
  await page.addInitScript((endpoint) => {
    const browser: Window = window;
    const fetch = browser.fetch;
    browser.testStreams = [];
    browser.fetch = (input, init) => {
      if (input !== endpoint) return fetch(input, init);
      const signal = init?.signal;
      if (signal?.aborted) return Promise.reject(signal.reason);
      let stop: () => void;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => controller.error(signal?.reason);
          signal?.addEventListener("abort", abort, { once: true });
          stop = () => signal?.removeEventListener("abort", abort);
          browser.testStreams.push({
            body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
            signal,
            send(data, close) {
              controller.enqueue(new TextEncoder().encode(data));
              if (close) {
                stop();
                controller.close();
              }
            },
          });
        },
        cancel: () => stop(),
      });
      return Promise.resolve(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    };
  }, endpoint);
}

export async function sendStream(page: Page, data: string, close = false) {
  await page.evaluate(({ data, close }) => window.testStreams.at(-1)!.send(data, close), { data, close });
}

const RASTER = "UklGRjQAAABXRUJQVlA4TCgAAAAvY8AiAA9wmv/T/J/mf/7jwaCmbSOozEv8I1DddktE/ycAh1Y55UcE";
