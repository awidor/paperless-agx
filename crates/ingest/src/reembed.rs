use anyhow::{Result, bail};
use paperless_embeddings::EmbeddingService;
use paperless_storage::ChunkRepository;

/// Chunks listed and stored per round; the embedding service bounds its own concurrency.
const REEMBED_BATCH: usize = 100;

/// Embeds every stored chunk that has no vector for the configured model, for example after
/// the embedding model changed. Returns the number of chunks embedded.
pub async fn embed_pending_chunks(
    chunks: &ChunkRepository,
    embeddings: &EmbeddingService,
) -> Result<usize> {
    let mut embedded = 0;
    let mut after_chunk_id = 0;
    loop {
        let pending = chunks
            .pending_embeddings(after_chunk_id, REEMBED_BATCH)
            .await?;
        let Some(last) = pending.last() else {
            return Ok(embedded);
        };
        after_chunk_id = last.chunk_id;
        let vectors = embeddings
            .embed_documents(
                pending
                    .iter()
                    .map(|chunk| (chunk.title.clone(), chunk.text.clone()))
                    .collect(),
            )
            .await?;
        if vectors.len() != pending.len() {
            bail!(
                "embedding service returned {} embeddings for {} chunks",
                vectors.len(),
                pending.len()
            );
        }
        embedded += pending.len();
        chunks
            .store_embeddings(pending.into_iter().zip(vectors).collect())
            .await?;
    }
}
