use anyhow::{Context, Result, bail};
use paperless_search::ChunkRepository;
use paperless_storage::{DataLayout, DocumentRepository, ObjectStore, PageRepository};
use tokio::sync::{Semaphore, mpsc};
use tracing::error;

#[derive(Clone)]
pub struct CleanupQueue {
    sender: mpsc::Sender<u64>,
}

impl CleanupQueue {
    pub async fn start(
        documents: DocumentRepository,
        pages: PageRepository,
        chunks: ChunkRepository,
        objects: ObjectStore,
        layout: DataLayout,
        capacity: usize,
        concurrency: usize,
    ) -> Result<Self> {
        if capacity == 0 || concurrency == 0 {
            bail!("cleanup capacity and concurrency must be greater than zero");
        }
        let (sender, receiver) = mpsc::channel(capacity);
        let queue = Self { sender };
        tokio::spawn(run_cleanup(
            receiver,
            documents.clone(),
            pages,
            chunks,
            objects,
            layout,
            concurrency,
        ));
        for document in documents.list_deleted().await? {
            queue.enqueue(document.document_id).await?;
        }
        Ok(queue)
    }

    pub async fn enqueue(&self, document_id: u64) -> Result<()> {
        self.sender
            .send(document_id)
            .await
            .context("cleanup queue stopped")
    }
}

async fn run_cleanup(
    mut receiver: mpsc::Receiver<u64>,
    documents: DocumentRepository,
    pages: PageRepository,
    chunks: ChunkRepository,
    objects: ObjectStore,
    layout: DataLayout,
    concurrency: usize,
) {
    let gate = std::sync::Arc::new(Semaphore::new(concurrency));
    while let Some(document_id) = receiver.recv().await {
        let permit = match gate.clone().acquire_owned().await {
            Ok(permit) => permit,
            Err(_) => break,
        };
        let documents = documents.clone();
        let pages = pages.clone();
        let chunks = chunks.clone();
        let objects = objects.clone();
        let layout = layout.clone();
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(error) =
                cleanup_document(&documents, &pages, &chunks, &objects, &layout, document_id).await
            {
                error!(document_id, error = %error, "document cleanup failed");
            }
        });
    }
}

async fn cleanup_document(
    documents: &DocumentRepository,
    pages: &PageRepository,
    chunks: &ChunkRepository,
    objects: &ObjectStore,
    layout: &DataLayout,
    document_id: u64,
) -> Result<()> {
    let Some(document) = documents.get(document_id).await? else {
        return Ok(());
    };
    if document.deleted_at.is_none() {
        return Ok(());
    }
    chunks.delete_document(document_id).await?;
    pages.delete_document(document_id).await?;
    for directory in [
        layout.thumbnail_directory(document_id),
        layout.page_image_directory(document_id),
    ] {
        match tokio::fs::remove_dir_all(&directory).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("remove renders {}", directory.display()));
            }
        }
    }
    if !documents.has_active_hash(&document.content_hash).await? {
        objects.remove(&document.content_hash).await?;
    }
    Ok(())
}
