import type { Document, DocumentPageResult, DocumentSort, PageInfo, SearchRequest, SearchResponse } from "./types.ts";

export type DocumentListQuery = {
  query?: string;
  sender?: string;
  createdFrom?: string;
  createdTo?: string;
  sort: DocumentSort;
  pageSize: number;
};

/** The parts of the Paperless API the agent's tools use. */
export interface Paperless {
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
  listDocuments(query: DocumentListQuery, signal?: AbortSignal): Promise<DocumentPageResult>;
  pages(documentId: number, signal?: AbortSignal): Promise<PageInfo[]>;
  document(documentId: number, signal?: AbortSignal): Promise<Document | null>;
  senders(signal?: AbortSignal): Promise<string[]>;
}

export class PaperlessClient implements Paperless {
  constructor(private readonly baseUrl: string) {}

  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    return this.request("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  }

  listDocuments(query: DocumentListQuery, signal?: AbortSignal): Promise<DocumentPageResult> {
    const params = new URLSearchParams({ page: "1", page_size: String(query.pageSize), sort: query.sort });
    if (query.query) params.set("query", query.query);
    if (query.sender) params.set("sender", query.sender);
    if (query.createdFrom) params.set("created_from", query.createdFrom);
    if (query.createdTo) params.set("created_to", query.createdTo);
    return this.request(`/api/documents?${params}`, { signal });
  }

  pages(documentId: number, signal?: AbortSignal): Promise<PageInfo[]> {
    return this.request(`/api/documents/${documentId}/pages`, { signal });
  }

  async document(documentId: number, signal?: AbortSignal): Promise<Document | null> {
    const response = await fetch(`${this.baseUrl}/api/documents/${documentId}`, { signal });
    if (response.status === 404) return null;
    return body(response);
  }

  senders(signal?: AbortSignal): Promise<string[]> {
    return this.request("/api/senders", { signal });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    return body(await fetch(`${this.baseUrl}${path}`, init));
  }
}

async function body<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || `Paperless request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}
