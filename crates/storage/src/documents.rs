use std::{
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use paperless_models::{Document, IngestionStatus, MediaType, MetadataSource, UploadMetadata};
use rusqlite::{OptionalExtension, params};

use crate::{DataLayout, database::Database};

#[derive(Clone)]
pub struct DocumentRepository {
    database: Database,
    next_id: Arc<AtomicU64>,
}

impl DocumentRepository {
    pub async fn open(layout: &DataLayout) -> Result<Self> {
        let database = Database::open(layout).await?;
        let next_id = database
            .run(|connection| {
                let maximum: Option<i64> =
                    connection.query_row("SELECT MAX(document_id) FROM documents", [], |row| {
                        row.get(0)
                    })?;
                let maximum = maximum.unwrap_or(0);
                u64::try_from(maximum)
                    .context("stored document id is negative")?
                    .checked_add(1)
                    .context("document id space is exhausted")
            })
            .await?;
        Ok(Self {
            database,
            next_id: Arc::new(AtomicU64::new(next_id)),
        })
    }

    pub fn allocate_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub async fn insert(&self, document: &Document) -> Result<()> {
        let document = document.clone();
        self.database
            .run(move |connection| {
                connection
                    .execute(
                        "INSERT INTO documents (
                            document_id, content_hash, media_type, filename, title, sender,
                            created_at, added_at, updated_at, title_source, sender_source,
                            created_at_source, page_count, file_size, status, last_error,
                            retry_count, deleted_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        params![
                            i64_value(document.document_id, "document id")?,
                            document.content_hash.as_slice(),
                            document.media_type.as_str(),
                            document.filename,
                            document.title,
                            document.sender,
                            optional_timestamp(document.created_at),
                            timestamp(document.added_at),
                            timestamp(document.updated_at),
                            optional_source(document.title_source),
                            optional_source(document.sender_source),
                            optional_source(document.created_at_source),
                            i64_value(u64::from(document.page_count), "page count")?,
                            i64_value(document.file_size, "file size")?,
                            document.status.as_str(),
                            document.last_error,
                            i64_value(u64::from(document.retry_count), "retry count")?,
                            optional_timestamp(document.deleted_at),
                        ],
                    )
                    .context("insert document")?;
                Ok(())
            })
            .await
    }

    pub async fn get(&self, document_id: u64) -> Result<Option<Document>> {
        let document_id = i64_value(document_id, "document id")?;
        self.database
            .run(move |connection| {
                connection
                    .query_row(
                        "SELECT document_id, content_hash, media_type, filename, title, sender,
                                created_at, added_at, updated_at, title_source, sender_source,
                                created_at_source, page_count, file_size, status, last_error,
                                retry_count, deleted_at
                         FROM documents WHERE document_id = ?",
                        [document_id],
                        document_from_row,
                    )
                    .optional()
                    .context("query document by id")
            })
            .await
    }

    pub async fn find_by_hash(&self, content_hash: &[u8; 32]) -> Result<Option<Document>> {
        let content_hash = content_hash.to_vec();
        self.database
            .run(move |connection| {
                connection
                    .query_row(
                        "SELECT document_id, content_hash, media_type, filename, title, sender,
                                created_at, added_at, updated_at, title_source, sender_source,
                                created_at_source, page_count, file_size, status, last_error,
                                retry_count, deleted_at
                         FROM documents
                         WHERE content_hash = ? AND deleted_at IS NULL
                         LIMIT 1",
                        [content_hash],
                        document_from_row,
                    )
                    .optional()
                    .context("query document by content hash")
            })
            .await
    }

    pub async fn list_active(&self) -> Result<Vec<Document>> {
        self.list_where("deleted_at IS NULL", "list active documents")
            .await
    }

    pub async fn list_resumable_ingestion(&self) -> Result<Vec<Document>> {
        self.list_where(
            "deleted_at IS NULL AND status IN ('STORED', 'PREVIEWING', 'OCR', 'TEXT_READY', 'EMBEDDING', 'INDEXING')",
            "list resumable documents",
        )
        .await
    }

    pub async fn set_status(
        &self,
        document_id: u64,
        status: IngestionStatus,
        last_error: Option<String>,
    ) -> Result<()> {
        let document_id = i64_value(document_id, "document id")?;
        self.database
            .run(move |connection| {
                connection
                    .execute(
                        "UPDATE documents
                         SET status = ?, last_error = ?, updated_at = ?
                         WHERE document_id = ?",
                        params![
                            status.as_str(),
                            last_error,
                            timestamp(Utc::now()),
                            document_id
                        ],
                    )
                    .context("update document status")?;
                Ok(())
            })
            .await
    }

    pub async fn set_preview_ready(&self, document_id: u64, page_count: u32) -> Result<()> {
        let document_id = i64_value(document_id, "document id")?;
        self.database
            .run(move |connection| {
                connection
                    .execute(
                        "UPDATE documents
                         SET page_count = ?, status = ?, last_error = NULL, updated_at = ?
                         WHERE document_id = ?",
                        params![
                            i64_value(u64::from(page_count), "page count")?,
                            IngestionStatus::Ocr.as_str(),
                            timestamp(Utc::now()),
                            document_id
                        ],
                    )
                    .context("store preview result")?;
                Ok(())
            })
            .await
    }

    pub async fn mark_retry(&self, document_id: u64) -> Result<()> {
        let document_id = i64_value(document_id, "document id")?;
        self.database
            .run(move |connection| {
                connection
                    .execute(
                        "UPDATE documents
                         SET retry_count = retry_count + 1, status = ?, last_error = NULL,
                             updated_at = ?
                         WHERE document_id = ?",
                        params![
                            IngestionStatus::Stored.as_str(),
                            timestamp(Utc::now()),
                            document_id
                        ],
                    )
                    .context("mark document for retry")?;
                Ok(())
            })
            .await
    }

    pub async fn merge_missing_upload_metadata(
        &self,
        existing: &Document,
        metadata: &UploadMetadata,
    ) -> Result<Document> {
        let document_id = i64_value(existing.document_id, "document id")?;
        let title = (existing.title.is_none() && metadata.title.is_some())
            .then(|| metadata.title.clone())
            .flatten();
        let created_at = (existing.created_at.is_none() && metadata.created_at.is_some())
            .then_some(metadata.created_at)
            .flatten();
        let database = self.database.clone();
        database
            .run(move |connection| {
                if title.is_some() || created_at.is_some() {
                    connection
                        .execute(
                            "UPDATE documents
                             SET title = COALESCE(title, ?),
                                 title_source = CASE WHEN title IS NULL AND ? IS NOT NULL THEN ? ELSE title_source END,
                                 created_at = COALESCE(created_at, ?),
                                 created_at_source = CASE WHEN created_at IS NULL AND ? IS NOT NULL THEN ? ELSE created_at_source END,
                                 updated_at = ?
                             WHERE document_id = ?",
                            params![
                                title,
                                title,
                                MetadataSource::Manual.as_str(),
                                created_at.map(timestamp),
                                created_at.map(timestamp),
                                MetadataSource::Manual.as_str(),
                                timestamp(Utc::now()),
                                document_id,
                            ],
                        )
                        .context("merge duplicate upload metadata")?;
                }
                connection
                    .query_row(
                        "SELECT document_id, content_hash, media_type, filename, title, sender,
                                created_at, added_at, updated_at, title_source, sender_source,
                                created_at_source, page_count, file_size, status, last_error,
                                retry_count, deleted_at
                         FROM documents WHERE document_id = ?",
                        [document_id],
                        document_from_row,
                    )
                    .optional()?
                    .context("duplicate document disappeared after metadata merge")
            })
            .await
    }

    pub async fn write_metadata(&self, document: &Document) -> Result<()> {
        let document = document.clone();
        self.database
            .run(move |connection| {
                connection
                    .execute(
                        "UPDATE documents
                         SET title = ?, sender = ?, created_at = ?, title_source = ?,
                             sender_source = ?, created_at_source = ?, updated_at = ?
                         WHERE document_id = ?",
                        params![
                            document.title,
                            document.sender,
                            optional_timestamp(document.created_at),
                            optional_source(document.title_source),
                            optional_source(document.sender_source),
                            optional_source(document.created_at_source),
                            timestamp(Utc::now()),
                            i64_value(document.document_id, "document id")?,
                        ],
                    )
                    .context("write document metadata")?;
                Ok(())
            })
            .await
    }

    pub async fn soft_delete(&self, document_id: u64) -> Result<()> {
        let document_id = i64_value(document_id, "document id")?;
        self.database
            .run(move |connection| {
                connection
                    .execute(
                        "UPDATE documents SET deleted_at = ?, updated_at = ?
                         WHERE document_id = ? AND deleted_at IS NULL",
                        params![timestamp(Utc::now()), timestamp(Utc::now()), document_id],
                    )
                    .context("soft delete document")?;
                Ok(())
            })
            .await
    }

    pub async fn list_deleted(&self) -> Result<Vec<Document>> {
        self.list_where("deleted_at IS NOT NULL", "list deleted documents")
            .await
    }

    pub async fn has_active_hash(&self, content_hash: &[u8; 32]) -> Result<bool> {
        let content_hash = content_hash.to_vec();
        self.database
            .run(move |connection| {
                let found: Option<i64> = connection
                    .query_row(
                        "SELECT document_id FROM documents
                         WHERE content_hash = ? AND deleted_at IS NULL LIMIT 1",
                        [content_hash],
                        |row| row.get(0),
                    )
                    .optional()
                    .context("read active document hash")?;
                Ok(found.is_some())
            })
            .await
    }

    pub async fn senders(&self) -> Result<Vec<String>> {
        let mut senders = self
            .list_active()
            .await?
            .into_iter()
            .filter_map(|document| document.sender)
            .collect::<Vec<_>>();
        senders.sort_unstable_by_key(|value| value.to_lowercase());
        senders.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        Ok(senders)
    }

    async fn list_where(
        &self,
        predicate: &'static str,
        context: &'static str,
    ) -> Result<Vec<Document>> {
        self.database
            .run(move |connection| {
                let sql = format!(
                    "SELECT document_id, content_hash, media_type, filename, title, sender,
                            created_at, added_at, updated_at, title_source, sender_source,
                            created_at_source, page_count, file_size, status, last_error,
                            retry_count, deleted_at
                     FROM documents WHERE {predicate}
                     ORDER BY COALESCE(created_at, added_at) DESC, document_id DESC"
                );
                let mut statement = connection.prepare(&sql).context(context)?;
                let rows = statement
                    .query_map([], document_from_row)
                    .context(context)?;
                rows.collect::<rusqlite::Result<Vec<_>>>().context(context)
            })
            .await
    }
}

fn document_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Document> {
    let content_hash = row.get::<_, Vec<u8>>(1)?;
    let content_hash: [u8; 32] = content_hash.try_into().map_err(|_| {
        rusqlite::Error::InvalidColumnType(1, "content_hash".into(), rusqlite::types::Type::Blob)
    })?;
    let media_type = MediaType::from_str(row.get::<_, String>(2)?.as_str()).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::other(error)),
        )
    })?;
    let title_source = parse_source(row.get(9)?, 9)?;
    let sender_source = parse_source(row.get(10)?, 10)?;
    let created_at_source = parse_source(row.get(11)?, 11)?;
    Ok(Document {
        document_id: from_i64(row.get(0)?, "document_id")?,
        content_hash,
        media_type,
        filename: row.get(3)?,
        title: row.get(4)?,
        sender: row.get(5)?,
        created_at: from_optional_timestamp(row.get(6)?, 6)?,
        added_at: from_timestamp(row.get(7)?, 7)?,
        updated_at: from_timestamp(row.get(8)?, 8)?,
        title_source,
        sender_source,
        created_at_source,
        page_count: from_i64(row.get(12)?, "page_count")? as u32,
        file_size: from_i64(row.get(13)?, "file_size")?,
        status: IngestionStatus::from_str(row.get::<_, String>(14)?.as_str()).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                14,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::other(error)),
            )
        })?,
        last_error: row.get(15)?,
        retry_count: from_i64(row.get(16)?, "retry_count")? as u32,
        deleted_at: from_optional_timestamp(row.get(17)?, 17)?,
    })
}

fn parse_source(value: Option<String>, index: usize) -> rusqlite::Result<Option<MetadataSource>> {
    value
        .map(|value| {
            MetadataSource::from_str(&value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    index,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::other(error)),
                )
            })
        })
        .transpose()
}

fn timestamp(value: DateTime<Utc>) -> i64 {
    value.timestamp_micros()
}

fn optional_timestamp(value: Option<DateTime<Utc>>) -> Option<i64> {
    value.map(timestamp)
}

fn optional_source(value: Option<MetadataSource>) -> Option<&'static str> {
    value.map(MetadataSource::as_str)
}

fn i64_value(value: u64, field: &str) -> Result<i64> {
    i64::try_from(value).with_context(|| format!("{field} exceeds SQLite integer range"))
}

fn from_i64(value: i64, field: &str) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Integer,
            Box::new(std::io::Error::other(format!("{field} is negative"))),
        )
    })
}

fn from_timestamp(value: i64, index: usize) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::from_timestamp_micros(value).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(std::io::Error::other("invalid timestamp")),
        )
    })
}

fn from_optional_timestamp(
    value: Option<i64>,
    index: usize,
) -> rusqlite::Result<Option<DateTime<Utc>>> {
    value.map(|value| from_timestamp(value, index)).transpose()
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use paperless_models::{Document, IngestionStatus, MediaType};

    use super::DocumentRepository;
    use crate::DataLayout;

    fn document(id: u64, page_count: u32) -> Document {
        let now = Utc::now();
        Document {
            document_id: id,
            content_hash: [id as u8; 32],
            media_type: MediaType::Pdf,
            filename: format!("{id}.pdf"),
            title: None,
            sender: None,
            created_at: None,
            added_at: now,
            updated_at: now,
            title_source: None,
            sender_source: None,
            created_at_source: None,
            page_count,
            file_size: 42,
            status: IngestionStatus::Stored,
            last_error: None,
            retry_count: 0,
            deleted_at: None,
        }
    }

    #[tokio::test]
    async fn persists_documents_across_reopen_and_allocates_after_maximum() {
        let temporary = tempfile::tempdir().unwrap();
        let layout = DataLayout::create(temporary.path()).await.unwrap();
        let repository = DocumentRepository::open(&layout).await.unwrap();
        repository.insert(&document(7, 2)).await.unwrap();
        assert_eq!(repository.get(7).await.unwrap().unwrap().filename, "7.pdf");
        let reopened = DocumentRepository::open(&layout).await.unwrap();
        assert_eq!(reopened.allocate_id(), 8);
    }

    #[tokio::test]
    async fn active_hashes_are_unique_but_deleted_hashes_can_return() {
        let temporary = tempfile::tempdir().unwrap();
        let layout = DataLayout::create(temporary.path()).await.unwrap();
        let repository = DocumentRepository::open(&layout).await.unwrap();
        repository.insert(&document(1, 1)).await.unwrap();
        assert!(repository.has_active_hash(&[1; 32]).await.unwrap());
        repository.soft_delete(1).await.unwrap();
        assert!(!repository.has_active_hash(&[1; 32]).await.unwrap());
        assert_eq!(repository.list_deleted().await.unwrap().len(), 1);
    }
}
