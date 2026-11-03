use anyhow::Result;
use futures::{StreamExt, stream};
use paperless_models::IngestionStatus;
use paperless_ocr_client::OcrClient;
use paperless_storage::{DocumentRepository, PageRepository};
use tracing::warn;

use crate::MetadataService;

/// Summaries requested at once; the metadata client bounds its own concurrency as well.
const SUMMARY_CONCURRENCY: usize = 2;

/// Writes a summary for every ready document that has none, such as documents indexed
/// before summaries existed. Their summary passages still need `embed_pending_chunks`.
/// Returns the number of summaries written; a failed document is logged and skipped.
pub async fn backfill_summaries(
    documents: &DocumentRepository,
    pages: &PageRepository,
    metadata: &MetadataService,
    ocr: &OcrClient,
) -> Result<usize> {
    let missing = documents
        .list_active()
        .await?
        .into_iter()
        .filter(|document| document.status == IngestionStatus::Ready && document.summary.is_none())
        .map(|document| document.document_id)
        .collect::<Vec<_>>();
    let written = stream::iter(missing)
        .map(|document_id| async move {
            let result: Result<bool> = async {
                let page_rows = pages.list(document_id).await?;
                let inferred = ocr.infer_metadata(page_rows, &[]).await?;
                metadata.apply_summary(document_id, inferred.summary).await
            }
            .await;
            match result {
                Ok(written) => written,
                Err(error) => {
                    warn!(document_id, error = %format!("{error:#}"), "summarize document");
                    false
                }
            }
        })
        .buffer_unordered(SUMMARY_CONCURRENCY)
        .filter(|written| std::future::ready(*written))
        .count()
        .await;
    Ok(written)
}
