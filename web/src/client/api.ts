import type { components } from "./generated";

export type Document = components["schemas"]["Document"];
export type DocumentPageResult = components["schemas"]["DocumentPageResult"];
export type DocumentPatch = components["schemas"]["DocumentPatch"];
export type DocumentSort = components["schemas"]["DocumentSort"];
export type HealthResponse = components["schemas"]["HealthResponse"];
export type OcrBlock = components["schemas"]["OcrBlock"];
export type PageInfo = components["schemas"]["PageInfo"];
export type SearchPassage = components["schemas"]["SearchPassage"];
export type SearchHit = components["schemas"]["SearchHit"];
export type SearchRequest = components["schemas"]["SearchRequest"];
export type SearchResponse = components["schemas"]["SearchResponse"];
export type PassageKind = components["schemas"]["PassageKind"];
export type AgentSearchRequest = components["schemas"]["AgentSearchRequest"];
export type AgentProgress = components["schemas"]["AgentProgress"];
export type AgentResultItem = components["schemas"]["AgentResultItem"];
export type AgentSearchResult = components["schemas"]["AgentSearchResult"];
export type ScanSource = components["schemas"]["ScanSource"];
export type ScanMode = components["schemas"]["ScanMode"];
export type ScanRequest = Required<components["schemas"]["ScanRequest"]>;
export type ScanResult = components["schemas"]["ScanResult"];

async function responseBody<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(typeof payload?.error === "string" ? payload.error : response.statusText || `Request failed with ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  return responseBody(await fetch(input, init));
}

type PendingGet = { controller: AbortController; result: Promise<unknown>; readers: number };
const pendingGets = new Map<string, PendingGet>();

/** Share a GET while it is in flight. A caller can leave without cancelling other readers. */
async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let pending = pendingGets.get(url);
  if (!pending) {
    const controller = new AbortController();
    const result = request<T>(url, { signal: controller.signal }).finally(() => {
      if (pendingGets.get(url)?.controller === controller) pendingGets.delete(url);
    });
    pending = { controller, result, readers: 0 };
    pendingGets.set(url, pending);
  }
  const flight = pending;
  flight.readers += 1;
  return new Promise<T>((resolve, reject) => {
    let active = true;
    function release() {
      if (!active) return false;
      active = false;
      signal?.removeEventListener("abort", abort);
      flight.readers -= 1;
      return true;
    }
    function abort() {
      release();
      if (!flight.readers) {
        if (pendingGets.get(url) === flight) pendingGets.delete(url);
        flight.controller.abort();
      }
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
    flight.result.then(
      (value) => { if (release()) resolve(value as T); },
      (error) => { if (release()) reject(error); },
    );
  });
}

function invalidateDocumentGets(id: number) {
  const path = `/api/documents/${id}`;
  for (const url of pendingGets.keys()) {
    if (url === path || url === `${path}/pages` || url === "/api/senders" || url.startsWith("/api/documents?")) {
      pendingGets.delete(url);
    }
  }
}

export type LibraryQuery = {
  page: number;
  pageSize: number;
  sender: string;
  createdFrom: string;
  createdTo: string;
  sort: DocumentSort;
};

export function listDocuments(query: LibraryQuery, signal?: AbortSignal): Promise<DocumentPageResult> {
  const params = new URLSearchParams({
    page: String(query.page),
    page_size: String(query.pageSize),
    sort: query.sort,
  });
  if (query.sender) params.set("sender", query.sender);
  if (query.createdFrom) params.set("created_from", new Date(`${query.createdFrom}T00:00:00`).toISOString());
  if (query.createdTo) params.set("created_to", new Date(`${query.createdTo}T23:59:59`).toISOString());
  return get(`/api/documents?${params}`, signal);
}

export async function uploadDocument(file: File, signal?: AbortSignal): Promise<{ document: Document; duplicate: boolean }> {
  const body = new FormData();
  body.set("file", file);
  const response = await fetch("/api/documents", { method: "POST", body, signal });
  const document = await responseBody<Document>(response);
  invalidateDocumentGets(document.document_id);
  return { document, duplicate: response.status === 200 };
}

export function getDocument(id: number, signal?: AbortSignal): Promise<Document> {
  return get(`/api/documents/${id}`, signal);
}

export function getPages(id: number, signal?: AbortSignal): Promise<PageInfo[]> {
  return get(`/api/documents/${id}/pages`, signal);
}

export async function patchDocument(id: number, patch: DocumentPatch, signal?: AbortSignal): Promise<Document> {
  const document = await request<Document>(`/api/documents/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
    signal,
  });
  invalidateDocumentGets(id);
  return document;
}

export async function deleteDocument(id: number, signal?: AbortSignal): Promise<void> {
  await request(`/api/documents/${id}`, { method: "DELETE", signal });
  invalidateDocumentGets(id);
}

export async function retryDocument(id: number, signal?: AbortSignal): Promise<Document> {
  const document = await request<Document>(`/api/documents/${id}/retry`, { method: "POST", signal });
  invalidateDocumentGets(id);
  return document;
}

export function searchDocuments(payload: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
  return request("/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
}

/** The server-sent events of a response, each as its name and parsed JSON data. */
async function* serverEvents(response: Response, silent: string): AsyncGenerator<{ event: string; message: unknown }> {
  if (!response.ok || !response.body) {
    await responseBody(response);
    throw new Error(silent);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      for (let boundary = /\r?\n\r?\n/.exec(buffer); boundary; boundary = /\r?\n\r?\n/.exec(buffer)) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = /^event: ?([^\r\n]*)/m.exec(block)?.[1];
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.replace(/^data: ?/, "")).join("\n");
        if (event && data) yield { event, message: JSON.parse(data) };
      }
    }
  } finally {
    // A result, server error, or aborted search can end iteration before EOF.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Runs the search agent, reporting each lookup it makes, and resolves with its ranked results. */
export async function streamAgentSearch(
  payload: AgentSearchRequest,
  onProgress: (progress: AgentProgress) => void,
  signal: AbortSignal,
): Promise<AgentSearchResult> {
  const response = await fetch("/api/search/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  for await (const { event, message } of serverEvents(response, "The search agent did not respond.")) {
    if (event === "progress") onProgress(message as AgentProgress);
    else if (event === "result") return message as AgentSearchResult;
    else if (event === "error") throw new Error((message as { message: string }).message);
  }
  throw new Error("The search agent stopped without results.");
}

/** Scans from the printer, reporting each page as it is done, and resolves with the new document. */
export async function streamScan(payload: ScanRequest, onPage: (pages: number) => void, signal?: AbortSignal): Promise<ScanResult> {
  const response = await fetch("/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  for await (const { event, message } of serverEvents(response, "The scanner did not respond.")) {
    if (event === "progress") onPage((message as { pages: number }).pages);
    else if (event === "result") {
      const scanned = message as ScanResult;
      invalidateDocumentGets(scanned.document.document_id);
      return scanned;
    } else if (event === "error") throw new Error((message as { message: string }).message);
  }
  throw new Error("The scan stopped without a result.");
}

export function getSenders(signal?: AbortSignal): Promise<string[]> {
  return get("/api/senders", signal);
}

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return get("/api/health", signal);
}
