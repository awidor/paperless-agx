use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use chrono::Utc;
use paperless_ingest::{IngestionQueue, PreviewService};
use paperless_models::{Document, DocumentPage, IngestionStatus, MediaType};
use paperless_ocr_client::{LlmConfig, OcrClient, OcrConfig};
use paperless_search::ChunkRepository;
use paperless_storage::{DataLayout, DocumentRepository, ObjectStore, PageRepository};

#[tokio::test]
async fn failure_is_persisted_and_manual_retry_is_counted() {
    let temporary = tempfile::tempdir().unwrap();
    let layout = DataLayout::create(temporary.path()).await.unwrap();
    let repository = DocumentRepository::open(&layout).await.unwrap();
    let pages = PageRepository::open(&layout).await.unwrap();
    let chunks = ChunkRepository::open(&layout.lance).await.unwrap();
    let object = ObjectStore::new(layout.clone())
        .store(b"not an image".as_slice())
        .await
        .unwrap();
    let now = Utc::now();
    let document = Document {
        document_id: repository.allocate_id(),
        content_hash: object.content_hash,
        media_type: MediaType::Image,
        filename: "broken.png".into(),
        title: None,
        sender: None,
        created_at: None,
        added_at: now,
        updated_at: now,
        title_source: None,
        sender_source: None,
        created_at_source: None,
        page_count: 0,
        file_size: object.file_size,
        status: IngestionStatus::Stored,
        last_error: None,
        retry_count: 0,
        deleted_at: None,
    };
    repository.insert(&document).await.unwrap();
    let previews = PreviewService::new(layout, 1, 1, 1).unwrap();
    let ocr = OcrClient::from_environment(
        OcrConfig {
            base_url: url::Url::parse("http://127.0.0.1:1/v1").unwrap(),
            model: "google/gemini-3.7-flash".into(),
            api_key_env: "PATH".into(),
            max_concurrency: 1,
            pages_per_request: 1,
            max_output_tokens: 16_384,
        },
        LlmConfig {
            base_url: url::Url::parse("https://openrouter.ai/api/v1").unwrap(),
            model: "z-ai/glm-5.3-flash".into(),
            api_key_env: "PATH".into(),
            max_concurrency: 1,
        },
    )
    .unwrap();
    let queue = IngestionQueue::start(repository.clone(), pages, chunks, previews, ocr, None, 1, 1)
        .await
        .unwrap();

    let failed = wait_for_status(&repository, document.document_id, IngestionStatus::Failed).await;
    assert!(failed.last_error.unwrap().contains("decode image"));
    queue.retry(document.document_id).await.unwrap();
    let retried = wait_for_status(&repository, document.document_id, IngestionStatus::Failed).await;
    assert_eq!(retried.retry_count, 1);
}

#[tokio::test(start_paused = true)]
async fn transient_metadata_failure_retries_before_following_stage() {
    let temporary = tempfile::tempdir().unwrap();
    let layout = DataLayout::create(temporary.path()).await.unwrap();
    let repository = DocumentRepository::open(&layout).await.unwrap();
    let pages = PageRepository::open(&layout).await.unwrap();
    let chunks = ChunkRepository::open(&layout.lance).await.unwrap();
    let object = ObjectStore::new(layout.clone())
        .store(b"stored document".as_slice())
        .await
        .unwrap();
    let now = Utc::now();
    let document = Document {
        document_id: repository.allocate_id(),
        content_hash: object.content_hash,
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
        file_size: object.file_size,
        status: IngestionStatus::TextReady,
        last_error: None,
        retry_count: 0,
        deleted_at: None,
    };
    repository.insert(&document).await.unwrap();
    pages
        .replace_document_pages(
            document.document_id,
            vec![DocumentPage {
                document_id: document.document_id,
                page: 1,
                text: "Account statement dated 2026-08-01".into(),
                blocks: vec![],
                html: None,
                updated_at: now,
            }],
        )
        .await
        .unwrap();

    let attempts = Arc::new(AtomicUsize::new(0));
    let route_attempts = attempts.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url =
        url::Url::parse(&format!("http://{}/v1", listener.local_addr().unwrap())).unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route(
                "/v1/chat/completions",
                axum::routing::post(move || {
                    let route_attempts = route_attempts.clone();
                    async move {
                        let attempt = route_attempts.fetch_add(1, Ordering::SeqCst);
                        let (status, body) = if attempt < 5 {
                            (
                                axum::http::StatusCode::TOO_MANY_REQUESTS,
                                r#"{"error":"busy"}"#,
                            )
                        } else {
                            (
                                axum::http::StatusCode::OK,
                                r#"{"choices":[{"message":{"content":"{\"title\":\"August statement\",\"sender\":\"Stadtwerke\",\"created_at\":\"2026-08-01\"}"}}]}"#,
                            )
                        };
                        (
                            status,
                            [(axum::http::header::RETRY_AFTER, "0")],
                            body,
                        )
                    }
                }),
            ),
        )
        .await
        .unwrap();
    });
    let key_name = "PAPERLESS_QUEUE_METADATA_TEST_KEY";
    unsafe { std::env::set_var(key_name, "secret") };
    let ocr = OcrClient::from_environment(
        OcrConfig {
            base_url: base_url.clone(),
            model: "instruct".into(),
            api_key_env: key_name.into(),
            max_concurrency: 1,
            pages_per_request: 1,
            max_output_tokens: 16_384,
        },
        LlmConfig {
            base_url,
            model: "z-ai/glm-5.3-flash".into(),
            api_key_env: key_name.into(),
            max_concurrency: 1,
        },
    )
    .unwrap();
    let previews = PreviewService::new(layout, 1, 1, 1).unwrap();
    let _queue =
        IngestionQueue::start(repository.clone(), pages, chunks, previews, ocr, None, 1, 1)
            .await
            .unwrap();

    wait_for_attempts(&attempts, 5).await;
    let pending = repository.get(document.document_id).await.unwrap().unwrap();
    assert_eq!(pending.status, IngestionStatus::TextReady);
    assert!(pending.last_error.is_none());
    tokio::time::advance(Duration::from_secs(61)).await;
    let failed = wait_for_status(&repository, document.document_id, IngestionStatus::Failed).await;
    unsafe { std::env::remove_var(key_name) };
    assert_eq!(attempts.load(Ordering::SeqCst), 6);
    assert_eq!(failed.title.as_deref(), Some("August statement"));
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
}

#[tokio::test]
async fn metadata_error_fails_the_document() {
    let temporary = tempfile::tempdir().unwrap();
    let layout = DataLayout::create(temporary.path()).await.unwrap();
    let repository = DocumentRepository::open(&layout).await.unwrap();
    let pages = PageRepository::open(&layout).await.unwrap();
    let chunks = ChunkRepository::open(&layout.lance).await.unwrap();
    let object = ObjectStore::new(layout.clone())
        .store(b"stored document".as_slice())
        .await
        .unwrap();
    let now = Utc::now();
    let document = Document {
        document_id: repository.allocate_id(),
        content_hash: object.content_hash,
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
        file_size: object.file_size,
        status: IngestionStatus::TextReady,
        last_error: None,
        retry_count: 0,
        deleted_at: None,
    };
    repository.insert(&document).await.unwrap();
    pages
        .replace_document_pages(
            document.document_id,
            vec![DocumentPage {
                document_id: document.document_id,
                page: 1,
                text: "Account statement dated 2026-08-01".into(),
                blocks: vec![],
                html: None,
                updated_at: now,
            }],
        )
        .await
        .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url =
        url::Url::parse(&format!("http://{}/v1", listener.local_addr().unwrap())).unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route(
                "/v1/chat/completions",
                axum::routing::post(|| async {
                    (axum::http::StatusCode::BAD_REQUEST, "invalid request")
                }),
            ),
        )
        .await
        .unwrap();
    });
    let key_name = "PAPERLESS_QUEUE_METADATA_ERROR_TEST_KEY";
    unsafe { std::env::set_var(key_name, "secret") };
    let ocr = OcrClient::from_environment(
        OcrConfig {
            base_url: base_url.clone(),
            model: "instruct".into(),
            api_key_env: key_name.into(),
            max_concurrency: 1,
            pages_per_request: 1,
            max_output_tokens: 16_384,
        },
        LlmConfig {
            base_url,
            model: "z-ai/glm-5.3-flash".into(),
            api_key_env: key_name.into(),
            max_concurrency: 1,
        },
    )
    .unwrap();
    let previews = PreviewService::new(layout, 1, 1, 1).unwrap();
    let _queue =
        IngestionQueue::start(repository.clone(), pages, chunks, previews, ocr, None, 1, 1)
            .await
            .unwrap();

    let failed = wait_for_status(&repository, document.document_id, IngestionStatus::Failed).await;
    unsafe { std::env::remove_var(key_name) };
    let error = failed.last_error.unwrap();
    assert!(error.contains("metadata inference failed"));
    assert!(error.contains("400"));
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
    for _ in 0..1_000 {
        if attempts.load(Ordering::SeqCst) >= expected {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("metadata request did not reach {expected} attempts");
}
