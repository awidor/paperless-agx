use std::{fmt, str::FromStr};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Length of every stored chunk embedding (Gemini Embedding 2 at full size).
pub const EMBEDDING_DIMENSION: usize = 3072;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaType {
    Pdf,
    Image,
}

impl MediaType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Image => "image",
        }
    }
}

impl fmt::Display for MediaType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for MediaType {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "pdf" => Ok(Self::Pdf),
            "image" => Ok(Self::Image),
            _ => Err(format!("unknown media type: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetadataSource {
    Ai,
    Manual,
}

impl MetadataSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ai => "ai",
            Self::Manual => "manual",
        }
    }
}

impl FromStr for MetadataSource {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "ai" => Ok(Self::Ai),
            "manual" => Ok(Self::Manual),
            _ => Err(format!("unknown metadata source: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IngestionStatus {
    Stored,
    Previewing,
    Ocr,
    TextReady,
    Embedding,
    Indexing,
    Ready,
    Failed,
}

impl IngestionStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stored => "STORED",
            Self::Previewing => "PREVIEWING",
            Self::Ocr => "OCR",
            Self::TextReady => "TEXT_READY",
            Self::Embedding => "EMBEDDING",
            Self::Indexing => "INDEXING",
            Self::Ready => "READY",
            Self::Failed => "FAILED",
        }
    }

    pub const fn needs_pre_ocr_resume(self) -> bool {
        matches!(self, Self::Stored | Self::Previewing)
    }
}

impl fmt::Display for IngestionStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for IngestionStatus {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "STORED" => Ok(Self::Stored),
            "PREVIEWING" => Ok(Self::Previewing),
            "OCR" => Ok(Self::Ocr),
            "TEXT_READY" => Ok(Self::TextReady),
            "EMBEDDING" => Ok(Self::Embedding),
            "INDEXING" => Ok(Self::Indexing),
            "READY" => Ok(Self::Ready),
            "FAILED" => Ok(Self::Failed),
            _ => Err(format!("unknown ingestion status: {value}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Document {
    pub document_id: u64,
    pub content_hash: [u8; 32],
    pub media_type: MediaType,
    pub filename: String,
    pub title: Option<String>,
    pub sender: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub added_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub title_source: Option<MetadataSource>,
    pub sender_source: Option<MetadataSource>,
    pub created_at_source: Option<MetadataSource>,
    pub page_count: u32,
    pub file_size: u64,
    pub status: IngestionStatus,
    pub last_error: Option<String>,
    pub retry_count: u32,
    pub deleted_at: Option<DateTime<Utc>>,
    /// AI summary: the kind of document, its subject and the facts people search for.
    #[serde(default)]
    pub summary: Option<String>,
}

impl Document {
    pub fn content_hash_hex(&self) -> String {
        self.content_hash
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadMetadata {
    pub filename: String,
    pub title: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OcrBlock {
    pub label: String,
    pub bbox: [u16; 4],
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentPage {
    pub document_id: u64,
    pub page: u32,
    pub text: String,
    pub blocks: Vec<OcrBlock>,
    pub html: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageInfo {
    pub page: u32,
    pub thumbnail_ready: bool,
    pub text: Option<String>,
    pub blocks: Vec<OcrBlock>,
    pub html: Option<String>,
}

/// Chunk ordinals start at one; ordinal zero holds the document summary.
const SUMMARY_CHUNK_ORDINAL: u64 = 0;

pub fn summary_chunk_id(document_id: u64) -> u64 {
    (document_id << 32) | SUMMARY_CHUNK_ORDINAL
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Chunk {
    pub chunk_id: u64,
    pub document_id: u64,
    pub page_start: u32,
    pub page_end: u32,
    pub char_start: u32,
    pub char_end: u32,
    pub text: String,
    pub embedding: Vec<f32>,
    pub created_at: Option<DateTime<Utc>>,
    pub sender: Option<String>,
}

impl Chunk {
    /// The summary passage is not page text, so it has no place on a page to highlight.
    pub fn is_summary(&self) -> bool {
        self.chunk_id == summary_chunk_id(self.document_id)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentSort {
    #[default]
    DocumentDateDesc,
    DocumentDateAsc,
    AddedDateDesc,
    AddedDateAsc,
    TitleAsc,
    TitleDesc,
    SenderAsc,
    SenderDesc,
    FileSizeAsc,
    FileSizeDesc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DocumentQuery {
    pub page: u32,
    pub page_size: u32,
    pub query: Option<String>,
    pub sender: Option<String>,
    pub created_from: Option<DateTime<Utc>>,
    pub created_to: Option<DateTime<Utc>>,
    pub sort: DocumentSort,
}

impl Default for DocumentQuery {
    fn default() -> Self {
        Self {
            page: 1,
            page_size: 24,
            query: None,
            sender: None,
            created_from: None,
            created_to: None,
            sort: DocumentSort::DocumentDateDesc,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentPageResult {
    pub items: Vec<Document>,
    pub page: u32,
    pub page_size: u32,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct DocumentPatch {
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub title: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub sender: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub created_at: Option<Option<DateTime<Utc>>>,
}

/// Passage search, used by the search agent and for quoted exact-text searches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchRequest {
    pub query: String,
    pub page: u32,
    pub page_size: u32,
    #[serde(default)]
    pub sender: Option<String>,
    #[serde(default)]
    pub created_from: Option<DateTime<Utc>>,
    #[serde(default)]
    pub created_to: Option<DateTime<Utc>>,
    /// Only passages that contain the query text as written; no meaning search.
    #[serde(default)]
    pub exact: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PassageKind {
    /// Text from a page.
    #[default]
    Page,
    /// The document's AI summary.
    Summary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchPassage {
    pub chunk_id: u64,
    pub page: u32,
    pub char_start: u32,
    pub char_end: u32,
    pub snippet: String,
    pub score: f32,
    #[serde(default)]
    pub kind: PassageKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchHit {
    pub document: Document,
    pub best_chunk_id: u64,
    pub page: u32,
    pub snippet: String,
    pub score: f32,
    #[serde(default)]
    pub passages: Vec<SearchPassage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchResponse {
    pub items: Vec<SearchHit>,
    pub page: u32,
    pub page_size: u32,
    pub total: u64,
}

/// A search answered by the search agent. Sender and dates, when set, limit every lookup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSearchRequest {
    pub query: String,
    #[serde(default)]
    pub sender: Option<String>,
    #[serde(default)]
    pub created_from: Option<DateTime<Utc>>,
    #[serde(default)]
    pub created_to: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct InferredMetadata {
    pub title: Option<String>,
    pub sender: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub summary: Option<String>,
}

fn deserialize_double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub ocr_configured: bool,
    pub ocr_base_url: String,
    pub ocr_model: String,
    pub metadata_model: String,
    pub embedding_configured: bool,
    pub embedding_model: String,
    pub agent_configured: bool,
}

#[cfg(test)]
mod tests {
    use super::IngestionStatus;

    #[test]
    fn only_pre_ocr_states_resume_in_the_pre_ocr_worker() {
        assert!(IngestionStatus::Stored.needs_pre_ocr_resume());
        assert!(IngestionStatus::Previewing.needs_pre_ocr_resume());
        assert!(!IngestionStatus::Ocr.needs_pre_ocr_resume());
        assert!(!IngestionStatus::Failed.needs_pre_ocr_resume());
    }
}
