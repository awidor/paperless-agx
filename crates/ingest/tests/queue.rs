use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use chrono::Utc;
use paperless_ingest::{IndexingAgent, IngestionQueue, PreviewService};
use paperless_models::{Document, IngestionStatus, MediaType};
use paperless_storage::{
    ChunkRepository, DataLayout, DocumentRepository, ObjectStore, PageRepository,
};

fn document(
    repository: &DocumentRepository,
    content_hash: [u8; 32],
    status: IngestionStatus,
) -> Document {
    let now = Utc::now();
    Document {
        document_id: repository.allocate_id(),
        content_hash,
        media_type: MediaType::Image,
        filename: "statement.png".into(),
        title: None,
        sender: None,
        created_at: None,
        added_at: now,
        updated_at: now,
        title_source: None,
        sender_source: None,
        created_at_source: None,
        page_count: 1,
        file_size: 1,
        status,
        last_error: None,
        retry_count: 0,
        deleted_at: None,
        summary: None,
    }
}

/// An agent service whose `/index` answers each attempt with the given server-sent events.
async fn start_agent(
    respond: impl Fn(usize) -> String + Clone + Send + Sync + 'static,
) -> (url::Url, Arc<AtomicUsize>) {
    let attempts = Arc::new(AtomicUsize::new(0));
    let route_attempts = attempts.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route(
                "/index",
                axum::routing::post(move || {
                    let attempt = route_attempts.fetch_add(1, Ordering::SeqCst);
                    let body = respond(attempt);
                    async move {
                        (
                            [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                            body,
                        )
                    }
                }),
            ),
        )
        .await
        .unwrap();
    });
    (url, attempts)
}

const INDEXED: &str = r#"event: result
data: {"pages":[{"page":1,"blocks":[{"label":"Text","bbox":[50,40,950,120],"html":"<p>Account statement dated 2026-08-01</p>"}]}],"title":"August statement","sender":"Stadtwerke","created_at":"2026-08-01","summary":"Kontoauszug August."}

"#;

#[tokio::test]
async fn failure_is_persisted_and_manual_retry_is_counted() {
    let temporary = tempfile::tempdir().unwrap();
    let layout = DataLayout::create(temporary.path()).await.unwrap();
    let repository = DocumentRepository::open(&layout).await.unwrap();
    let pages = PageRepository::open(&layout).await.unwrap();
    let chunks = ChunkRepository::open(&layout).await.unwrap();
    let object = ObjectStore::new(layout.clone())
        .store(b"not an image".as_slice())
        .await
        .unwrap();
    let mut broken = document(&repository, object.content_hash, IngestionStatus::Stored);
    broken.filename = "broken.png".into();
    broken.page_count = 0;
    repository.insert(&broken).await.unwrap();
    let previews = PreviewService::new(layout, 1, 1, 120).unwrap();
    let indexer = IndexingAgent::new(&url::Url::parse("http://127.0.0.1:1/").unwrap()).unwrap();
    let queue = IngestionQueue::start(
        repository.clone(),
        pages,
        chunks,
        previews,
        indexer,
        None,
        1,
        1,
    )
    .await
    .unwrap();

    let failed = wait_for_status(&repository, broken.document_id, IngestionStatus::Failed).await;
    assert!(failed.last_error.unwrap().contains("decode image"));
    queue.retry(broken.document_id).await.unwrap();
    let retried = wait_for_status(&repository, broken.document_id, IngestionStatus::Failed).await;
    assert_eq!(retried.retry_count, 1);
}

#[tokio::test(start_paused = true)]
async fn transient_indexing_failure_retries_and_stores_pages_and_details() {
    let temporary = tempfile::tempdir().unwrap();
    let layout = DataLayout::create(temporary.path()).await.unwrap();
    let repository = DocumentRepository::open(&layout).await.unwrap();
    let pages = PageRepository::open(&layout).await.unwrap();
    let chunks = ChunkRepository::open(&layout).await.unwrap();
    let object = ObjectStore::new(layout.clone())
        .store(b"stored document".as_slice())
        .await
        .unwrap();
    let waiting = document(&repository, object.content_hash, IngestionStatus::Ocr);
    repository.insert(&waiting).await.unwrap();
    let (url, attempts) = start_agent(|attempt| {
        if attempt == 0 {
            "event: error\ndata: {\"message\":\"the model failed: 429\",\"transient\":true}\n\n"
                .into()
        } else {
            INDEXED.into()
        }
    })
    .await;
    let previews = PreviewService::new(layout, 1, 1, 120).unwrap();
    let indexer = IndexingAgent::new(&url).unwrap();
    let _queue = IngestionQueue::start(
        repository.clone(),
        pages.clone(),
        chunks,
        previews,
        indexer,
        None,
        1,
        1,
    )
    .await
    .unwrap();

    wait_for_attempts(&attempts, 1).await;
    let pending = repository.get(waiting.document_id).await.unwrap().unwrap();
    assert_eq!(pending.status, IngestionStatus::Ocr);
    assert!(pending.last_error.is_none());
    tokio::time::advance(Duration::from_secs(61)).await;
    // Without embeddings the document stops at the next stage, after indexing was stored.
    let failed = wait_for_status(&repository, waiting.document_id, IngestionStatus::Failed).await;
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    assert_eq!(failed.title.as_deref(), Some("August statement"));
    assert_eq!(failed.sender.as_deref(), Some("Stadtwerke"));
    assert_eq!(failed.summary.as_deref(), Some("Kontoauszug August."));
    assert_eq!(
        failed.created_at.unwrap().to_rfc3339(),
        "2026-08-01T00:00:00+00:00"
    );
    assert!(
        failed
            .last_error
            .unwrap()
            .contains("embedding model is not configured")
    );
    let stored = pages.list(waiting.document_id).await.unwrap();
    assert_eq!(stored[0].text, "Account statement dated 2026-08-01");
    assert_eq!(stored[0].blocks[0].bbox, [50, 40, 950, 120]);
}

#[tokio::test]
async fn permanent_indexing_error_fails_the_document() {
    let temporary = tempfile::tempdir().unwrap();
    let layout = DataLayout::create(temporary.path()).await.unwrap();
    let repository = DocumentRepository::open(&layout).await.unwrap();
    let pages = PageRepository::open(&layout).await.unwrap();
    let chunks = ChunkRepository::open(&layout).await.unwrap();
    let object = ObjectStore::new(layout.clone())
        .store(b"stored document".as_slice())
        .await
        .unwrap();
    let waiting = document(&repository, object.content_hash, IngestionStatus::Ocr);
    repository.insert(&waiting).await.unwrap();
    let (url, _) = start_agent(|_| {
        "event: error\ndata: {\"message\":\"the indexing agent stopped after 9 turns without finishing\",\"transient\":false}\n\n".into()
    })
    .await;
    let previews = PreviewService::new(layout, 1, 1, 120).unwrap();
    let indexer = IndexingAgent::new(&url).unwrap();
    let _queue = IngestionQueue::start(
        repository.clone(),
        pages,
        chunks,
        previews,
        indexer,
        None,
        1,
        1,
    )
    .await
    .unwrap();

    let failed = wait_for_status(&repository, waiting.document_id, IngestionStatus::Failed).await;
    let error = failed.last_error.unwrap();
    assert!(error.contains("indexing failed"));
    assert!(error.contains("without finishing"));
    assert!(failed.title.is_none());
}

async fn wait_for_status(
    repository: &DocumentRepository,
    document_id: u64,
    expected: IngestionStatus,
) -> Document {
    for _ in 0..100 {
        let document = repository.get(document_id).await.unwrap().unwrap();
        if document.status == expected {
            return document;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("document did not reach {expected}");
}

async fn wait_for_attempts(attempts: &AtomicUsize, expected: usize) {
    // The Tokio clock is paused, but SQLite and socket I/O use real time.
    // A fixed number of yields can finish before that I/O completes.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if attempts.load(Ordering::SeqCst) >= expected {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("indexing request did not reach {expected} attempts");
}
