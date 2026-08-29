use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result, bail};
use chrono::Utc;
use paperless_embeddings::EmbeddingService;
use paperless_models::{Document, DocumentPage, IngestionStatus};
use paperless_ocr_client::OcrClient;
use paperless_search::ChunkRepository;
use paperless_storage::{DocumentRepository, PageRepository};
use tokio::sync::{Semaphore, mpsc};
use tracing::error;

use crate::{MetadataService, PreviewService, chunk_document};

#[derive(Clone)]
pub struct IngestionQueue {
    sender: mpsc::Sender<u64>,
    repository: DocumentRepository,
}

impl IngestionQueue {
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        repository: DocumentRepository,
        pages: PageRepository,
        chunks: ChunkRepository,
        previews: PreviewService,
        ocr: OcrClient,
        embeddings: Option<EmbeddingService>,
        capacity: usize,
        job_concurrency: usize,
    ) -> Result<Self> {
        if capacity == 0 {
            bail!("queue_capacity must be greater than zero");
        }
        if job_concurrency == 0 {
            bail!("job_concurrency must be greater than zero");
        }
        let (sender, receiver) = mpsc::channel(capacity);
        let queue = Self {
            sender,
            repository: repository.clone(),
        };
        let metadata = MetadataService::new(repository.clone(), chunks.clone());
        tokio::spawn(run_dispatcher(
            receiver,
            Arc::new(repository.clone()),
            Arc::new(pages),
            Arc::new(chunks),
            previews,
            ocr,
            embeddings,
            metadata,
            job_concurrency,
        ));
        for document in repository.list_resumable_ingestion().await? {
            queue.enqueue(document.document_id).await?;
        }
        Ok(queue)
    }

    pub async fn enqueue(&self, document_id: u64) -> Result<()> {
        self.sender
            .send(document_id)
            .await
            .context("ingestion queue stopped")
    }

    pub async fn retry(&self, document_id: u64) -> Result<()> {
        let document = self
            .repository
            .get(document_id)
            .await?
            .context("document does not exist")?;
        if document.deleted_at.is_some() {
            bail!("deleted document cannot be retried");
        }
        if matches!(
            document.status,
            IngestionStatus::Stored
                | IngestionStatus::Previewing
                | IngestionStatus::Ocr
                | IngestionStatus::TextReady
                | IngestionStatus::Embedding
                | IngestionStatus::Indexing
        ) {
            bail!("document is still processing");
        }
        self.repository.mark_retry(document_id).await?;
        self.enqueue(document_id).await
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_dispatcher(
    mut receiver: mpsc::Receiver<u64>,
    repository: Arc<DocumentRepository>,
    pages: Arc<PageRepository>,
    chunks: Arc<ChunkRepository>,
    previews: PreviewService,
    ocr: OcrClient,
    embeddings: Option<EmbeddingService>,
    metadata: MetadataService,
    job_concurrency: usize,
) {
    let job_gate = Arc::new(Semaphore::new(job_concurrency));
    let active = Arc::new(Mutex::new(HashSet::new()));
    while let Some(document_id) = receiver.recv().await {
        {
            let mut active = active.lock().expect("ingestion active set poisoned");
            if !active.insert(document_id) {
                continue;
            }
        }
        let permit = match job_gate.clone().acquire_owned().await {
            Ok(permit) => permit,
            Err(_) => break,
        };
        let repository = repository.clone();
        let pages = pages.clone();
        let chunks = chunks.clone();
        let previews = previews.clone();
        let ocr = ocr.clone();
        let embeddings = embeddings.clone();
        let metadata = metadata.clone();
        let active = active.clone();
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(error) = process_document(
                repository,
                pages,
                chunks,
                previews,
                ocr,
                embeddings,
                metadata,
                document_id,
            )
            .await
            {
                error!(document_id, error = %error, "ingestion state update failed");
            }
            active
                .lock()
                .expect("ingestion active set poisoned")
                .remove(&document_id);
        });
    }
}

#[allow(clippy::too_many_arguments)]
async fn process_document(
    repository: Arc<DocumentRepository>,
    pages: Arc<PageRepository>,
    chunks: Arc<ChunkRepository>,
    previews: PreviewService,
    ocr: OcrClient,
    embeddings: Option<EmbeddingService>,
    metadata: MetadataService,
    document_id: u64,
) -> Result<()> {
    let result: Result<()> = async {
        let mut document = match repository.get(document_id).await? {
            Some(document) if document.deleted_at.is_none() => document,
            _ => return Ok(()),
        };

        if matches!(
            document.status,
            IngestionStatus::Stored | IngestionStatus::Previewing
        ) {
            repository
                .set_status(document_id, IngestionStatus::Previewing, None)
                .await?;
            let page_count = previews
                .prepare_owned(document.clone())
                .await
                .context("preview failed")?;
            repository
                .set_preview_ready(document_id, page_count)
                .await?;
            document.page_count = page_count;
            document.status = IngestionStatus::Ocr;
        }

        if document.status == IngestionStatus::Ocr {
            let recognized = recognize_document(previews.clone(), ocr.clone(), document.clone())
                .await
                .context("OCR failed")?;
            pages
                .replace_document_pages(document_id, recognized)
                .await?;
            repository
                .set_status(document_id, IngestionStatus::TextReady, None)
                .await?;
            document.status = IngestionStatus::TextReady;
        }

        if matches!(
            document.status,
            IngestionStatus::TextReady | IngestionStatus::Embedding
        ) {
            let page_rows = pages.list(document_id).await?;
            if document.status == IngestionStatus::TextReady {
                let known_senders = repository.senders().await?;
                let inferred = ocr
                    .infer_metadata(page_rows.clone(), &known_senders)
                    .await
                    .context("metadata inference failed")?;
                document = metadata
                    .apply_inferred(document_id, inferred)
                    .await
                    .context("metadata storage failed")?;
            }
            let embeddings = embeddings
                .as_ref()
                .context("embedding model is not configured")?;
            repository
                .set_status(document_id, IngestionStatus::Embedding, None)
                .await?;
            let mut embedded = embed_document(embeddings, &document, &page_rows)
                .await
                .context("embedding failed")?;
            embedded.sort_by_key(|chunk| chunk.chunk_id);
            chunks.replace_document(document_id, embedded).await?;
            repository
                .set_status(document_id, IngestionStatus::Indexing, None)
                .await?;
            document.status = IngestionStatus::Indexing;
        }

        if document.status == IngestionStatus::Indexing {
            repository
                .set_status(document_id, IngestionStatus::Ready, None)
                .await?;
        }

        Ok(())
    }
    .await;

    if let Err(error) = result {
        fail_document(repository, document_id, format!("{error:#}")).await?;
    }
    Ok(())
}

async fn embed_document(
    embeddings: &EmbeddingService,
    document: &Document,
    pages: &[DocumentPage],
) -> Result<Vec<paperless_models::Chunk>> {
    let mut chunks = chunk_document(document, pages)?;
    let vectors = embeddings
        .embed_documents(chunks.iter().map(|chunk| chunk.text.clone()).collect())
        .await?;
    if vectors.len() != chunks.len() {
        bail!(
            "Harrier returned {} embeddings for {} chunks",
            vectors.len(),
            chunks.len()
        );
    }
    for (chunk, vector) in chunks.iter_mut().zip(vectors) {
        chunk.embedding = vector;
    }
    Ok(chunks)
}

async fn recognize_document(
    previews: PreviewService,
    ocr: OcrClient,
    document: Document,
) -> Result<Vec<DocumentPage>> {
    let batch_size = previews.max_ocr_batch_pages() as u32;
    let mut recognized = Vec::with_capacity(document.page_count as usize);
    let mut first_page = 1;
    while first_page <= document.page_count {
        let count = batch_size.min(document.page_count - first_page + 1);
        let images = previews
            .render_ocr_batch_owned(document.clone(), first_page, count)
            .await?;
        let batch = ocr.recognize_pages(images).await?;
        recognized.extend(batch.into_iter().map(|page| DocumentPage {
            document_id: document.document_id,
            page: page.page,
            text: page.text,
            blocks: page.blocks,
            html: Some(page.html),
            updated_at: Utc::now(),
        }));
        first_page += count;
    }
    if recognized.len() != document.page_count as usize {
        bail!(
            "OCR returned {} pages for a {} page document",
            recognized.len(),
            document.page_count
        );
    }
    recognized.sort_by_key(|page| page.page);
    Ok(recognized)
}

async fn fail_document(
    repository: Arc<DocumentRepository>,
    document_id: u64,
    message: String,
) -> Result<()> {
    repository
        .set_status(document_id, IngestionStatus::Failed, Some(message))
        .await
}
