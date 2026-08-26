mod repository;

pub use repository::{ChunkMatch, ChunkRepository, chunk_schema};

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use anyhow::{Context, Result};
use arrow_array::{
    Array, ArrayRef, FixedSizeListArray, Float32Array, RecordBatch, RecordBatchIterator,
    RecordBatchReader, StringArray, TimestampMicrosecondArray, UInt64Array, types::Float32Type,
};
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use futures::TryStreamExt;
use lance_index::scalar::FullTextSearchQuery;
use lancedb::{
    Connection, Table,
    database::CreateTableMode,
    index::{Index, scalar::FtsIndexBuilder},
    query::{ExecutableQuery, QueryBase},
};
use serde::{Deserialize, Serialize};

pub const SPIKE_DIMENSION: i32 = 1024;

#[derive(Debug, Clone)]
pub struct SpikeChunk {
    pub chunk_id: u64,
    pub document_id: u64,
    pub text: String,
    pub document_type: String,
    pub created_at_micros: i64,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RankedChunk {
    pub chunk_id: u64,
    pub document_id: u64,
    pub rank: usize,
    pub score: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentHit {
    pub document_id: u64,
    pub best_chunk_id: u64,
    pub score: f32,
}

pub async fn create_spike_table(connection: &Connection, chunks: &[SpikeChunk]) -> Result<Table> {
    let schema = Arc::new(Schema::new(vec![
        Field::new("chunk_id", DataType::UInt64, false),
        Field::new("document_id", DataType::UInt64, false),
        Field::new("text", DataType::Utf8, false),
        Field::new("document_type", DataType::Utf8, false),
        Field::new(
            "created_at",
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
            false,
        ),
        Field::new(
            "embedding",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                SPIKE_DIMENSION,
            ),
            false,
        ),
    ]));
    for chunk in chunks {
        if chunk.embedding.len() != SPIKE_DIMENSION as usize {
            anyhow::bail!(
                "chunk {} has {} embedding dimensions, expected {SPIKE_DIMENSION}",
                chunk.chunk_id,
                chunk.embedding.len()
            );
        }
    }
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
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(UInt64Array::from_iter_values(
                chunks.iter().map(|chunk| chunk.chunk_id),
            )) as ArrayRef,
            Arc::new(UInt64Array::from_iter_values(
                chunks.iter().map(|chunk| chunk.document_id),
            )),
            Arc::new(StringArray::from_iter_values(
                chunks.iter().map(|chunk| chunk.text.as_str()),
            )),
            Arc::new(StringArray::from_iter_values(
                chunks.iter().map(|chunk| chunk.document_type.as_str()),
            )),
            Arc::new(
                TimestampMicrosecondArray::from_iter_values(
                    chunks.iter().map(|chunk| chunk.created_at_micros),
                )
                .with_timezone("UTC"),
            ),
            Arc::new(embeddings),
        ],
    )?;
    let reader: Box<dyn RecordBatchReader + Send> =
        Box::new(RecordBatchIterator::new(vec![Ok(batch)], schema));
    let table = connection
        .create_table("retrieval_spike", reader)
        .mode(CreateTableMode::Overwrite)
        .execute()
        .await
        .context("create LanceDB retrieval spike table")?;
    table
        .create_index(&["text"], Index::FTS(FtsIndexBuilder::default()))
        .execute()
        .await
        .context("create LanceDB BM25 index")?;
    Ok(table)
}

pub async fn vector_search(
    table: &Table,
    embedding: &[f32],
    filter: Option<&str>,
    limit: usize,
) -> Result<Vec<RankedChunk>> {
    let mut query = table
        .query()
        .nearest_to(embedding)
        .context("build LanceDB vector query")?
        .limit(limit);
    if let Some(filter) = filter {
        query = query.only_if(filter);
    }
    let batches = query
        .execute()
        .await
        .context("run LanceDB vector query")?
        .try_collect::<Vec<_>>()
        .await
        .context("read LanceDB vector results")?;
    ranked_chunks(&batches, "_distance", true)
}

pub async fn lexical_search(
    table: &Table,
    text: &str,
    filter: Option<&str>,
    limit: usize,
) -> Result<Vec<RankedChunk>> {
    let full_text = FullTextSearchQuery::new(text.to_owned())
        .with_column("text".to_owned())
        .context("build LanceDB BM25 query")?;
    let mut query = table.query().full_text_search(full_text).limit(limit);
    if let Some(filter) = filter {
        query = query.only_if(filter);
    }
    let batches = query
        .execute()
        .await
        .context("run LanceDB BM25 query")?
        .try_collect::<Vec<_>>()
        .await
        .context("read LanceDB BM25 results")?;
    ranked_chunks(&batches, "_score", false)
}

pub fn reciprocal_rank_fusion(
    lexical: &[RankedChunk],
    vector: &[RankedChunk],
    rank_constant: f32,
) -> Vec<RankedChunk> {
    let mut scores: HashMap<u64, (u64, f32)> = HashMap::new();
    for results in [lexical, vector] {
        for result in results {
            let contribution = 1.0 / (rank_constant + result.rank as f32);
            let entry = scores
                .entry(result.chunk_id)
                .or_insert((result.document_id, 0.0));
            entry.1 += contribution;
        }
    }
    let mut fused: Vec<_> = scores
        .into_iter()
        .map(|(chunk_id, (document_id, score))| RankedChunk {
            chunk_id,
            document_id,
            rank: 0,
            score,
        })
        .collect();
    fused.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then(left.chunk_id.cmp(&right.chunk_id))
    });
    for (index, result) in fused.iter_mut().enumerate() {
        result.rank = index + 1;
    }
    fused
}

pub fn collapse_to_documents(chunks: &[RankedChunk]) -> Vec<DocumentHit> {
    let mut seen = HashSet::new();
    chunks
        .iter()
        .filter_map(|chunk| {
            seen.insert(chunk.document_id).then_some(DocumentHit {
                document_id: chunk.document_id,
                best_chunk_id: chunk.chunk_id,
                score: chunk.score,
            })
        })
        .collect()
}

fn ranked_chunks(
    batches: &[RecordBatch],
    score_column: &str,
    distance: bool,
) -> Result<Vec<RankedChunk>> {
    let mut results = Vec::new();
    for batch in batches {
        let chunk_ids: &UInt64Array = downcast(batch, "chunk_id")?;
        let document_ids: &UInt64Array = downcast(batch, "document_id")?;
        let scores: &Float32Array = downcast(batch, score_column)?;
        for row in 0..batch.num_rows() {
            let score = if distance {
                -scores.value(row)
            } else {
                scores.value(row)
            };
            results.push(RankedChunk {
                chunk_id: chunk_ids.value(row),
                document_id: document_ids.value(row),
                rank: results.len() + 1,
                score,
            });
        }
    }
    Ok(results)
}

fn downcast<'a, T: Array + 'static>(batch: &'a RecordBatch, name: &str) -> Result<&'a T> {
    batch
        .column_by_name(name)
        .with_context(|| format!("result batch has no {name} column"))?
        .as_any()
        .downcast_ref::<T>()
        .with_context(|| format!("result column {name} has the wrong Arrow type"))
}

#[cfg(test)]
mod tests {
    use super::{
        RankedChunk, SPIKE_DIMENSION, SpikeChunk, collapse_to_documents, create_spike_table,
        lexical_search, reciprocal_rank_fusion, vector_search,
    };

    fn vector(axis: usize) -> Vec<f32> {
        let mut values = vec![0.0; SPIKE_DIMENSION as usize];
        values[axis] = 1.0;
        values
    }

    fn chunks() -> Vec<SpikeChunk> {
        vec![
            SpikeChunk {
                chunk_id: 1,
                document_id: 10,
                text: "Invoice for mountain equipment".into(),
                document_type: "invoice".into(),
                created_at_micros: 1_700_000_000_000_000,
                embedding: vector(0),
            },
            SpikeChunk {
                chunk_id: 2,
                document_id: 10,
                text: "Payment is due in thirty days".into(),
                document_type: "invoice".into(),
                created_at_micros: 1_700_000_000_000_000,
                embedding: vector(1),
            },
            SpikeChunk {
                chunk_id: 3,
                document_id: 20,
                text: "A summit is the highest mountain point".into(),
                document_type: "reference".into(),
                created_at_micros: 1_710_000_000_000_000,
                embedding: vector(2),
            },
        ]
    }

    #[tokio::test]
    async fn lance_supports_vector_bm25_and_filtered_retrieval() {
        let temporary = tempfile::tempdir().unwrap();
        let connection = lancedb::connect(temporary.path().to_string_lossy().as_ref())
            .execute()
            .await
            .unwrap();
        let table = create_spike_table(&connection, &chunks()).await.unwrap();

        let vector_results = vector_search(&table, &vector(2), None, 3).await.unwrap();
        assert_eq!(vector_results[0].chunk_id, 3);
        let filtered_vector =
            vector_search(&table, &vector(2), Some("document_type = 'invoice'"), 3)
                .await
                .unwrap();
        assert!(
            filtered_vector
                .iter()
                .all(|result| result.document_id == 10)
        );

        let lexical_results = lexical_search(&table, "invoice", None, 3).await.unwrap();
        assert_eq!(lexical_results[0].chunk_id, 1);
        let filtered_lexical =
            lexical_search(&table, "mountain", Some("document_type = 'reference'"), 3)
                .await
                .unwrap();
        assert_eq!(filtered_lexical.len(), 1);
        assert_eq!(filtered_lexical[0].chunk_id, 3);
    }

    #[test]
    fn rrf_and_document_collapse_keep_the_strongest_passage() {
        let lexical = vec![
            RankedChunk {
                chunk_id: 1,
                document_id: 10,
                rank: 1,
                score: 3.0,
            },
            RankedChunk {
                chunk_id: 3,
                document_id: 20,
                rank: 2,
                score: 2.0,
            },
        ];
        let vector = vec![
            RankedChunk {
                chunk_id: 3,
                document_id: 20,
                rank: 1,
                score: 0.9,
            },
            RankedChunk {
                chunk_id: 2,
                document_id: 10,
                rank: 2,
                score: 0.8,
            },
        ];
        let fused = reciprocal_rank_fusion(&lexical, &vector, 60.0);
        assert_eq!(fused[0].chunk_id, 3);
        let documents = collapse_to_documents(&fused);
        assert_eq!(documents.len(), 2);
        assert_eq!(documents[0].document_id, 20);
        assert_eq!(documents[0].best_chunk_id, 3);
    }
}
