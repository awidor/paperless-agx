use std::{path::Path, sync::Arc};

use anyhow::{Context, Result, bail};
use arrow_array::{
    Array, ArrayRef, FixedSizeListArray, Float32Array, RecordBatch, RecordBatchIterator,
    RecordBatchReader, StringArray, TimestampMicrosecondArray, UInt32Array, UInt64Array,
    types::Float32Type,
};
use arrow_schema::{DataType, Field, Schema, SchemaRef, TimeUnit};
use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use lance_index::scalar::FullTextSearchQuery;
use lancedb::{
    Connection, Table,
    database::CreateTableMode,
    index::{Index, scalar::FtsIndexBuilder},
    query::{ExecutableQuery, QueryBase},
    table::NewColumnTransform,
};
use paperless_models::Chunk;

use crate::SPIKE_DIMENSION;

const CHUNKS_TABLE: &str = "chunks";

#[derive(Debug, Clone)]
pub struct ChunkMatch {
    pub chunk: Chunk,
    pub rank: usize,
    pub score: f32,
}

#[derive(Clone)]
pub struct ChunkRepository {
    table: Table,
}

impl ChunkRepository {
    pub async fn open(lance_directory: impl AsRef<Path>) -> Result<Self> {
        let connection = lancedb::connect(lance_directory.as_ref().to_string_lossy().as_ref())
            .execute()
            .await
            .context("connect to LanceDB for chunks")?;
        let table = open_or_create_chunks(&connection).await?;
        Ok(Self { table })
    }

    pub async fn replace_document(&self, document_id: u64, chunks: Vec<Chunk>) -> Result<()> {
        validate_chunks(document_id, &chunks)?;
        let predicate = format!("document_id = {document_id}");
        self.table
            .delete(&predicate)
            .await
            .context("remove prior document chunks")?;
        if chunks.is_empty() {
            return Ok(());
        }
        let batch = chunk_batch(&chunks)?;
        let schema = batch.schema();
        let reader: Box<dyn RecordBatchReader + Send> =
            Box::new(RecordBatchIterator::new(vec![Ok(batch)], schema));
        self.table
            .add(reader)
            .execute()
            .await
            .context("store document chunks")?;
        self.table
            .create_index(&["text"], Index::FTS(FtsIndexBuilder::default()))
            .replace(true)
            .execute()
            .await
            .context("build chunks full-text index")?;
        Ok(())
    }

    pub async fn list_document(&self, document_id: u64) -> Result<Vec<Chunk>> {
        let batches = self
            .table
            .query()
            .only_if(format!("document_id = {document_id}"))
            .execute()
            .await
            .context("query document chunks")?
            .try_collect::<Vec<_>>()
            .await
            .context("read document chunks")?;
        let mut chunks = chunks_from_batches(&batches)?;
        chunks.sort_by_key(|chunk| chunk.chunk_id);
        Ok(chunks)
    }

    pub async fn get(&self, chunk_id: u64) -> Result<Option<Chunk>> {
        let batches = self
            .table
            .query()
            .only_if(format!("chunk_id = {chunk_id}"))
            .limit(1)
            .execute()
            .await
            .context("query chunk")?
            .try_collect::<Vec<_>>()
            .await
            .context("read chunk")?;
        Ok(chunks_from_batches(&batches)?.pop())
    }

    pub async fn delete_document(&self, document_id: u64) -> Result<()> {
        let predicate = format!("document_id = {document_id}");
        self.table
            .delete(&predicate)
            .await
            .context("delete document chunks")?;
        Ok(())
    }

    pub async fn update_filters(
        &self,
        document_id: u64,
        sender: Option<&str>,
        created_at: Option<DateTime<Utc>>,
    ) -> Result<()> {
        let mut update = self
            .table
            .update()
            .only_if(format!("document_id = {document_id}"))
            .column("sender", sender.map_or_else(|| "NULL".into(), sql_string));
        update = update.column(
            "created_at",
            created_at.map_or_else(
                || "NULL".into(),
                |date| format!("to_timestamp_micros({})", date.timestamp_micros()),
            ),
        );
        update.execute().await.context("update chunk filters")?;
        Ok(())
    }

    pub async fn vector_candidates(
        &self,
        embedding: &[f32],
        filter: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ChunkMatch>> {
        let mut query = self
            .table
            .query()
            .nearest_to(embedding)
            .context("build chunk vector query")?
            .limit(limit);
        if let Some(filter) = filter {
            query = query.only_if(filter);
        }
        let batches = query
            .execute()
            .await
            .context("run chunk vector query")?
            .try_collect::<Vec<_>>()
            .await
            .context("read chunk vector results")?;
        matches_from_batches(&batches, "_distance", true)
    }

    pub async fn lexical_candidates(
        &self,
        query_text: &str,
        filter: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ChunkMatch>> {
        let full_text = FullTextSearchQuery::new(query_text.to_owned())
            .with_column("text".to_owned())
            .context("build chunks BM25 query")?;
        let mut query = self.table.query().full_text_search(full_text).limit(limit);
        if let Some(filter) = filter {
            query = query.only_if(filter);
        }
        let batches = query
            .execute()
            .await
            .context("run chunks BM25 query")?
            .try_collect::<Vec<_>>()
            .await
            .context("read chunks BM25 results")?;
        matches_from_batches(&batches, "_score", false)
    }
}

pub fn chunk_schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("chunk_id", DataType::UInt64, false),
        Field::new("document_id", DataType::UInt64, false),
        Field::new("page_start", DataType::UInt32, false),
        Field::new("page_end", DataType::UInt32, false),
        Field::new("char_start", DataType::UInt32, false),
        Field::new("char_end", DataType::UInt32, false),
        Field::new("text", DataType::Utf8, false),
        Field::new(
            "embedding",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                SPIKE_DIMENSION,
            ),
            false,
        ),
        Field::new(
            "created_at",
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
            true,
        ),
        Field::new("sender", DataType::Utf8, true),
    ]))
}

async fn open_or_create_chunks(connection: &Connection) -> Result<Table> {
    if connection
        .table_names()
        .execute()
        .await
        .context("list LanceDB tables")?
        .iter()
        .any(|name| name == CHUNKS_TABLE)
    {
        let table = connection
            .open_table(CHUNKS_TABLE)
            .execute()
            .await
            .context("open chunks table")?;
        if table.schema().await?.field_with_name("sender").is_err() {
            table
                .add_columns()
                .transform(NewColumnTransform::AllNulls(Arc::new(Schema::new(vec![
                    Field::new("sender", DataType::Utf8, true),
                ]))))
                .execute()
                .await
                .context("add chunk sender column")?;
        }
        if table
            .schema()
            .await?
            .field_with_name("document_type")
            .is_ok()
        {
            table
                .drop_columns(&["document_type"])
                .await
                .context("drop chunk document_type column")?;
        }
        return Ok(table);
    }
    connection
        .create_empty_table(CHUNKS_TABLE, chunk_schema())
        .mode(CreateTableMode::Create)
        .execute()
        .await
        .context("create chunks table")
}

fn validate_chunks(document_id: u64, chunks: &[Chunk]) -> Result<()> {
    for (index, chunk) in chunks.iter().enumerate() {
        if chunk.document_id != document_id {
            bail!("chunk belongs to a different document");
        }
        if chunk.embedding.len() != SPIKE_DIMENSION as usize {
            bail!(
                "chunk {} has {} embedding dimensions, expected {SPIKE_DIMENSION}",
                chunk.chunk_id,
                chunk.embedding.len()
            );
        }
        let expected = (document_id << 32) | index as u64 + 1;
        if chunk.chunk_id != expected {
            bail!("document chunks must use deterministic contiguous ids");
        }
    }
    Ok(())
}

fn chunk_batch(chunks: &[Chunk]) -> Result<RecordBatch> {
    let schema = chunk_schema();
    let embeddings = FixedSizeListArray::from_iter_primitive::<Float32Type, _, _>(
        chunks.iter().map(|chunk| {
            Some(
                chunk
                    .embedding
                    .iter()
                    .copied()
                    .map(Some)
                    .collect::<Vec<_>>(),
            )
        }),
        SPIKE_DIMENSION,
    );
    Ok(RecordBatch::try_new(
        schema,
        vec![
            Arc::new(UInt64Array::from_iter_values(
                chunks.iter().map(|chunk| chunk.chunk_id),
            )) as ArrayRef,
            Arc::new(UInt64Array::from_iter_values(
                chunks.iter().map(|chunk| chunk.document_id),
            )),
            Arc::new(UInt32Array::from_iter_values(
                chunks.iter().map(|chunk| chunk.page_start),
            )),
            Arc::new(UInt32Array::from_iter_values(
                chunks.iter().map(|chunk| chunk.page_end),
            )),
            Arc::new(UInt32Array::from_iter_values(
                chunks.iter().map(|chunk| chunk.char_start),
            )),
            Arc::new(UInt32Array::from_iter_values(
                chunks.iter().map(|chunk| chunk.char_end),
            )),
            Arc::new(StringArray::from_iter_values(
                chunks.iter().map(|chunk| chunk.text.as_str()),
            )),
            Arc::new(embeddings),
            Arc::new(
                TimestampMicrosecondArray::from_iter(
                    chunks
                        .iter()
                        .map(|chunk| chunk.created_at.map(|date| date.timestamp_micros())),
                )
                .with_timezone("UTC"),
            ),
            Arc::new(StringArray::from(
                chunks
                    .iter()
                    .map(|chunk| chunk.sender.as_deref())
                    .collect::<Vec<_>>(),
            )),
        ],
    )?)
}

fn chunks_from_batches(batches: &[RecordBatch]) -> Result<Vec<Chunk>> {
    let mut chunks = Vec::new();
    for batch in batches {
        let ids = column::<UInt64Array>(batch, "chunk_id")?;
        let document_ids = column::<UInt64Array>(batch, "document_id")?;
        let page_starts = column::<UInt32Array>(batch, "page_start")?;
        let page_ends = column::<UInt32Array>(batch, "page_end")?;
        let char_starts = column::<UInt32Array>(batch, "char_start")?;
        let char_ends = column::<UInt32Array>(batch, "char_end")?;
        let texts = column::<StringArray>(batch, "text")?;
        let embeddings = column::<FixedSizeListArray>(batch, "embedding")?;
        let dates = column::<TimestampMicrosecondArray>(batch, "created_at")?;
        let senders = column::<StringArray>(batch, "sender")?;
        for row in 0..batch.num_rows() {
            let embedding = embeddings.value(row);
            let embedding = embedding
                .as_any()
                .downcast_ref::<Float32Array>()
                .context("embedding values have wrong Arrow type")?
                .values()
                .to_vec();
            chunks.push(Chunk {
                chunk_id: ids.value(row),
                document_id: document_ids.value(row),
                page_start: page_starts.value(row),
                page_end: page_ends.value(row),
                char_start: char_starts.value(row),
                char_end: char_ends.value(row),
                text: texts.value(row).to_owned(),
                embedding,
                created_at: (!dates.is_null(row))
                    .then(|| DateTime::from_timestamp_micros(dates.value(row)))
                    .flatten(),
                sender: (!senders.is_null(row)).then(|| senders.value(row).to_owned()),
            });
        }
    }
    Ok(chunks)
}

fn matches_from_batches(
    batches: &[RecordBatch],
    score_column: &str,
    distance: bool,
) -> Result<Vec<ChunkMatch>> {
    let mut matches = Vec::new();
    let mut rank = 1;
    for batch in batches {
        let chunks = chunks_from_batches(std::slice::from_ref(batch))?;
        let scores = column::<Float32Array>(batch, score_column)?;
        for (row, chunk) in chunks.into_iter().enumerate() {
            matches.push(ChunkMatch {
                chunk,
                rank,
                score: if distance {
                    1.0 / (1.0 + scores.value(row))
                } else {
                    scores.value(row)
                },
            });
            rank += 1;
        }
    }
    Ok(matches)
}

fn column<'a, T: Array + 'static>(batch: &'a RecordBatch, name: &str) -> Result<&'a T> {
    batch
        .column_by_name(name)
        .with_context(|| format!("missing {name} column"))?
        .as_any()
        .downcast_ref::<T>()
        .with_context(|| format!("{name} column has wrong Arrow type"))
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use paperless_models::Chunk;

    use super::ChunkRepository;

    fn chunk(document_id: u64, ordinal: u64, text: &str, sender: &str) -> Chunk {
        let mut embedding = vec![0.0; 1024];
        embedding[(document_id - 1) as usize] = 1.0;
        Chunk {
            chunk_id: (document_id << 32) | ordinal,
            document_id,
            page_start: ordinal as u32,
            page_end: ordinal as u32,
            char_start: 0,
            char_end: text.len() as u32,
            text: text.into(),
            embedding,
            created_at: Some(
                Utc.with_ymd_and_hms(2025, 1, document_id as u32, 0, 0, 0)
                    .unwrap(),
            ),
            sender: Some(sender.into()),
        }
    }

    #[tokio::test]
    async fn replacement_and_filtered_retrieval_use_production_schema() {
        let temporary = tempfile::tempdir().unwrap();
        let repository = ChunkRepository::open(temporary.path()).await.unwrap();
        repository
            .replace_document(1, vec![chunk(1, 1, "annual summit invoice", "Acme Corp")])
            .await
            .unwrap();
        repository
            .replace_document(2, vec![chunk(2, 1, "summit meeting notes", "Beta Ltd")])
            .await
            .unwrap();
        repository
            .replace_document(1, vec![chunk(1, 1, "revised summit invoice", "Acme Corp")])
            .await
            .unwrap();

        let stored = repository.list_document(1).await.unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].text, "revised summit invoice");
        let lexical = repository
            .lexical_candidates("summit", Some("sender = 'Acme Corp'"), 10)
            .await
            .unwrap();
        assert_eq!(lexical.len(), 1);
        assert_eq!(lexical[0].chunk.document_id, 1);
        let vector = repository
            .vector_candidates(&stored[0].embedding, None, 1)
            .await
            .unwrap();
        assert_eq!(vector[0].chunk.document_id, 1);
    }
}
