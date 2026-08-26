import type { components } from "./api.generated";

export type Document = components["schemas"]["Document"];
export type DocumentPageResult = components["schemas"]["DocumentPageResult"];
export type DocumentPatch = components["schemas"]["DocumentPatch"];
export type DocumentSort = components["schemas"]["DocumentSort"];
export type HealthResponse = components["schemas"]["HealthResponse"];
export type PageInfo = components["schemas"]["PageInfo"];
export type SearchHit = components["schemas"]["SearchHit"];
export type SearchRequest = components["schemas"]["SearchRequest"];
export type SearchResponse = components["schemas"]["SearchResponse"];

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type LibraryQuery = {
  page: number;
  pageSize: number;
  documentType: string;
  createdFrom: string;
  createdTo: string;
  sort: DocumentSort;
};

export function listDocuments(query: LibraryQuery): Promise<DocumentPageResult> {
  const params = new URLSearchParams({
    page: String(query.page),
    page_size: String(query.pageSize),
    sort: query.sort,
  });
  if (query.documentType) params.set("document_type", query.documentType);
  if (query.createdFrom) params.set("created_from", new Date(`${query.createdFrom}T00:00:00`).toISOString());
  if (query.createdTo) params.set("created_to", new Date(`${query.createdTo}T23:59:59`).toISOString());
  return request(`/api/documents?${params}`);
}

export function uploadDocument(file: File): Promise<Document> {
  const body = new FormData();
  body.set("file", file);
  return request("/api/documents", { method: "POST", body });
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

export function searchDocuments(payload: SearchRequest): Promise<SearchResponse> {
  return request("/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function getDocumentTypes(): Promise<string[]> {
  return request("/api/document-types");
}

export function getHealth(): Promise<HealthResponse> {
  return request("/api/health");
}
