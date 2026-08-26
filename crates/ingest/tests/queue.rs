use std::time::Duration;

use chrono::Utc;
use paperless_ingest::{IngestionQueue, PreviewService};
use paperless_models::{Document, IngestionStatus, MediaType};
use paperless_ocr_client::{OcrClient, OcrConfig};
use paperless_storage::{DataLayout, DocumentRepository, ObjectStore, PageRepository};

#[tokio::test]
async fn failure_is_persisted_and_manual_retry_is_counted() {
    let temporary = tempfile::tempdir().unwrap();
    let layout = DataLayout::create(temporary.path()).await.unwrap();
    let repository = DocumentRepository::open(&layout).await.unwrap();
    let pages = PageRepository::open(&layout).await.unwrap();
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
        document_type: None,
        created_at: None,
        added_at: now,
        updated_at: now,
        title_source: None,
        type_source: None,
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
    let ocr = OcrClient::from_environment(OcrConfig {
        base_url: url::Url::parse("http://127.0.0.1:1/v1").unwrap(),
        model: "datalab-to/surya-ocr-2".into(),
        api_key_env: "PATH".into(),
        max_concurrency: 1,
        pages_per_request: 1,
    })
    .unwrap();
    let queue = IngestionQueue::start(repository.clone(), pages, previews, ocr, 1, 1)
        .await
        .unwrap();

    let failed = wait_for_status(&repository, document.document_id, IngestionStatus::Failed).await;
    assert!(failed.last_error.unwrap().contains("decode image"));
    queue.retry(document.document_id).await.unwrap();
    let retried = wait_for_status(&repository, document.document_id, IngestionStatus::Failed).await;
    assert_eq!(retried.retry_count, 1);
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
