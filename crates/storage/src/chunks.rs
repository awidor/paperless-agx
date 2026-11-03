use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use paperless_models::{Chunk, summary_chunk_id};
use rusqlite::{OptionalExtension, params, types::Value};

use crate::{DataLayout, database::Database};

pub use paperless_models::EMBEDDING_DIMENSION;
const EMBEDDING_BYTES: usize = EMBEDDING_DIMENSION * std::mem::size_of::<f32>();
const VECTOR_SPACE_SETTING: &str = "embedding_vector_space";

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

/// A stored chunk whose embedding has not been computed for the current model yet.
#[derive(Debug, Clone)]
pub struct PendingEmbedding {
    pub chunk_id: u64,
    pub title: Option<String>,
    pub text: String,
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

    /// Replaces a document's summary passage. The new passage has no embedding yet;
    /// `pending_embeddings` hands it to the embedding model.
    pub async fn replace_summary(
        &self,
        document_id: u64,
        summary: Option<String>,
        sender: Option<String>,
        created_at: Option<DateTime<Utc>>,
    ) -> Result<()> {
        let chunk_id = i64_value(summary_chunk_id(document_id), "chunk id")?;
        let document_id = i64_value(document_id, "document id")?;
        self.database
            .run(move |connection| {
                let transaction = connection
                    .transaction()
                    .context("start summary transaction")?;
                transaction
                    .execute("DELETE FROM chunks WHERE chunk_id = ?", [chunk_id])
                    .context("remove prior summary passage")?;
                if let Some(summary) = summary {
                    transaction
                        .execute(
                            "INSERT INTO chunks (
                                chunk_id, document_id, page_start, page_end, char_start,
                                char_end, text, embedding, created_at, sender
                             ) VALUES (?, ?, 1, 1, 0, 0, ?, NULL, ?, ?)",
                            params![
                                chunk_id,
                                document_id,
                                summary,
                                created_at.map(timestamp),
                                sender
                            ],
                        )
                        .context("store summary passage")?;
                }
                transaction.commit().context("commit summary transaction")?;
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

    /// Clears every stored vector when the configured embedding model or size changed, so
    /// the chunks are re-embedded in the new vector space. Returns the number cleared.
    pub async fn reset_vector_space(&self, vector_space: &str) -> Result<usize> {
        let vector_space = vector_space.to_owned();
        self.database
            .run(move |connection| {
                let transaction = connection
                    .transaction()
                    .context("start vector space transaction")?;
                let stored: Option<String> = transaction
                    .query_row(
                        "SELECT value FROM settings WHERE key = ?",
                        [VECTOR_SPACE_SETTING],
                        |row| row.get(0),
                    )
                    .optional()
                    .context("read stored vector space")?;
                if stored.as_deref() == Some(vector_space.as_str()) {
                    return Ok(0);
                }
                let cleared = transaction
                    .execute(
                        "UPDATE chunks SET embedding = NULL WHERE embedding IS NOT NULL",
                        [],
                    )
                    .context("clear embeddings from a previous model")?;
                transaction
                    .execute(
                        "INSERT INTO settings (key, value) VALUES (?, ?)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        params![VECTOR_SPACE_SETTING, vector_space],
                    )
                    .context("store vector space")?;
                transaction
                    .commit()
                    .context("commit vector space transaction")?;
                Ok(cleared)
            })
            .await
    }

    /// Lists chunks without an embedding, in chunk order, starting after `after_chunk_id`.
    pub async fn pending_embeddings(
        &self,
        after_chunk_id: u64,
        limit: usize,
    ) -> Result<Vec<PendingEmbedding>> {
        let after_chunk_id = i64_value(after_chunk_id, "chunk id")?;
        let limit = i64::try_from(limit).context("pending embedding limit is too large")?;
        self.database
            .run(move |connection| {
                let mut statement = connection
                    .prepare(
                        "SELECT chunks.chunk_id, d.title, chunks.text FROM chunks
                         JOIN documents d ON d.document_id = chunks.document_id
                         WHERE chunks.embedding IS NULL AND d.deleted_at IS NULL
                             AND chunks.chunk_id > ?
                         ORDER BY chunks.chunk_id
                         LIMIT ?",
                    )
                    .context("query pending embeddings")?;
                let rows = statement
                    .query_map(params![after_chunk_id, limit], |row| {
                        Ok(PendingEmbedding {
                            chunk_id: from_i64(row.get(0)?, "chunk_id")?,
                            title: row.get(1)?,
                            text: row.get(2)?,
                        })
                    })
                    .context("read pending embeddings")?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
                    .context("decode pending embeddings")
            })
            .await
    }

    /// Stores embeddings for pending chunks. A chunk whose text changed since it was listed
    /// is skipped, because its vector would describe the old text.
    pub async fn store_embeddings(
        &self,
        embedded: Vec<(PendingEmbedding, Vec<f32>)>,
    ) -> Result<()> {
        let mut rows = Vec::with_capacity(embedded.len());
        for (pending, embedding) in embedded {
            rows.push((
                i64_value(pending.chunk_id, "chunk id")?,
                pending.text,
                embedding_bytes(&embedding)?,
            ));
        }
        self.database
            .run(move |connection| {
                let transaction = connection
                    .transaction()
                    .context("start embedding transaction")?;
                for (chunk_id, text, embedding) in rows {
                    transaction
                        .execute(
                            "UPDATE chunks SET embedding = ?
                             WHERE chunk_id = ? AND text = ? AND embedding IS NULL",
                            params![embedding, chunk_id, text],
                        )
                        .context("store chunk embedding")?;
                }
                transaction
                    .commit()
                    .context("commit embedding transaction")?;
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
                     WHERE d.deleted_at IS NULL AND chunks.embedding IS NOT NULL{where_sql}"
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

/// Each whitespace-separated term must occur somewhere in the passage, also inside a longer
/// word. The trigram index cannot match terms shorter than three characters, so those are
/// left to the vector search instead of making every keyword match fail.
fn fts_query(query: &str) -> Result<String> {
    let terms = query
        .split_whitespace()
        .filter(|term| term.chars().count() >= 3)
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

/// Chunks that are not embedded yet (`NULL`) load with an empty embedding.
fn embedding_from_bytes(bytes: Option<Vec<u8>>) -> rusqlite::Result<Vec<f32>> {
    let Some(bytes) = bytes else {
        return Ok(Vec::new());
    };
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
            summary: None,
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

    #[tokio::test]
    async fn migrates_fixed_size_harrier_chunks_and_re_embeds_them() {
        let temporary = tempfile::tempdir().unwrap();
        let layout = DataLayout::create(temporary.path()).await.unwrap();
        let legacy = rusqlite::Connection::open(&layout.database).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE documents (
                     document_id INTEGER PRIMARY KEY,
                     content_hash BLOB NOT NULL CHECK(length(content_hash) = 32),
                     media_type TEXT NOT NULL, filename TEXT NOT NULL, title TEXT, sender TEXT,
                     created_at INTEGER, added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                     title_source TEXT, sender_source TEXT, created_at_source TEXT,
                     page_count INTEGER NOT NULL, file_size INTEGER NOT NULL,
                     status TEXT NOT NULL, last_error TEXT, retry_count INTEGER NOT NULL,
                     deleted_at INTEGER
                 );
                 INSERT INTO documents VALUES (1, zeroblob(32), 'pdf', 'brief.pdf', 'Beitragsbescheid',
                     NULL, NULL, 0, 0, NULL, NULL, NULL, 1, 1, 'READY', NULL, 0, NULL);
                 CREATE TABLE chunks (
                     chunk_id INTEGER PRIMARY KEY,
                     document_id INTEGER NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
                     page_start INTEGER NOT NULL, page_end INTEGER NOT NULL,
                     char_start INTEGER NOT NULL, char_end INTEGER NOT NULL, text TEXT NOT NULL,
                     embedding BLOB NOT NULL CHECK(length(embedding) = 4096),
                     created_at INTEGER, sender TEXT
                 );
                 CREATE VIRTUAL TABLE chunks_fts USING fts5(
                     text, content='chunks', content_rowid='chunk_id', tokenize='unicode61'
                 );
                 CREATE TRIGGER chunks_insert AFTER INSERT ON chunks BEGIN
                     INSERT INTO chunks_fts(rowid, text) VALUES (new.chunk_id, new.text);
                 END;
                 INSERT INTO chunks VALUES (7, 1, 1, 1, 0, 21, 'Beitrag zur Krankenkasse',
                     zeroblob(4096), NULL, NULL);",
            )
            .unwrap();
        drop(legacy);

        let repository = ChunkRepository::open(&layout).await.unwrap();
        let pending = repository.pending_embeddings(0, 10).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].chunk_id, 7);
        assert_eq!(pending[0].title.as_deref(), Some("Beitragsbescheid"));
        let lexical = repository
            .lexical_candidates("Krankenkasse", SearchFilter::default(), 10)
            .await
            .unwrap();
        assert_eq!(lexical[0].chunk.chunk_id, 7);
        // The rebuilt trigram index finds a word inside a compound, and ignores terms too
        // short to index instead of failing the whole match.
        let inside_compound = repository
            .lexical_candidates("kasse zu", SearchFilter::default(), 10)
            .await
            .unwrap();
        assert_eq!(inside_compound[0].chunk.chunk_id, 7);
        assert!(
            repository
                .vector_candidates(&vec![1.0; EMBEDDING_DIMENSION], SearchFilter::default(), 1)
                .await
                .unwrap()
                .is_empty()
        );

        assert_eq!(
            repository
                .reset_vector_space("gemini-embedding-2:3072")
                .await
                .unwrap(),
            0
        );
        let mut embedding = vec![0.0; EMBEDDING_DIMENSION];
        embedding[0] = 1.0;
        repository
            .store_embeddings(vec![(pending[0].clone(), embedding)])
            .await
            .unwrap();
        assert!(
            repository
                .pending_embeddings(0, 10)
                .await
                .unwrap()
                .is_empty()
        );
        let vector = repository
            .vector_candidates(&vec![1.0; EMBEDDING_DIMENSION], SearchFilter::default(), 1)
            .await
            .unwrap();
        assert_eq!(vector[0].chunk.chunk_id, 7);

        // A later model change clears the stored vectors again.
        assert_eq!(
            repository
                .reset_vector_space("another-model:3072")
                .await
                .unwrap(),
            1
        );
        assert_eq!(repository.pending_embeddings(0, 10).await.unwrap().len(), 1);
    }
}
