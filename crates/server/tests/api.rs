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
use paperless_ocr_client::OcrConfig;
use paperless_server::{AppConfig, build_app};
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
        ocr: OcrConfig {
            base_url,
            model: "datalab-to/surya-ocr-2".into(),
            api_key_env: "PATH".into(),
            max_concurrency: 2,
            pages_per_request: 4,
        },
    }
}

async fn start_ocr() -> Url {
    let app = Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            Json(serde_json::json!({
                "choices": [{
                    "message": {
                        "content": "<div data-label=\"Text\" data-bbox=\"0 0 1000 1000\"><p>Recognized page text</p></div>"
                    }
                }]
            }))
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

async fn wait_for_text_ready(app: &Router, document_id: u64) -> Document {
    for _ in 0..200 {
        let document = get_document(app, document_id).await;
        if document.status == IngestionStatus::TextReady {
            return document;
        }
        if document.status == IngestionStatus::Failed {
            panic!("ingestion failed: {:?}", document.last_error);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("document did not reach TEXT_READY");
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

    let image = png();
    let (status, uploaded) = upload(&app, "scan.png", "image/png", &image, "Original title").await;
    assert_eq!(status, StatusCode::CREATED);
    let ready = wait_for_text_ready(&app, uploaded.document_id).await;
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
    drop(repository);

    let app = build_app(config(temporary.path(), start_ocr().await))
        .await
        .unwrap();
    let resumed = wait_for_text_ready(&app, document.document_id).await;
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
        document_type: None,
        created_at: None,
        added_at: now,
        updated_at: now,
        title_source: None,
        type_source: None,
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
    let resumed = wait_for_text_ready(&app, document.document_id).await;
    assert_eq!(resumed.page_count, 1);
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
    let ready = wait_for_text_ready(&app, uploaded.document_id).await;
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
