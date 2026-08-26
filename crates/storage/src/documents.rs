use std::{
    future::Future,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result};
use arrow_array::{
    Array, ArrayRef, FixedSizeBinaryArray, RecordBatch, RecordBatchIterator, RecordBatchReader,
    StringArray, TimestampMicrosecondArray, UInt32Array, UInt64Array,
};
use arrow_schema::{DataType, Field, Schema, SchemaRef, TimeUnit};
use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use lancedb::{
    Connection, Table,
    query::{ExecutableQuery, QueryBase},
};
use paperless_models::{Document, IngestionStatus, MediaType, MetadataSource, UploadMetadata};

use crate::layout::{DataLayout, hash_hex};

const DOCUMENTS_TABLE: &str = "documents";

#[derive(Clone)]
pub struct DocumentRepository {
    table: Table,
    next_id: Arc<AtomicU64>,
}

impl DocumentRepository {
    pub async fn open(layout: &DataLayout) -> Result<Self> {
        let connection = lancedb::connect(layout.lance.to_string_lossy().as_ref())
            .execute()
            .await
            .context("connect to LanceDB")?;
        let table = open_or_create_documents(&connection).await?;
        let next_id = maximum_document_id(&table)
            .await?
            .checked_add(1)
            .context("document id space is exhausted")?;
        Ok(Self {
            table,
            next_id: Arc::new(AtomicU64::new(next_id)),
        })
    }

    pub fn allocate_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub async fn insert(&self, document: &Document) -> Result<()> {
        let batch = document_batch(document)?;
        let schema = batch.schema();
        let reader: Box<dyn RecordBatchReader + Send> =
            Box::new(RecordBatchIterator::new(vec![Ok(batch)], schema));
        self.table
            .add(reader)
            .execute()
            .await
            .context("insert document")?;
        Ok(())
    }

    pub fn get(
        &self,
        document_id: u64,
    ) -> impl Future<Output = Result<Option<Document>>> + Send + 'static {
        let table = self.table.clone();
        async move {
            let batches = table
                .query()
                .only_if(format!("document_id = {document_id}"))
                .limit(1)
                .execute()
                .await
                .context("query document by id")?
                .try_collect::<Vec<_>>()
                .await
                .context("read document by id")?;
            documents_from_batches(&batches).map(|mut documents| documents.pop())
        }
    }

    pub async fn find_by_hash(&self, content_hash: &[u8; 32]) -> Result<Option<Document>> {
        let literal = hash_hex(content_hash);
        let batches = self
            .table
            .query()
            .only_if(format!(
                "content_hash = X'{literal}' AND deleted_at IS NULL"
            ))
            .limit(1)
            .execute()
            .await
            .context("query document by content hash")?
            .try_collect::<Vec<_>>()
            .await
            .context("read document by content hash")?;
        documents_from_batches(&batches).map(|mut documents| documents.pop())
    }

    pub async fn list_active(&self) -> Result<Vec<Document>> {
        let batches = self
            .table
            .query()
            .only_if("deleted_at IS NULL")
            .execute()
            .await
            .context("query active documents")?
            .try_collect::<Vec<_>>()
            .await
            .context("read active documents")?;
        let mut documents = documents_from_batches(&batches)?;
        documents.sort_by(|left, right| {
            let left_date = left.created_at.unwrap_or(left.added_at);
            let right_date = right.created_at.unwrap_or(right.added_at);
            right_date
                .cmp(&left_date)
                .then_with(|| right.document_id.cmp(&left.document_id))
        });
        Ok(documents)
    }

    pub async fn list_resumable_ingestion(&self) -> Result<Vec<Document>> {
        let batches = self
            .table
            .query()
            .only_if("deleted_at IS NULL AND status IN ('STORED', 'PREVIEWING', 'OCR', 'TEXT_READY', 'EMBEDDING', 'INDEXING')")
            .execute()
            .await
            .context("query resumable documents")?
            .try_collect::<Vec<_>>()
            .await
            .context("read resumable documents")?;
        documents_from_batches(&batches)
    }

    pub fn set_status(
        &self,
        document_id: u64,
        status: IngestionStatus,
        last_error: Option<String>,
    ) -> impl Future<Output = Result<()>> + Send + 'static {
        let table = self.table.clone();
        async move {
            let mut update = table
                .update()
                .only_if(format!("document_id = {document_id}"))
                .column("status", sql_string(status.as_str()))
                .column("updated_at", "now()");
            update = match last_error {
                Some(error) => update.column("last_error", sql_string(&error)),
                None => update.column("last_error", "NULL"),
            };
            update.execute().await.context("update document status")?;
            Ok(())
        }
    }

    pub fn set_preview_ready(
        &self,
        document_id: u64,
        page_count: u32,
    ) -> impl Future<Output = Result<()>> + Send + 'static {
        let table = self.table.clone();
        async move {
            table
                .update()
                .only_if(format!("document_id = {document_id}"))
                .column("page_count", page_count.to_string())
                .column("status", sql_string(IngestionStatus::Ocr.as_str()))
                .column("last_error", "NULL")
                .column("updated_at", "now()")
                .execute()
                .await
                .context("store preview result")?;
            Ok(())
        }
    }

    pub async fn mark_retry(&self, document_id: u64) -> Result<()> {
        self.table
            .update()
            .only_if(format!("document_id = {document_id}"))
            .column("retry_count", "retry_count + 1")
            .column("status", sql_string(IngestionStatus::Stored.as_str()))
            .column("last_error", "NULL")
            .column("updated_at", "now()")
            .execute()
            .await
            .context("mark document for retry")?;
        Ok(())
    }

    pub async fn merge_missing_upload_metadata(
        &self,
        existing: &Document,
        metadata: &UploadMetadata,
    ) -> Result<Document> {
        let mut update = self
            .table
            .update()
            .only_if(format!("document_id = {}", existing.document_id));
        let mut changed = false;
        if existing.title.is_none() && metadata.title.is_some() {
            update = update
                .column("title", sql_string(metadata.title.as_deref().unwrap()))
                .column("title_source", sql_string(MetadataSource::Manual.as_str()));
            changed = true;
        }
        if existing.document_type.is_none() && metadata.document_type.is_some() {
            update = update
                .column(
                    "document_type",
                    sql_string(metadata.document_type.as_deref().unwrap()),
                )
                .column("type_source", sql_string(MetadataSource::Manual.as_str()));
            changed = true;
        }
        if existing.created_at.is_none() && metadata.created_at.is_some() {
            update = update
                .column(
                    "created_at",
                    format!(
                        "arrow_cast({}, 'Timestamp(Microsecond, Some(\"UTC\"))')",
                        metadata.created_at.unwrap().timestamp_micros()
                    ),
                )
                .column(
                    "created_at_source",
                    sql_string(MetadataSource::Manual.as_str()),
                );
            changed = true;
        }
        if changed {
            update
                .column("updated_at", "now()")
                .execute()
                .await
                .context("merge duplicate upload metadata")?;
        }
        self.get(existing.document_id)
            .await?
            .context("duplicate document disappeared after metadata merge")
    }

    pub async fn write_metadata(&self, document: &Document) -> Result<()> {
        let update = self
            .table
            .update()
            .only_if(format!("document_id = {}", document.document_id))
            .column("title", sql_optional_string(document.title.as_deref()))
            .column(
                "document_type",
                sql_optional_string(document.document_type.as_deref()),
            )
            .column("created_at", sql_optional_timestamp(document.created_at))
            .column("title_source", sql_optional_source(document.title_source))
            .column("type_source", sql_optional_source(document.type_source))
            .column(
                "created_at_source",
                sql_optional_source(document.created_at_source),
            )
            .column("updated_at", "now()");
        update.execute().await.context("write document metadata")?;
        Ok(())
    }

    pub async fn soft_delete(&self, document_id: u64) -> Result<()> {
        self.table
            .update()
            .only_if(format!(
                "document_id = {document_id} AND deleted_at IS NULL"
            ))
            .column("deleted_at", "now()")
            .column("updated_at", "now()")
            .execute()
            .await
            .context("soft delete document")?;
        Ok(())
    }

    pub async fn list_deleted(&self) -> Result<Vec<Document>> {
        let batches = self
            .table
            .query()
            .only_if("deleted_at IS NOT NULL")
            .execute()
            .await
            .context("query deleted documents")?
            .try_collect::<Vec<_>>()
            .await
            .context("read deleted documents")?;
        documents_from_batches(&batches)
    }

    pub async fn has_active_hash(&self, content_hash: &[u8; 32]) -> Result<bool> {
        let literal = hash_hex(content_hash);
        let batches = self
            .table
            .query()
            .only_if(format!(
                "content_hash = X'{literal}' AND deleted_at IS NULL"
            ))
            .limit(1)
            .execute()
            .await
            .context("query active document hash")?
            .try_collect::<Vec<_>>()
            .await
            .context("read active document hash")?;
        Ok(batches.iter().any(|batch| batch.num_rows() > 0))
    }

    pub async fn document_types(&self) -> Result<Vec<String>> {
        let mut types = self
            .list_active()
            .await?
            .into_iter()
            .filter_map(|document| document.document_type)
            .collect::<Vec<_>>();
        types.sort_unstable_by_key(|value| value.to_lowercase());
        types.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        Ok(types)
    }
}

async fn open_or_create_documents(connection: &Connection) -> Result<Table> {
    let names = connection
        .table_names()
        .execute()
        .await
        .context("list LanceDB tables")?;
    if names.iter().any(|name| name == DOCUMENTS_TABLE) {
        connection
            .open_table(DOCUMENTS_TABLE)
            .execute()
            .await
            .context("open documents table")
    } else {
        connection
            .create_empty_table(DOCUMENTS_TABLE, document_schema())
            .execute()
            .await
            .context("create documents table")
    }
}

async fn maximum_document_id(table: &Table) -> Result<u64> {
    let batches = table
        .query()
        .execute()
        .await
        .context("query document ids")?
        .try_collect::<Vec<_>>()
        .await
        .context("read document ids")?;
    let documents = documents_from_batches(&batches)?;
    Ok(documents
        .into_iter()
        .map(|document| document.document_id)
        .max()
        .unwrap_or(0))
}

pub fn document_schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("document_id", DataType::UInt64, false),
        Field::new("content_hash", DataType::FixedSizeBinary(32), false),
        Field::new("media_type", DataType::Utf8, false),
        Field::new("filename", DataType::Utf8, false),
        Field::new("title", DataType::Utf8, true),
        Field::new("document_type", DataType::Utf8, true),
        timestamp_field("created_at", true),
        timestamp_field("added_at", false),
        timestamp_field("updated_at", false),
        Field::new("title_source", DataType::Utf8, true),
        Field::new("type_source", DataType::Utf8, true),
        Field::new("created_at_source", DataType::Utf8, true),
        Field::new("page_count", DataType::UInt32, false),
        Field::new("file_size", DataType::UInt64, false),
        Field::new("status", DataType::Utf8, false),
        Field::new("last_error", DataType::Utf8, true),
        Field::new("retry_count", DataType::UInt32, false),
        timestamp_field("deleted_at", true),
    ]))
}

fn timestamp_field(name: &str, nullable: bool) -> Field {
    Field::new(
        name,
        DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
        nullable,
    )
}

fn document_batch(document: &Document) -> Result<RecordBatch> {
    let schema = document_schema();
    let content_hash =
        FixedSizeBinaryArray::try_from_iter(std::iter::once(document.content_hash.as_slice()))?;
    let columns: Vec<ArrayRef> = vec![
        Arc::new(UInt64Array::from(vec![document.document_id])),
        Arc::new(content_hash),
        Arc::new(StringArray::from(vec![document.media_type.as_str()])),
        Arc::new(StringArray::from(vec![document.filename.as_str()])),
        Arc::new(StringArray::from(vec![document.title.as_deref()])),
        Arc::new(StringArray::from(vec![document.document_type.as_deref()])),
        Arc::new(timestamp_array(document.created_at)),
        Arc::new(timestamp_array(Some(document.added_at))),
        Arc::new(timestamp_array(Some(document.updated_at))),
        Arc::new(StringArray::from(vec![
            document.title_source.map(MetadataSource::as_str),
        ])),
        Arc::new(StringArray::from(vec![
            document.type_source.map(MetadataSource::as_str),
        ])),
        Arc::new(StringArray::from(vec![
            document.created_at_source.map(MetadataSource::as_str),
        ])),
        Arc::new(UInt32Array::from(vec![document.page_count])),
        Arc::new(UInt64Array::from(vec![document.file_size])),
        Arc::new(StringArray::from(vec![document.status.as_str()])),
        Arc::new(StringArray::from(vec![document.last_error.as_deref()])),
        Arc::new(UInt32Array::from(vec![document.retry_count])),
        Arc::new(timestamp_array(document.deleted_at)),
    ];
    RecordBatch::try_new(schema, columns).context("build document record batch")
}

fn timestamp_array(value: Option<DateTime<Utc>>) -> TimestampMicrosecondArray {
    TimestampMicrosecondArray::from(vec![value.map(|timestamp| timestamp.timestamp_micros())])
        .with_timezone("UTC")
}

fn documents_from_batches(batches: &[RecordBatch]) -> Result<Vec<Document>> {
    let mut documents = Vec::new();
    for batch in batches {
        for row in 0..batch.num_rows() {
            documents.push(document_from_batch(batch, row)?);
        }
    }
    Ok(documents)
}

fn document_from_batch(batch: &RecordBatch, row: usize) -> Result<Document> {
    let hash = binary_column(batch, "content_hash")?.value(row);
    let content_hash: [u8; 32] = hash
        .try_into()
        .map_err(|_| anyhow::anyhow!("stored content hash has {} bytes", hash.len()))?;
    Ok(Document {
        document_id: u64_column(batch, "document_id")?.value(row),
        content_hash,
        media_type: MediaType::from_str(string_column(batch, "media_type")?.value(row))
            .map_err(anyhow::Error::msg)?,
        filename: string_column(batch, "filename")?.value(row).to_owned(),
        title: optional_string(batch, "title", row)?,
        document_type: optional_string(batch, "document_type", row)?,
        created_at: optional_timestamp(batch, "created_at", row)?,
        added_at: required_timestamp(batch, "added_at", row)?,
        updated_at: required_timestamp(batch, "updated_at", row)?,
        title_source: optional_enum(batch, "title_source", row)?,
        type_source: optional_enum(batch, "type_source", row)?,
        created_at_source: optional_enum(batch, "created_at_source", row)?,
        page_count: u32_column(batch, "page_count")?.value(row),
        file_size: u64_column(batch, "file_size")?.value(row),
        status: IngestionStatus::from_str(string_column(batch, "status")?.value(row))
            .map_err(anyhow::Error::msg)?,
        last_error: optional_string(batch, "last_error", row)?,
        retry_count: u32_column(batch, "retry_count")?.value(row),
        deleted_at: optional_timestamp(batch, "deleted_at", row)?,
    })
}

fn column<'a, T: Array + 'static>(batch: &'a RecordBatch, name: &str) -> Result<&'a T> {
    batch
        .column_by_name(name)
        .with_context(|| format!("document batch has no {name} column"))?
        .as_any()
        .downcast_ref::<T>()
        .with_context(|| format!("document column {name} has the wrong Arrow type"))
}

fn u64_column<'a>(batch: &'a RecordBatch, name: &str) -> Result<&'a UInt64Array> {
    column(batch, name)
}

fn u32_column<'a>(batch: &'a RecordBatch, name: &str) -> Result<&'a UInt32Array> {
    column(batch, name)
}

fn string_column<'a>(batch: &'a RecordBatch, name: &str) -> Result<&'a StringArray> {
    column(batch, name)
}

fn binary_column<'a>(batch: &'a RecordBatch, name: &str) -> Result<&'a FixedSizeBinaryArray> {
    column(batch, name)
}

fn optional_string(batch: &RecordBatch, name: &str, row: usize) -> Result<Option<String>> {
    let values = string_column(batch, name)?;
    Ok((!values.is_null(row)).then(|| values.value(row).to_owned()))
}

fn optional_enum<T>(batch: &RecordBatch, name: &str, row: usize) -> Result<Option<T>>
where
    T: FromStr<Err = String>,
{
    optional_string(batch, name, row)?
        .map(|value| T::from_str(&value).map_err(anyhow::Error::msg))
        .transpose()
}

fn optional_timestamp(
    batch: &RecordBatch,
    name: &str,
    row: usize,
) -> Result<Option<DateTime<Utc>>> {
    let values: &TimestampMicrosecondArray = column(batch, name)?;
    if values.is_null(row) {
        return Ok(None);
    }
    DateTime::from_timestamp_micros(values.value(row))
        .with_context(|| format!("document column {name} has an invalid timestamp"))
        .map(Some)
}

fn required_timestamp(batch: &RecordBatch, name: &str, row: usize) -> Result<DateTime<Utc>> {
    optional_timestamp(batch, name, row)?.with_context(|| format!("document column {name} is null"))
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn sql_optional_string(value: Option<&str>) -> String {
    value.map_or_else(|| "NULL".into(), sql_string)
}

fn sql_optional_source(value: Option<MetadataSource>) -> String {
    value.map_or_else(|| "NULL".into(), |source| sql_string(source.as_str()))
}

fn sql_optional_timestamp(value: Option<DateTime<Utc>>) -> String {
    value.map_or_else(
        || "NULL".into(),
        |date| {
            format!(
                "arrow_cast({}, 'Timestamp(Microsecond, Some(\"UTC\"))')",
                date.timestamp_micros()
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use paperless_models::{Document, IngestionStatus, MediaType, UploadMetadata};

    use super::DocumentRepository;
    use crate::layout::DataLayout;

    fn document(id: u64, hash_byte: u8) -> Document {
        let added_at = Utc.with_ymd_and_hms(2026, 8, 1, 12, 0, 0).unwrap();
        Document {
            document_id: id,
            content_hash: [hash_byte; 32],
            media_type: MediaType::Pdf,
            filename: format!("document-{id}.pdf"),
            title: None,
            document_type: None,
            created_at: None,
            added_at,
            updated_at: added_at,
            title_source: None,
            type_source: None,
            created_at_source: None,
            page_count: 0,
            file_size: 12,
            status: IngestionStatus::Stored,
            last_error: None,
            retry_count: 0,
            deleted_at: None,
        }
    }

    #[tokio::test]
    async fn persists_reads_and_orders_documents() {
        let temporary = tempfile::tempdir().unwrap();
        let layout = DataLayout::create(temporary.path()).await.unwrap();
        let repository = DocumentRepository::open(&layout).await.unwrap();
        let mut older_document_date = document(repository.allocate_id(), 1);
        older_document_date.created_at = Utc.with_ymd_and_hms(2020, 1, 1, 0, 0, 0).single();
        let mut newer_added_date = document(repository.allocate_id(), 2);
        newer_added_date.added_at = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        repository.insert(&older_document_date).await.unwrap();
        repository.insert(&newer_added_date).await.unwrap();

        let reopened = DocumentRepository::open(&layout).await.unwrap();
        assert_eq!(
            reopened.get(older_document_date.document_id).await.unwrap(),
            Some(older_document_date)
        );
        assert_eq!(
            reopened.find_by_hash(&[2; 32]).await.unwrap(),
            Some(newer_added_date.clone())
        );
        let listed = reopened.list_active().await.unwrap();
        assert_eq!(listed[0].document_id, newer_added_date.document_id);
        assert!(reopened.allocate_id() > newer_added_date.document_id);
    }

    #[tokio::test]
    async fn duplicate_metadata_only_fills_empty_fields() {
        let temporary = tempfile::tempdir().unwrap();
        let layout = DataLayout::create(temporary.path()).await.unwrap();
        let repository = DocumentRepository::open(&layout).await.unwrap();
        let mut existing = document(repository.allocate_id(), 3);
        existing.title = Some("Manual title".into());
        repository.insert(&existing).await.unwrap();
        let metadata = UploadMetadata {
            filename: "duplicate.pdf".into(),
            title: Some("Replacement title".into()),
            document_type: Some("Invoice".into()),
            created_at: None,
        };

        let merged = repository
            .merge_missing_upload_metadata(&existing, &metadata)
            .await
            .unwrap();
        assert_eq!(merged.title.as_deref(), Some("Manual title"));
        assert_eq!(merged.document_type.as_deref(), Some("Invoice"));
    }
}
