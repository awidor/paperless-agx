use std::{io::Cursor, path::Path, time::Duration};

use axum::{
    Json, Router,
    body::Body,
    http::{Request, StatusCode, header},
    routing::post,
};
use chrono::Utc;
use http_body_util::BodyExt;
use image::{DynamicImage, ImageFormat};
use paperless_models::{Document, IngestionStatus, MediaType};
use paperless_scanner::fake::{FakeScanner, FakeSetup};
use paperless_server::{AgentConfig, AppConfig, EmbeddingConfig, ScannerConfig, build_app};
use paperless_storage::{DataLayout, DocumentRepository, ObjectStore};
use tower::ServiceExt;
use url::Url;

fn config(data_dir: &Path, agent_url: Url) -> AppConfig {
    AppConfig {
        data_dir: data_dir.to_path_buf(),
        listen_addr: "0.0.0.0:0".parse().unwrap(),
        queue_capacity: 4,
        render_concurrency: 2,
        eager_thumbnail_pages: 3,
        page_dpi: 120,
        embeddings: None,
        agent: AgentConfig { url: agent_url },
        scanner: None,
    }
}

async fn start_agent() -> Url {
    start_agent_with_text("Recognized page text".into()).await
}

async fn serve(app: Router) -> Url {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Url::parse(&format!("http://{address}/")).unwrap()
}

/// An agent service whose indexing sessions never finish.
async fn start_blocked_agent() -> Url {
    serve(Router::new().route(
        "/index",
        post(|| async { std::future::pending::<String>().await }),
    ))
    .await
}

/// An agent service that indexes every page as one block of `text`, with embeddings beside it.
async fn start_agent_with_text(text: String) -> Url {
    serve(
        Router::new()
            .route(
                "/index",
                post(move |Json(body): Json<serde_json::Value>| {
                    let text = text.clone();
                    async move {
                        assert!(body["document_id"].as_u64().is_some());
                        let result = serde_json::json!({
                            "pages": [{
                                "page": 1,
                                "blocks": [{"label": "Text", "bbox": [0, 0, 1000, 1000], "html": format!("<p>{text}</p>")}]
                            }],
                            "title": "Extracted title",
                            "sender": null,
                            "created_at": null,
                            "summary": "Testschreiben mit Kundennummer 4711."
                        });
                        (
                            [(header::CONTENT_TYPE, "text/event-stream")],
                            format!(
                                "event: progress\ndata: {{\"label\":\"Reading page 1\"}}\n\n: keep-alive\n\nevent: result\ndata: {result}\n\n"
                            ),
                        )
                    }
                }),
            )
            .route(
                "/v1/embeddings",
                post(|Json(body): Json<serde_json::Value>| async move {
                    assert_eq!(body["provider"]["zdr"], true);
                    assert_eq!(body["provider"]["data_collection"], "deny");
                    assert!(body["input"].is_string(), "one input per request");
                    let values = vec![1.0_f32; paperless_models::EMBEDDING_DIMENSION];
                    Json(serde_json::json!({
                        "object": "list",
                        "data": [{ "embedding": values, "index": 0 }]
                    }))
                }),
            ),
    )
    .await
}

fn png() -> Vec<u8> {
    let mut output = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(16, 12)
        .write_to(&mut output, ImageFormat::Png)
        .unwrap();
    output.into_inner()
}

fn unique_png(value: u8) -> Vec<u8> {
    let mut image = image::RgbImage::new(16, 12);
    image.put_pixel(0, 0, image::Rgb([value, 0, 0]));
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(image)
        .write_to(&mut output, ImageFormat::Png)
        .unwrap();
    output.into_inner()
}

fn multipart(file_name: &str, content_type: &str, file: &[u8], title: &str) -> (String, Vec<u8>) {
    let boundary = "paperless-test-boundary";
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\n{title}\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: {content_type}\r\n\r\n"
    ).as_bytes());
    body.extend_from_slice(file);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

async fn upload(
    app: &Router,
    file_name: &str,
    content_type: &str,
    bytes: &[u8],
    title: &str,
) -> (StatusCode, Document) {
    let (multipart_type, body) = multipart(file_name, content_type, bytes, title);
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/documents")
                .header(header::CONTENT_TYPE, multipart_type)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let document = serde_json::from_slice(&body).unwrap();
    (status, document)
}

async fn get_document(app: &Router, document_id: u64) -> Document {
    let response = app
        .clone()
        .oneshot(
            Request::get(format!("/api/documents/{document_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn wait_for_ocr(app: &Router, document_id: u64) -> Document {
    for _ in 0..200 {
        let document = get_document(app, document_id).await;
        if document.page_count > 0
            && !matches!(
                document.status,
                IngestionStatus::Stored | IngestionStatus::Previewing | IngestionStatus::Ocr
            )
        {
            return document;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let document = get_document(app, document_id).await;
    panic!(
        "document did not finish OCR: status={}, error={:?}",
        document.status, document.last_error
    );
}

async fn wait_for_ready(app: &Router, document_id: u64) -> Document {
    for _ in 0..1_200 {
        let document = get_document(app, document_id).await;
        if document.status == IngestionStatus::Ready {
            return document;
        }
        if document.status == IngestionStatus::Failed {
            panic!("ingestion failed: {:?}", document.last_error);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let document = get_document(app, document_id).await;
    panic!("document stopped at {}", document.status);
}

#[tokio::test]
async fn upload_acceptance_does_not_wait_for_processing_capacity() {
    let temporary = tempfile::tempdir().unwrap();
    let app = build_app(config(temporary.path(), start_blocked_agent().await))
        .await
        .unwrap();

    for index in 1..=8 {
        let bytes = unique_png(index);
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            upload(
                &app,
                &format!("queued-{index}.png"),
                "image/png",
                &bytes,
                "",
            ),
        )
        .await
        .unwrap_or_else(|_| panic!("upload {index} waited for processing capacity"));
        assert_eq!(result.0, StatusCode::CREATED);
    }
}
#[tokio::test]
async fn upload_with_embeddings_reaches_ready_and_is_searchable() {
    let temporary = tempfile::tempdir().unwrap();
    let base_url = start_agent_with_text("Recognized page text. ".repeat(150)).await;
    let mut settings = config(temporary.path(), base_url.clone());
    settings.embeddings = Some(EmbeddingConfig {
        base_url: base_url.join("v1").unwrap(),
        model: "google/gemini-embedding-2".into(),
        api_key_env: "PATH".into(),
        max_concurrency: 1,
    });
    let app = build_app(settings).await.unwrap();

    let (status, document) =
        upload(&app, "searchable.png", "image/png", &png(), "Searchable").await;
    assert_eq!(status, StatusCode::CREATED);
    let ready = wait_for_ready(&app, document.document_id).await;
    assert_eq!(ready.status, IngestionStatus::Ready);

    let response = app
        .clone()
        .oneshot(
            Request::post("/api/search")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "query": "recognized page text",
                        "page": 1,
                        "page_size": 10
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let results: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(results["total"], 1);
    assert_eq!(
        results["items"][0]["document"]["document_id"],
        document.document_id
    );
    let passages = results["items"][0]["passages"].as_array().unwrap();
    assert!(!passages.is_empty() && passages.len() <= 3);
    assert_eq!(
        results["items"][0]["best_chunk_id"],
        passages[0]["chunk_id"]
    );

    // The summary is indexed as its own passage; "Kundennr" matches inside "Kundennummer".
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/search")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({"query": "Kundennr", "page": 1, "page_size": 10})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let results: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let passages = results["items"][0]["passages"].as_array().unwrap();
    assert_eq!(passages[0]["kind"], "summary");
    assert_eq!(
        passages[0]["snippet"],
        "Testschreiben mit Kundennummer 4711."
    );
}

#[tokio::test]
async fn agent_search_streams_the_agent_events() {
    const EVENTS: &str = "event: progress\ndata: {\"label\":\"Searching\"}\n\nevent: result\ndata: {\"answer\":null,\"results\":[]}\n\n";
    let agent = Router::new().route(
        "/search",
        post(|Json(body): Json<serde_json::Value>| async move {
            assert_eq!(body["query"], "Beitrag Krankenkasse");
            assert_eq!(body["sender"], "IKK classic");
            ([(header::CONTENT_TYPE, "text/event-stream")], EVENTS)
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, agent).await.unwrap();
    });
    let temporary = tempfile::tempdir().unwrap();
    let settings = config(
        temporary.path(),
        Url::parse(&format!("http://{address}")).unwrap(),
    );
    let app = build_app(settings).await.unwrap();

    let response = app
        .clone()
        .oneshot(
            Request::post("/api/search/agent")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({"query": "Beitrag Krankenkasse", "sender": "IKK classic"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/event-stream"
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body, EVENTS.as_bytes());
}

#[test]
fn old_search_payloads_default_new_fields() {
    let request: paperless_models::SearchRequest = serde_json::from_value(serde_json::json!({
        "query": "invoice",
        "page": 1,
        "page_size": 10
    }))
    .unwrap();

    assert!(!request.exact);
    assert!(request.semantic);
    assert!(request.summaries);

    let response: paperless_models::SearchResponse = serde_json::from_value(serde_json::json!({
        "items": [],
        "page": 1,
        "page_size": 10,
        "total": 0
    }))
    .unwrap();
    assert!(response.items.is_empty());
}

#[tokio::test]
async fn health_upload_duplicate_read_and_image_preview_work() {
    let temporary = tempfile::tempdir().unwrap();
    let app = build_app(config(temporary.path(), start_agent().await))
        .await
        .unwrap();

    let health = app
        .clone()
        .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    let health_json: serde_json::Value =
        serde_json::from_slice(&health.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(health_json["status"], "ok");
    assert_eq!(health_json["embedding_configured"], false);

    let image = png();
    let (status, uploaded) = upload(&app, "scan.png", "image/png", &image, "Original title").await;
    assert_eq!(status, StatusCode::CREATED);
    let ready = wait_for_ocr(&app, uploaded.document_id).await;
    assert_eq!(ready.page_count, 1);

    let (duplicate_status, duplicate) = upload(
        &app,
        "renamed.png",
        "image/png",
        &image,
        "Replacement title",
    )
    .await;
    assert_eq!(duplicate_status, StatusCode::OK);
    assert_eq!(duplicate.document_id, uploaded.document_id);
    assert_eq!(duplicate.title.as_deref(), Some("Original title"));

    let file = app
        .clone()
        .oneshot(
            Request::get(format!("/api/documents/{}/file", uploaded.document_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(file.status(), StatusCode::OK);
    assert_eq!(file.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(
        file.into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        image
    );

    let pages = app
        .clone()
        .oneshot(
            Request::get(format!("/api/documents/{}/pages", uploaded.document_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let pages_json: serde_json::Value =
        serde_json::from_slice(&pages.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(pages_json.as_array().unwrap().len(), 1);
    assert_eq!(pages_json[0]["thumbnail_ready"], true);
    assert_eq!(pages_json[0]["text"], "Recognized page text");
    assert_eq!(pages_json[0]["blocks"][0]["label"], "Text");
    assert_eq!(
        pages_json[0]["blocks"][0]["bbox"],
        serde_json::json!([0, 0, 1000, 1000])
    );
    assert_eq!(pages_json[0]["blocks"][0]["text"], "Recognized page text");

    let thumbnail = app
        .clone()
        .oneshot(
            Request::get(format!(
                "/api/documents/{}/thumbnails/1",
                uploaded.document_id
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(thumbnail.status(), StatusCode::OK);
    assert_eq!(thumbnail.headers()[header::CONTENT_TYPE], "image/webp");
    assert!(
        !thumbnail
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .is_empty()
    );

    let patch = app
        .clone()
        .oneshot(
            Request::patch(format!("/api/documents/{}", uploaded.document_id))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"title":"Edited title","sender":"Acme Corp","created_at":"2025-02-03T00:00:00Z"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(patch.status(), StatusCode::OK);
    let patched: Document =
        serde_json::from_slice(&patch.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(patched.title.as_deref(), Some("Edited title"));
    assert_eq!(
        patched.title_source,
        Some(paperless_models::MetadataSource::Manual)
    );

    let listing = app
        .clone()
        .oneshot(
            Request::get("/api/documents?page=1&page_size=10")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let listing: serde_json::Value =
        serde_json::from_slice(&listing.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(listing["total"], 1);
    assert_eq!(listing["items"][0]["sender"], "Acme Corp");

    for query in ["edited", "acme", "scan.png"] {
        let response = app
            .clone()
            .oneshot(
                Request::get(format!("/api/documents?page=1&page_size=10&query={query}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let result: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(result["total"], 1, "metadata query {query}");
    }

    let no_match = app
        .clone()
        .oneshot(
            Request::get("/api/documents?page=1&page_size=10&query=missing")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let no_match: serde_json::Value =
        serde_json::from_slice(&no_match.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(no_match["total"], 0);

    let senders = app
        .clone()
        .oneshot(Request::get("/api/senders").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let senders: serde_json::Value =
        serde_json::from_slice(&senders.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(senders, serde_json::json!(["Acme Corp"]));

    let deleted = app
        .clone()
        .oneshot(
            Request::delete(format!("/api/documents/{}", uploaded.document_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    let missing = app
        .clone()
        .oneshot(
            Request::get(format!("/api/documents/{}", uploaded.document_id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let object_path = DataLayout::create(temporary.path())
        .await
        .unwrap()
        .object_path(&uploaded.content_hash);
    for _ in 0..100 {
        if !object_path.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!object_path.exists());
}

#[tokio::test]
async fn document_assets_revalidate_and_send_their_exact_lengths() {
    let temporary = tempfile::tempdir().unwrap();
    let app = build_app(config(temporary.path(), start_agent().await))
        .await
        .unwrap();
    let (_, uploaded) = upload(&app, "scan.png", "image/png", &png(), "Scan").await;
    wait_for_ocr(&app, uploaded.document_id).await;

    let mut original_etag = None;
    for asset in ["file", "thumbnails/1", "pages/1/image"] {
        let path = format!("/api/documents/{}/{asset}", uploaded.document_id);
        let response = app
            .clone()
            .oneshot(Request::get(&path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{asset}");
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-cache"
        );
        let etag = response.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .to_owned();
        let length: usize = response.headers()[header::CONTENT_LENGTH]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.len(), length, "{asset}");

        // A star inside an opaque entity tag is ordinary data.
        let stale = app
            .clone()
            .oneshot(
                Request::get(&path)
                    .header(header::IF_NONE_MATCH, "\"old,*,tag\"")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale.status(), StatusCode::OK, "{asset}");

        let weak_match = format!("W/{}", etag.trim_start_matches("W/"));
        let response = app
            .clone()
            .oneshot(
                Request::get(&path)
                    .header(header::IF_NONE_MATCH, format!("\"old,tag\", {weak_match}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED, "{asset}");
        assert_eq!(response.headers()[header::ETAG], etag);
        assert!(
            response
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty()
        );

        if asset == "file" {
            original_etag = Some(etag);
        }
    }

    let document = format!("/api/documents/{}", uploaded.document_id);
    let deleted = app
        .clone()
        .oneshot(Request::delete(&document).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    let response = app
        .oneshot(
            Request::get(format!("{document}/file"))
                .header(header::IF_NONE_MATCH, original_etag.unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn startup_resumes_a_stored_image() {
    let temporary = tempfile::tempdir().unwrap();
    let layout = DataLayout::create(temporary.path()).await.unwrap();
    let repository = DocumentRepository::open(&layout).await.unwrap();
    let object = ObjectStore::new(layout)
        .store(png().as_slice())
        .await
        .unwrap();
    let now = Utc::now();
    let document = Document {
        document_id: repository.allocate_id(),
        content_hash: object.content_hash,
        media_type: MediaType::Image,
        filename: "interrupted.png".into(),
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
        summary: None,
    };
    repository.insert(&document).await.unwrap();
    drop(repository);

    let app = build_app(config(temporary.path(), start_agent().await))
        .await
        .unwrap();
    let resumed = wait_for_ocr(&app, document.document_id).await;
    assert_eq!(resumed.page_count, 1);
}

#[tokio::test]
async fn startup_resumes_an_image_at_the_ocr_stage() {
    let temporary = tempfile::tempdir().unwrap();
    let layout = DataLayout::create(temporary.path()).await.unwrap();
    let repository = DocumentRepository::open(&layout).await.unwrap();
    let object = ObjectStore::new(layout)
        .store(png().as_slice())
        .await
        .unwrap();
    let now = Utc::now();
    let document = Document {
        document_id: repository.allocate_id(),
        content_hash: object.content_hash,
        media_type: MediaType::Image,
        filename: "waiting-for-ocr.png".into(),
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
        status: IngestionStatus::Ocr,
        last_error: None,
        retry_count: 0,
        deleted_at: None,
        summary: None,
    };
    repository.insert(&document).await.unwrap();
    drop(repository);

    let app = build_app(config(temporary.path(), start_agent().await))
        .await
        .unwrap();
    let resumed = wait_for_ocr(&app, document.document_id).await;
    assert_eq!(resumed.page_count, 1);
}

#[tokio::test]
async fn startup_finishes_an_interrupted_index_commit() {
    let temporary = tempfile::tempdir().unwrap();
    let layout = DataLayout::create(temporary.path()).await.unwrap();
    let repository = DocumentRepository::open(&layout).await.unwrap();
    let now = Utc::now();
    let document = Document {
        document_id: repository.allocate_id(),
        content_hash: [9; 32],
        media_type: MediaType::Image,
        filename: "indexed.png".into(),
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
        status: IngestionStatus::Indexing,
        last_error: None,
        retry_count: 0,
        deleted_at: None,
        summary: None,
    };
    repository.insert(&document).await.unwrap();
    drop(repository);

    let app = build_app(config(temporary.path(), start_agent().await))
        .await
        .unwrap();
    for _ in 0..100 {
        if get_document(&app, document.document_id).await.status == IngestionStatus::Ready {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("document did not finish INDEXING recovery");
}

#[tokio::test]
async fn startup_repeats_deleted_object_cleanup_safely() {
    let temporary = tempfile::tempdir().unwrap();
    let layout = DataLayout::create(temporary.path()).await.unwrap();
    let repository = DocumentRepository::open(&layout).await.unwrap();
    let stored = ObjectStore::new(layout.clone())
        .store(png().as_slice())
        .await
        .unwrap();
    let object_path = layout.object_path(&stored.content_hash);
    let now = Utc::now();
    let document = Document {
        document_id: repository.allocate_id(),
        content_hash: stored.content_hash,
        media_type: MediaType::Image,
        filename: "deleted.png".into(),
        title: None,
        sender: None,
        created_at: None,
        added_at: now,
        updated_at: now,
        title_source: None,
        sender_source: None,
        created_at_source: None,
        page_count: 1,
        file_size: stored.file_size,
        status: IngestionStatus::Ready,
        last_error: None,
        retry_count: 0,
        deleted_at: Some(now),
        summary: None,
    };
    repository.insert(&document).await.unwrap();
    drop(repository);

    let app = build_app(config(temporary.path(), start_agent().await))
        .await
        .unwrap();
    for _ in 0..100 {
        if !object_path.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!object_path.exists());
    drop(app);

    let _ = build_app(config(temporary.path(), start_agent().await))
        .await
        .unwrap();
    assert!(!object_path.exists());
}

#[tokio::test]
async fn pdf_upload_generates_pages_and_thumbnail() {
    let temporary = tempfile::tempdir().unwrap();
    let app = build_app(config(temporary.path(), start_agent().await))
        .await
        .unwrap();
    let pdf = one_page_pdf();
    let (status, uploaded) =
        upload(&app, "one-page.pdf", "application/pdf", &pdf, "Blank PDF").await;
    assert_eq!(status, StatusCode::CREATED);
    let ready = wait_for_ocr(&app, uploaded.document_id).await;
    assert_eq!(ready.media_type, MediaType::Pdf);
    assert_eq!(ready.page_count, 1);
}

async fn post_scan(app: &Router, request: serde_json::Value) -> (StatusCode, String) {
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/scan")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(request.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

/// The data of the stream's last event, which must be `event`.
fn last_event(stream: &str, event: &str) -> serde_json::Value {
    let block = stream.trim_end().rsplit("\n\n").next().unwrap();
    let (name, data) = block.split_once('\n').unwrap();
    assert_eq!(name, format!("event: {event}"), "stream: {stream}");
    serde_json::from_str(data.strip_prefix("data: ").unwrap()).unwrap()
}

async fn app_with_scanner(data_dir: &Path, setup: FakeSetup) -> (Router, FakeScanner) {
    let fake = FakeScanner::start(setup).await;
    let mut settings = config(data_dir, start_agent().await);
    settings.scanner = Some(ScannerConfig {
        host: "127.0.0.1".into(),
        port: fake.port(),
    });
    (build_app(settings).await.unwrap(), fake)
}

#[tokio::test]
async fn scan_streams_progress_and_adds_the_stack_as_one_pdf() {
    let temporary = tempfile::tempdir().unwrap();
    let (app, _fake) = app_with_scanner(
        temporary.path(),
        FakeSetup {
            feeder_sheets: 2,
            ..FakeSetup::default()
        },
    )
    .await;

    let response = app
        .clone()
        .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let health: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(health["scanner_configured"], true);

    let (status, stream) = post_scan(
        &app,
        serde_json::json!({"source": "feeder", "mode": "gray", "dpi": 150}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        stream.starts_with(
            "event: progress\ndata: {\"pages\":1}\n\nevent: progress\ndata: {\"pages\":2}\n\n"
        ),
        "{stream}"
    );
    let result = last_event(&stream, "result");
    assert_eq!(result["pages"], 2);
    let document_id = result["document"]["document_id"].as_u64().unwrap();
    let document = wait_for_ocr(&app, document_id).await;
    assert_eq!(document.media_type, MediaType::Pdf);
    assert_eq!(document.page_count, 2);
    assert!(document.filename.starts_with("Scan ") && document.filename.ends_with(".pdf"));
}

#[tokio::test]
async fn duplex_scan_adds_both_sides_of_each_feeder_sheet() {
    let temporary = tempfile::tempdir().unwrap();
    let (app, fake) = app_with_scanner(
        temporary.path(),
        FakeSetup {
            feeder_sheets: 2,
            ..FakeSetup::default()
        },
    )
    .await;

    let (status, stream) = post_scan(
        &app,
        serde_json::json!({"source": "feeder", "mode": "gray", "dpi": 150, "duplex": true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fake.window().unwrap()[19], 0x10);
    let result = last_event(&stream, "result");
    assert_eq!(result["pages"], 4);
    let document_id = result["document"]["document_id"].as_u64().unwrap();
    let document = wait_for_ocr(&app, document_id).await;
    assert_eq!(document.media_type, MediaType::Pdf);
    assert_eq!(document.page_count, 4);
}

#[tokio::test]
async fn scan_reports_scanner_problems_and_rejects_bad_requests() {
    let temporary = tempfile::tempdir().unwrap();
    let (app, _fake) = app_with_scanner(temporary.path(), FakeSetup::default()).await;

    let (status, stream) = post_scan(&app, serde_json::json!({"source": "feeder"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        last_event(&stream, "error")["message"],
        "There is no paper in the feeder."
    );

    let (status, _) = post_scan(&app, serde_json::json!({"dpi": 1200})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let unconfigured = build_app(config(
        temporary.path().join("other").as_path(),
        start_agent().await,
    ))
    .await
    .unwrap();
    let (status, _) = post_scan(&unconfigured, serde_json::json!({})).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

fn one_page_pdf() -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
        "<< /Length 0 >>\nstream\n\nendstream",
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref = pdf.len();
    pdf.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    pdf
}
