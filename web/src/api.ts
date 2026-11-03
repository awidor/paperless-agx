import type { components } from "./api.generated";

export type Document = components["schemas"]["Document"];
export type DocumentPageResult = components["schemas"]["DocumentPageResult"];
export type DocumentPatch = components["schemas"]["DocumentPatch"];
export type DocumentSort = components["schemas"]["DocumentSort"];
export type HealthResponse = components["schemas"]["HealthResponse"];
export type OcrBlock = components["schemas"]["OcrBlock"];
export type PageInfo = components["schemas"]["PageInfo"];
export type SearchPassage = components["schemas"]["SearchPassage"];
export type SearchInterpretation = components["schemas"]["SearchInterpretation"];
export type SearchHit = components["schemas"]["SearchHit"];
export type SearchRequest = components["schemas"]["SearchRequest"];
export type SearchResponse = components["schemas"]["SearchResponse"];
export type PassageKind = components["schemas"]["PassageKind"];
export type AgentSearchRequest = components["schemas"]["AgentSearchRequest"];
export type AgentProgress = components["schemas"]["AgentProgress"];
export type AgentResultItem = components["schemas"]["AgentResultItem"];
export type AgentSearchResult = components["schemas"]["AgentSearchResult"];

async function responseBody<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  return responseBody(await fetch(input, init));
}

export type LibraryQuery = {
  page: number;
  pageSize: number;
  sender: string;
  createdFrom: string;
  createdTo: string;
  sort: DocumentSort;
  metadataQuery?: string;
};

export function listDocuments(query: LibraryQuery): Promise<DocumentPageResult> {
  const params = new URLSearchParams({
    page: String(query.page),
    page_size: String(query.pageSize),
    sort: query.sort,
  });
  if (query.sender) params.set("sender", query.sender);
  if (query.createdFrom) params.set("created_from", new Date(`${query.createdFrom}T00:00:00`).toISOString());
  if (query.createdTo) params.set("created_to", new Date(`${query.createdTo}T23:59:59`).toISOString());
  if (query.metadataQuery) params.set("query", query.metadataQuery);
  return request(`/api/documents?${params}`);
}

export async function uploadDocument(file: File): Promise<{ document: Document; duplicate: boolean }> {
  const body = new FormData();
  body.set("file", file);
  const response = await fetch("/api/documents", { method: "POST", body });
  return { document: await responseBody<Document>(response), duplicate: response.status === 200 };
}

export function getDocument(id: number): Promise<Document> {
  return request(`/api/documents/${id}`);
}

export function getPages(id: number): Promise<PageInfo[]> {
  return request(`/api/documents/${id}/pages`);
}

export function patchDocument(id: number, patch: DocumentPatch): Promise<Document> {
  return request(`/api/documents/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function deleteDocument(id: number): Promise<void> {
  return request(`/api/documents/${id}`, { method: "DELETE" });
}

export function retryDocument(id: number): Promise<Document> {
  return request(`/api/documents/${id}/retry`, { method: "POST" });
}

export function inferDocumentMetadata(id: number): Promise<Document> {
  return request(`/api/documents/${id}/infer-metadata`, { method: "POST" });
}


export function searchDocuments(payload: SearchRequest): Promise<SearchResponse> {
  return request("/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
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
  if (!response.ok || !response.body) {
    await responseBody(response);
    throw new Error("The search agent did not respond.");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    for (let boundary = buffer.indexOf("\n\n"); boundary >= 0; boundary = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
      if (!event || !data) continue;
      const message = JSON.parse(data);
      if (event === "progress") onProgress(message as AgentProgress);
      else if (event === "result") return message as AgentSearchResult;
      else if (event === "error") throw new Error((message as { message: string }).message);
    }
  }
  throw new Error("The search agent stopped without results.");
}

export function getSenders(): Promise<string[]> {
  return request("/api/senders");
}

export function getHealth(): Promise<HealthResponse> {
  return request("/api/health");
}
