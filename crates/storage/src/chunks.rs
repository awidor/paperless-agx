use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use paperless_models::Chunk;
use rusqlite::{OptionalExtension, params, types::Value};

use crate::{DataLayout, database::Database};

pub const EMBEDDING_DIMENSION: usize = 1024;
const EMBEDDING_BYTES: usize = EMBEDDING_DIMENSION * std::mem::size_of::<f32>();

#[derive(Debug, Clone, Default)]
pub struct SearchFilter {
    pub sender: Option<String>,
    pub created_from: Option<DateTime<Utc>>,
    pub created_to: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct ChunkMatch {
    pub chunk: Chunk,
    pub rank: usize,
    pub score: f32,
}

#[derive(Clone)]
pub struct ChunkRepository {
    database: Database,
}

impl ChunkRepository {
    pub async fn open(layout: &DataLayout) -> Result<Self> {
        Ok(Self {
            database: Database::open(layout).await?,
        })
    }

    pub async fn replace_document(&self, document_id: u64, chunks: Vec<Chunk>) -> Result<()> {
        validate_chunks(document_id, &chunks)?;
        let document_id = i64_value(document_id, "document id")?;
        self.database
            .run(move |connection| {
                let transaction = connection
                    .transaction()
                    .context("start chunk transaction")?;
                transaction
                    .execute("DELETE FROM chunks WHERE document_id = ?", [document_id])
                    .context("remove prior document chunks")?;
                for chunk in chunks {
                    transaction
                        .execute(
                            "INSERT INTO chunks (
                                chunk_id, document_id, page_start, page_end, char_start,
                                char_end, text, embedding, created_at, sender
                             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            params![
                                i64_value(chunk.chunk_id, "chunk id")?,
                                document_id,
                                i64_value(u64::from(chunk.page_start), "page start")?,
                                i64_value(u64::from(chunk.page_end), "page end")?,
                                i64_value(u64::from(chunk.char_start), "character start")?,
                                i64_value(u64::from(chunk.char_end), "character end")?,
                                chunk.text,
                                embedding_bytes(&chunk.embedding)?,
                                chunk.created_at.map(timestamp),
                                chunk.sender,
                            ],
                        )
                        .context("store document chunk")?;
                }
                transaction.commit().context("commit chunk transaction")?;
                Ok(())
            })
            .await
    }

    pub async fn list_document(&self, document_id: u64) -> Result<Vec<Chunk>> {
        let document_id = i64_value(document_id, "document id")?;
        self.database
            .run(move |connection| {
                let mut statement = connection
                    .prepare(&format!("{CHUNK_SELECT_SQL} WHERE document_id = ?"))
                    .context("query document chunks")?;
                let rows = statement
                    .query_map([document_id], chunk_from_row)
                    .context("read document chunks")?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
                    .context("decode document chunks")
            })
            .await
    }

    pub async fn get(&self, chunk_id: u64) -> Result<Option<Chunk>> {
        let chunk_id = i64_value(chunk_id, "chunk id")?;
        self.database
            .run(move |connection| {
                connection
                    .query_row(
                        &format!("{CHUNK_SELECT_SQL} WHERE chunk_id = ?"),
                        [chunk_id],
                        chunk_from_row,
                    )
                    .optional()
                    .context("query chunk")
            })
            .await
    }

    pub async fn delete_document(&self, document_id: u64) -> Result<()> {
        let document_id = i64_value(document_id, "document id")?;
        self.database
            .run(move |connection| {
                connection
                    .execute("DELETE FROM chunks WHERE document_id = ?", [document_id])
                    .context("delete document chunks")?;
                Ok(())
            })
            .await
    }

    pub async fn update_filters(
        &self,
        document_id: u64,
        sender: Option<&str>,
        created_at: Option<DateTime<Utc>>,
    ) -> Result<()> {
        let document_id = i64_value(document_id, "document id")?;
        let sender = sender.map(str::to_owned);
        self.database
            .run(move |connection| {
                connection
                    .execute(
                        "UPDATE chunks SET sender = ?, created_at = ? WHERE document_id = ?",
                        params![sender, created_at.map(timestamp), document_id],
                    )
                    .context("update chunk filters")?;
                Ok(())
            })
            .await
    }

    pub async fn vector_candidates(
        &self,
        embedding: &[f32],
        filter: SearchFilter,
        limit: usize,
    ) -> Result<Vec<ChunkMatch>> {
        validate_embedding(embedding)?;
        if limit == 0 {
            return Ok(Vec::new());
        }
        let query_embedding = embedding.to_vec();
        self.database
            .run(move |connection| {
                let (where_sql, values) = filter_sql(&filter);
                let sql = format!(
                    "{CHUNK_SELECT_SQL}
                     JOIN documents d ON d.document_id = chunks.document_id
                     WHERE d.deleted_at IS NULL{where_sql}"
                );
                let mut statement = connection
                    .prepare(&sql)
                    .context("query vector candidates")?;
                let mut rows = statement.query(rusqlite::params_from_iter(values))?;
                let mut matches = Vec::new();
                while let Some(row) = rows.next().context("read vector candidates")? {
                    let chunk = chunk_from_row(row).map_err(anyhow::Error::from)?;
                    let score = dot_product(&query_embedding, &chunk.embedding)?;
                    matches.push(ChunkMatch {
                        chunk,
                        rank: 0,
                        score,
                    });
                }
                matches.sort_by(|left, right| {
                    right
                        .score
                        .total_cmp(&left.score)
                        .then(left.chunk.chunk_id.cmp(&right.chunk.chunk_id))
                });
                matches.truncate(limit);
                for (index, candidate) in matches.iter_mut().enumerate() {
                    candidate.rank = index + 1;
                }
                Ok(matches)
            })
            .await
    }

    pub async fn lexical_candidates(
        &self,
        query: &str,
        filter: SearchFilter,
        limit: usize,
    ) -> Result<Vec<ChunkMatch>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let fts_query = fts_query(query)?;
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }
        self.database
            .run(move |connection| {
                let (where_sql, mut values) = filter_sql(&filter);
                let sql = format!(
                    "SELECT chunks.chunk_id, chunks.document_id, chunks.page_start,
                            chunks.page_end, chunks.char_start, chunks.char_end, chunks.text,
                            chunks.embedding, chunks.created_at, chunks.sender,
                            bm25(chunks_fts) AS rank_score
                     FROM chunks_fts
                     JOIN chunks ON chunks.chunk_id = chunks_fts.rowid
                     JOIN documents d ON d.document_id = chunks.document_id
                     WHERE chunks_fts MATCH ? AND d.deleted_at IS NULL{where_sql}
                     ORDER BY rank_score ASC, chunks.chunk_id ASC
                     LIMIT ?"
                );
                values.insert(0, Value::Text(fts_query));
                values.push(Value::Integer(i64::try_from(limit).map_err(|_| {
                    anyhow::anyhow!("lexical result limit exceeds SQLite integer range")
                })?));
                let mut statement = connection
                    .prepare(&sql)
                    .context("query lexical candidates")?;
                let mut rows = statement
                    .query(rusqlite::params_from_iter(values))
                    .context("run lexical candidates")?;
                let mut matches = Vec::new();
                while let Some(row) = rows.next().context("read lexical candidates")? {
                    let raw_score: f64 = row.get(10).context("read lexical candidate score")?;
                    let chunk = chunk_from_row(row).map_err(anyhow::Error::from)?;
                    matches.push(ChunkMatch {
                        chunk,
                        rank: matches.len() + 1,
                        score: (-raw_score) as f32,
                    });
                }
                Ok(matches)
            })
            .await
    }
}

const CHUNK_SELECT_SQL: &str =
    "SELECT chunks.chunk_id, chunks.document_id, chunks.page_start, chunks.page_end,
            chunks.char_start, chunks.char_end, chunks.text, chunks.embedding,
            chunks.created_at, chunks.sender FROM chunks";

fn validate_chunks(document_id: u64, chunks: &[Chunk]) -> Result<()> {
    for chunk in chunks {
        if chunk.document_id != document_id {
            bail!("chunk belongs to a different document");
        }
        if chunk.page_start > chunk.page_end {
            bail!("chunk page range is inverted");
        }
        validate_embedding(&chunk.embedding)?;
    }
    Ok(())
}
fn filter_sql(filter: &SearchFilter) -> (String, Vec<Value>) {
    let mut where_sql = String::new();
    let mut values = Vec::new();
    if let Some(sender) = &filter.sender {
        where_sql.push_str(" AND chunks.sender = ?");
        values.push(Value::Text(sender.clone()));
    }
    if let Some(created_from) = filter.created_from {
        where_sql.push_str(" AND chunks.created_at >= ?");
        values.push(Value::Integer(timestamp(created_from)));
    }
    if let Some(created_to) = filter.created_to {
        where_sql.push_str(" AND chunks.created_at <= ?");
        values.push(Value::Integer(timestamp(created_to)));
    }
    (where_sql, values)
}

fn fts_query(query: &str) -> Result<String> {
    let terms = query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    Ok(terms.join(" "))
}

fn chunk_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Chunk> {
    Ok(Chunk {
        chunk_id: from_i64(row.get(0)?, "chunk_id")?,
        document_id: from_i64(row.get(1)?, "document_id")?,
        page_start: from_u32(row.get(2)?, "page_start")?,
        page_end: from_u32(row.get(3)?, "page_end")?,
        char_start: from_u32(row.get(4)?, "char_start")?,
        char_end: from_u32(row.get(5)?, "char_end")?,
        text: row.get(6)?,
        embedding: embedding_from_bytes(row.get(7)?)?,
        created_at: optional_timestamp(row.get(8)?, 8)?,
        sender: row.get(9)?,
    })
}

fn embedding_bytes(embedding: &[f32]) -> Result<Vec<u8>> {
    validate_embedding(embedding)?;
    Ok(embedding
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect())
}

fn embedding_from_bytes(bytes: Vec<u8>) -> rusqlite::Result<Vec<f32>> {
    if bytes.len() != EMBEDDING_BYTES {
        return Err(rusqlite::Error::FromSqlConversionFailure(
            7,
            rusqlite::types::Type::Blob,
            Box::new(std::io::Error::other(format!(
                "embedding has {} bytes, expected {EMBEDDING_BYTES}",
                bytes.len()
            ))),
        ));
    }
    let embedding = bytes
        .chunks_exact(4)
        .map(|bytes| f32::from_le_bytes(bytes.try_into().expect("four-byte chunk")))
        .collect::<Vec<_>>();
    if embedding.iter().any(|value| !value.is_finite()) {
        return Err(rusqlite::Error::FromSqlConversionFailure(
            7,
            rusqlite::types::Type::Blob,
            Box::new(std::io::Error::other(
                "embedding contains a non-finite value",
            )),
        ));
    }
    Ok(embedding)
}

fn validate_embedding(embedding: &[f32]) -> Result<()> {
    if embedding.len() != EMBEDDING_DIMENSION {
        bail!(
            "embedding has {} dimensions, expected {EMBEDDING_DIMENSION}",
            embedding.len()
        );
    }
    if embedding.iter().any(|value| !value.is_finite()) {
        bail!("embedding contains a non-finite value");
    }
    Ok(())
}

fn dot_product(left: &[f32], right: &[f32]) -> Result<f32> {
    validate_embedding(left)?;
    validate_embedding(right)?;
    Ok(left
        .iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum())
}

fn timestamp(value: DateTime<Utc>) -> i64 {
    value.timestamp_micros()
}

fn optional_timestamp(value: Option<i64>, index: usize) -> rusqlite::Result<Option<DateTime<Utc>>> {
    value
        .map(|value| {
            DateTime::from_timestamp_micros(value).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    index,
                    rusqlite::types::Type::Integer,
                    Box::new(std::io::Error::other("invalid timestamp")),
                )
            })
        })
        .transpose()
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

fn from_u32(value: i64, field: &str) -> rusqlite::Result<u32> {
    u32::try_from(value).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Integer,
            Box::new(std::io::Error::other(format!(
                "{field} is outside u32 range"
            ))),
        )
    })
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use paperless_models::{Chunk, Document, IngestionStatus, MediaType};

    use super::{ChunkRepository, EMBEDDING_DIMENSION, SearchFilter};
    use crate::{DataLayout, DocumentRepository};

    fn document() -> Document {
        let now = Utc::now();
        Document {
            document_id: 1,
            content_hash: [1; 32],
            media_type: MediaType::Pdf,
            filename: "test.pdf".into(),
            title: None,
            sender: Some("Acme".into()),
            created_at: Some(now),
            added_at: now,
            updated_at: now,
            title_source: None,
            sender_source: None,
            created_at_source: None,
            page_count: 1,
            file_size: 1,
            status: IngestionStatus::Ready,
            last_error: None,
            retry_count: 0,
            deleted_at: None,
        }
    }

    fn chunk(id: u64, text: &str, axis: usize) -> Chunk {
        let mut embedding = vec![0.0; EMBEDDING_DIMENSION];
        embedding[axis] = 1.0;
        Chunk {
            chunk_id: id,
            document_id: 1,
            page_start: 1,
            page_end: 1,
            char_start: 0,
            char_end: text.len() as u32,
            text: text.into(),
            embedding,
            created_at: document().created_at,
            sender: Some("Acme".into()),
        }
    }

    #[tokio::test]
    async fn stores_and_searches_chunks_with_fts_and_vectors() {
        let temporary = tempfile::tempdir().unwrap();
        let layout = DataLayout::create(temporary.path()).await.unwrap();
        let documents = DocumentRepository::open(&layout).await.unwrap();
        documents.insert(&document()).await.unwrap();
        let repository = ChunkRepository::open(&layout).await.unwrap();
        repository
            .replace_document(
                1,
                vec![
                    chunk(1, "invoice for mountain equipment", 0),
                    chunk(2, "payment is due in thirty days", 1),
                ],
            )
            .await
            .unwrap();
        let lexical = repository
            .lexical_candidates("invoice", SearchFilter::default(), 10)
            .await
            .unwrap();
        assert_eq!(lexical[0].chunk.chunk_id, 1);
        let vector = repository
            .vector_candidates(&vec![1.0; EMBEDDING_DIMENSION], SearchFilter::default(), 1)
            .await
            .unwrap();
        assert_eq!(vector[0].chunk.chunk_id, 1);
    }
}
