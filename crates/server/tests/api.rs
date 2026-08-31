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
use paperless_ocr_client::{LlmConfig, OcrConfig};
use paperless_server::{AppConfig, EmbeddingConfig, build_app};
use paperless_storage::{DataLayout, DocumentRepository, ObjectStore};
use tower::ServiceExt;
use url::Url;

fn config(data_dir: &Path, base_url: Url) -> AppConfig {
    AppConfig {
        data_dir: data_dir.to_path_buf(),
        listen_addr: "0.0.0.0:0".parse().unwrap(),
        queue_capacity: 4,
        render_concurrency: 2,
        eager_thumbnail_pages: 3,
        embeddings: None,
        llm: LlmConfig {
            base_url: base_url.clone(),
            model: "z-ai/glm-5.3-flash".into(),
            api_key_env: "PATH".into(),
            max_concurrency: 1,
        },
        ocr: OcrConfig {
            base_url,
            model: "google/gemini-3.7-flash".into(),
            api_key_env: "PATH".into(),
            max_concurrency: 2,
            pages_per_request: 4,
            max_output_tokens: 16_384,
        },
    }
}

async fn start_ocr() -> Url {
    start_ocr_with_text("Recognized page text".into()).await
}

async fn start_blocked_ocr() -> Url {
    let app = Router::new().route(
        "/v1/chat/completions",
        post(|| async { std::future::pending::<String>().await }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Url::parse(&format!("http://{address}/v1")).unwrap()
}

async fn start_ocr_with_text(text: String) -> Url {
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |Json(body): Json<serde_json::Value>| {
            let text = text.clone();
            async move {
                let content = body["messages"][0]["content"].as_array();
                let is_ocr = content
                    .is_some_and(|items| items.iter().any(|item| item["type"] == "image_url"));
                let is_answer = content.is_some_and(|items| {
                    items.iter().any(|item| {
                        item["text"]
                            .as_str()
                            .is_some_and(|text| text.contains("numbered evidence passages"))
                    })
                });
                let content = if is_ocr {
                    serde_json::json!({
                        "blocks": [{
                            "label": "Text",
                            "bbox": {"x0": 0, "y0": 0, "x1": 1000, "y1": 1000},
                            "html": format!("<p>{text}</p>")
                        }]
                    })
                    .to_string()
                } else if is_answer {
                    serde_json::json!({
                        "answer": "The page contains recognized text.",
                        "citations": [1]
                    })
                    .to_string()
                } else {
                    serde_json::json!({
                        "title": "Extracted title",
                        "created_at": null
                    })
                    .to_string()
                };
                Json(serde_json::json!({
                    "choices": [{"message": {"content": content}}]
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Url::parse(&format!("http://{address}/v1")).unwrap()
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
    let app = build_app(config(temporary.path(), start_blocked_ocr().await))
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
    let Some(model_dir) =
        std::env::var_os("PAPERLESS_HARRIER_MODEL_DIR").map(std::path::PathBuf::from)
    else {
        eprintln!("PAPERLESS_HARRIER_MODEL_DIR is not set; skipping embedding E2E test");
        return;
    };
    let temporary = tempfile::tempdir().unwrap();
    let mut settings = config(
        temporary.path(),
        start_ocr_with_text("Recognized page text. ".repeat(150)).await,
    );
    settings.embeddings = Some(EmbeddingConfig {
        model_dir,
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
    let chunk_id = passages[0]["chunk_id"].as_u64().unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/search/answer")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "query": "What does the page contain?",
                        "chunk_ids": [chunk_id]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let answer: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(answer["answer"], "The page contains recognized text.");
    assert_eq!(answer["citations"], serde_json::json!([chunk_id]));
}

#[tokio::test]
async fn answer_search_rejects_invalid_questions_and_chunk_lists() {
    let temporary = tempfile::tempdir().unwrap();
    let app = build_app(config(temporary.path(), start_ocr().await))
        .await
        .unwrap();

    for body in [
        serde_json::json!({"query": " ", "chunk_ids": [1]}),
        serde_json::json!({"query": "invoice total", "chunk_ids": []}),
        serde_json::json!({"query": "invoice total", "chunk_ids": [1, 1]}),
        serde_json::json!({"query": "invoice total", "chunk_ids": (1..=13).collect::<Vec<_>>()}),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/search/answer")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[test]
fn old_search_payloads_default_new_fields() {
    let request: paperless_models::SearchRequest = serde_json::from_value(serde_json::json!({
        "query": "invoice",
        "page": 1,
        "page_size": 10,
        "sender": null,
        "created_from": null,
        "created_to": null
    }))
    .unwrap();

    assert!(!request.skip_inferred_sender);
    assert!(!request.skip_inferred_dates);

    let response: paperless_models::SearchResponse = serde_json::from_value(serde_json::json!({
        "items": [],
        "page": 1,
        "page_size": 10,
        "total": 0
    }))
    .unwrap();
    assert_eq!(response.interpretation, Default::default());
}

#[tokio::test]
async fn health_upload_duplicate_read_and_image_preview_work() {
    let temporary = tempfile::tempdir().unwrap();
    let app = build_app(config(temporary.path(), start_ocr().await))
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
    assert_eq!(health_json["ocr_configured"], true);
    assert_eq!(health_json["metadata_model"], "z-ai/glm-5.3-flash");

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
    };
    repository.insert(&document).await.unwrap();
    drop(repository);

    let app = build_app(config(temporary.path(), start_ocr().await))
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
    };
    repository.insert(&document).await.unwrap();
    drop(repository);

    let app = build_app(config(temporary.path(), start_ocr().await))
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
    };
    repository.insert(&document).await.unwrap();
    drop(repository);

    let app = build_app(config(temporary.path(), start_ocr().await))
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
    };
    repository.insert(&document).await.unwrap();
    drop(repository);

    let app = build_app(config(temporary.path(), start_ocr().await))
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

    let _ = build_app(config(temporary.path(), start_ocr().await))
        .await
        .unwrap();
    assert!(!object_path.exists());
}

#[tokio::test]
async fn pdf_upload_generates_pages_and_thumbnail() {
    let temporary = tempfile::tempdir().unwrap();
    let app = build_app(config(temporary.path(), start_ocr().await))
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
