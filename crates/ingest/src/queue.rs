use std::{collections::HashSet, io::ErrorKind, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail};
use paperless_models::IngestionStatus;
use paperless_storage::DocumentRepository;
use tokio::sync::{Mutex, Semaphore, mpsc};
use tracing::{error, warn};

use crate::PreviewService;

#[derive(Clone)]
pub struct IngestionQueue {
    sender: mpsc::Sender<u64>,
    repository: DocumentRepository,
}

impl IngestionQueue {
    pub async fn start(
        repository: DocumentRepository,
        previews: PreviewService,
        capacity: usize,
        job_concurrency: usize,
        transient_retry_limit: u32,
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
        tokio::spawn(run_dispatcher(
            receiver,
            repository.clone(),
            previews,
            job_concurrency,
            transient_retry_limit,
        ));
        for document in repository.list_resumable_pre_ocr().await? {
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
        if document.status != IngestionStatus::Failed {
            bail!("only a failed document can be retried");
        }
        self.repository.mark_retry(document_id).await?;
        self.enqueue(document_id).await
    }
}

async fn run_dispatcher(
    mut receiver: mpsc::Receiver<u64>,
    repository: DocumentRepository,
    previews: PreviewService,
    job_concurrency: usize,
    transient_retry_limit: u32,
) {
    let job_gate = Arc::new(Semaphore::new(job_concurrency));
    let active = Arc::new(Mutex::new(HashSet::new()));
    while let Some(document_id) = receiver.recv().await {
        {
            let mut active = active.lock().await;
            if !active.insert(document_id) {
                continue;
            }
        }
        let permit = match job_gate.clone().acquire_owned().await {
            Ok(permit) => permit,
            Err(_) => break,
        };
        let repository = repository.clone();
        let previews = previews.clone();
        let active = active.clone();
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(error) =
                process_document(&repository, &previews, document_id, transient_retry_limit).await
            {
                error!(document_id, error = %error, "ingestion state update failed");
            }
            active.lock().await.remove(&document_id);
        });
    }
}

async fn process_document(
    repository: &DocumentRepository,
    previews: &PreviewService,
    document_id: u64,
    transient_retry_limit: u32,
) -> Result<()> {
    let document = match repository.get(document_id).await? {
        Some(document) if document.deleted_at.is_none() => document,
        _ => return Ok(()),
    };
    repository
        .set_status(document_id, IngestionStatus::Previewing, None)
        .await?;

    let mut attempt = 0;
    loop {
        match previews.prepare(&document).await {
            Ok(page_count) => {
                repository
                    .set_preview_ready(document_id, page_count)
                    .await?;
                return Ok(());
            }
            Err(error) if attempt < transient_retry_limit && is_transient(&error) => {
                attempt += 1;
                warn!(document_id, attempt, error = %error, "transient preview failure");
                tokio::time::sleep(Duration::from_millis(250 * u64::from(attempt))).await;
            }
            Err(error) => {
                let message = format!("preview failed: {error:#}");
                repository
                    .set_status(document_id, IngestionStatus::Failed, Some(&message))
                    .await?;
                return Ok(());
            }
        }
    }
}

fn is_transient(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.downcast_ref::<std::io::Error>().is_some_and(|error| {
            matches!(
                error.kind(),
                ErrorKind::Interrupted | ErrorKind::TimedOut | ErrorKind::WouldBlock
            )
        })
    })
}
