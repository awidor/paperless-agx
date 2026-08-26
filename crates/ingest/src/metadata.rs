use anyhow::{Context, Result, bail};
use paperless_models::{Document, DocumentPatch, InferredMetadata, MetadataSource};
use paperless_search::ChunkRepository;
use paperless_storage::DocumentRepository;

#[derive(Clone)]
pub struct MetadataService {
    documents: DocumentRepository,
    chunks: ChunkRepository,
}

impl MetadataService {
    pub fn new(documents: DocumentRepository, chunks: ChunkRepository) -> Self {
        Self { documents, chunks }
    }

    pub async fn apply_inferred(
        &self,
        document_id: u64,
        inferred: InferredMetadata,
    ) -> Result<Document> {
        let mut document = self.active(document_id).await?;
        if document.title_source != Some(MetadataSource::Manual) {
            if let Some(title) = clean(inferred.title, 500, "title")? {
                document.title = Some(title);
                document.title_source = Some(MetadataSource::Ai);
            }
        }
        if document.type_source != Some(MetadataSource::Manual) {
            if let Some(document_type) = clean(inferred.document_type, 100, "document_type")? {
                document.document_type = Some(document_type);
                document.type_source = Some(MetadataSource::Ai);
            }
        }
        if document.created_at_source != Some(MetadataSource::Manual) {
            if let Some(created_at) = inferred.created_at {
                document.created_at = Some(created_at);
                document.created_at_source = Some(MetadataSource::Ai);
            }
        }
        self.persist(&document).await
    }

    pub async fn apply_manual(&self, document_id: u64, patch: DocumentPatch) -> Result<Document> {
        let mut document = self.active(document_id).await?;
        if let Some(title) = patch.title {
            document.title = clean(title, 500, "title")?;
            document.title_source = Some(MetadataSource::Manual);
        }
        if let Some(document_type) = patch.document_type {
            document.document_type = clean(document_type, 100, "document_type")?;
            document.type_source = Some(MetadataSource::Manual);
        }
        if let Some(created_at) = patch.created_at {
            document.created_at = created_at;
            document.created_at_source = Some(MetadataSource::Manual);
        }
        self.persist(&document).await
    }

    async fn active(&self, document_id: u64) -> Result<Document> {
        self.documents
            .get(document_id)
            .await?
            .filter(|document| document.deleted_at.is_none())
            .context("document does not exist")
    }

    async fn persist(&self, document: &Document) -> Result<Document> {
        self.documents.write_metadata(document).await?;
        self.chunks
            .update_filters(
                document.document_id,
                document.document_type.as_deref(),
                document.created_at,
            )
            .await?;
        self.documents
            .get(document.document_id)
            .await?
            .context("document disappeared after metadata update")
    }
}

fn clean(value: Option<String>, maximum: usize, field: &str) -> Result<Option<String>> {
    let value = value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if value
        .as_ref()
        .is_some_and(|value| value.chars().count() > maximum)
    {
        bail!("{field} exceeds {maximum} characters");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use paperless_models::{
        Chunk, Document, DocumentPatch, InferredMetadata, IngestionStatus, MediaType,
        MetadataSource,
    };
    use paperless_search::ChunkRepository;
    use paperless_storage::{DataLayout, DocumentRepository};

    use super::MetadataService;

    #[tokio::test]
    async fn manual_metadata_survives_inference_and_updates_chunk_filters() {
        let temporary = tempfile::tempdir().unwrap();
        let layout = DataLayout::create(temporary.path()).await.unwrap();
        let documents = DocumentRepository::open(&layout).await.unwrap();
        let chunks = ChunkRepository::open(&layout.lance).await.unwrap();
        let now = Utc::now();
        let document = Document {
            document_id: 1,
            content_hash: [1; 32],
            media_type: MediaType::Image,
            filename: "scan.png".into(),
            title: None,
            document_type: None,
            created_at: None,
            added_at: now,
            updated_at: now,
            title_source: None,
            type_source: None,
            created_at_source: None,
            page_count: 1,
            file_size: 1,
            status: IngestionStatus::Ready,
            last_error: None,
            retry_count: 0,
            deleted_at: None,
        };
        documents.insert(&document).await.unwrap();
        chunks
            .replace_document(
                1,
                vec![Chunk {
                    chunk_id: (1_u64 << 32) | 1,
                    document_id: 1,
                    page_start: 1,
                    page_end: 1,
                    char_start: 0,
                    char_end: 4,
                    text: "text".into(),
                    embedding: vec![0.0; 1024],
                    created_at: None,
                    document_type: None,
                }],
            )
            .await
            .unwrap();
        let service = MetadataService::new(documents, chunks.clone());
        service
            .apply_manual(
                1,
                DocumentPatch {
                    title: Some(Some("Manual title".into())),
                    document_type: Some(Some("Receipt".into())),
                    created_at: Some(Some(Utc.with_ymd_and_hms(2025, 2, 3, 0, 0, 0).unwrap())),
                },
            )
            .await
            .unwrap();
        let result = service
            .apply_inferred(
                1,
                InferredMetadata {
                    title: Some("AI title".into()),
                    document_type: Some("Invoice".into()),
                    created_at: Some(Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap()),
                },
            )
            .await
            .unwrap();
        assert_eq!(result.title.as_deref(), Some("Manual title"));
        assert_eq!(result.title_source, Some(MetadataSource::Manual));
        assert_eq!(result.document_type.as_deref(), Some("Receipt"));
        let stored_chunks = chunks.list_document(1).await.unwrap();
        assert_eq!(stored_chunks[0].document_type.as_deref(), Some("Receipt"));
        assert_eq!(stored_chunks[0].created_at, result.created_at);
    }
}
