import type { components } from "./api.generated.ts";

type Schemas = components["schemas"];
export type Document = Schemas["Document"];
export type DocumentPageResult = Schemas["DocumentPageResult"];
export type DocumentSort = Schemas["DocumentSort"];
export type PageInfo = Schemas["PageInfo"];
export type SearchPassage = Schemas["SearchPassage"];
export type SearchRequest = Schemas["SearchRequest"];
export type SearchResponse = Schemas["SearchResponse"];
export type AgentSearchRequest = Schemas["AgentSearchRequest"];
export type AgentProgress = Schemas["AgentProgress"];
export type AgentResultItem = Schemas["AgentResultItem"];
export type AgentSearchResult = Schemas["AgentSearchResult"];
