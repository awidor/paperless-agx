use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

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

#[cfg(test)]
mod tests {
    use super::{RankedChunk, collapse_to_documents, reciprocal_rank_fusion};

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
