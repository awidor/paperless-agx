mod config;
mod routes;

use std::sync::Arc;

use anyhow::Result;
use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use paperless_ingest::{IngestionQueue, PreviewService};
use paperless_ocr_client::OcrClient;
use paperless_storage::{DataLayout, DocumentRepository, ObjectStore};
use tokio::sync::Mutex;
use tower_http::{catch_panic::CatchPanicLayer, trace::TraceLayer};

pub use config::AppConfig;
pub use routes::AppError;

#[derive(Clone)]
pub struct AppState {
    pub layout: DataLayout,
    pub documents: DocumentRepository,
    pub objects: ObjectStore,
    pub previews: PreviewService,
    pub ingestion: IngestionQueue,
    pub ocr: OcrClient,
    pub upload_commit: Arc<Mutex<()>>,
}

pub async fn build_app(config: AppConfig) -> Result<Router> {
    config.check()?;
    let layout = DataLayout::create(&config.data_dir).await?;
    let documents = DocumentRepository::open(&layout).await?;
    let objects = ObjectStore::new(layout.clone());
    let previews = PreviewService::new(
        layout.clone(),
        config.render_concurrency,
        config.eager_thumbnail_pages,
        config.ocr.pages_per_request,
    )?;
    let ocr = OcrClient::from_environment(config.ocr)?;
    let ingestion = IngestionQueue::start(
        documents.clone(),
        previews.clone(),
        config.queue_capacity,
        config.render_concurrency,
        2,
    )
    .await?;
    let state = AppState {
        layout,
        documents,
        objects,
        previews,
        ingestion,
        ocr,
        upload_commit: Arc::new(Mutex::new(())),
    };

    Ok(Router::new()
        .route("/api/health", get(routes::health))
        .route(
            "/api/documents",
            post(routes::upload_document).get(routes::list_documents),
        )
        .route("/api/documents/{id}", get(routes::get_document))
        .route("/api/documents/{id}/file", get(routes::get_file))
        .route("/api/documents/{id}/pages", get(routes::get_pages))
        .route(
            "/api/documents/{id}/thumbnails/{page}",
            get(routes::get_thumbnail),
        )
        .route("/api/documents/{id}/retry", post(routes::retry_document))
        .layer(DefaultBodyLimit::disable())
        .layer(CatchPanicLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state))
}
