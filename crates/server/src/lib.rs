mod config;
mod routes;

use std::sync::Arc;

use anyhow::Result;
use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use paperless_embeddings::EmbeddingService;
use paperless_ingest::{CleanupQueue, IngestionQueue, MetadataService, PreviewService};
use paperless_ocr_client::OcrClient;
use paperless_search::ChunkRepository;
use paperless_storage::{DataLayout, DocumentRepository, ObjectStore, PageRepository};
use tokio::sync::Mutex;
use tower_http::{
    catch_panic::CatchPanicLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

pub use config::{AppConfig, EmbeddingConfig};
pub use routes::AppError;

#[derive(Clone)]
pub struct AppState {
    pub layout: DataLayout,
    pub documents: DocumentRepository,
    pub pages: PageRepository,
    pub chunks: ChunkRepository,
    pub objects: ObjectStore,
    pub previews: PreviewService,
    pub ingestion: IngestionQueue,
    pub cleanup: CleanupQueue,
    pub metadata: MetadataService,
    pub embeddings: Option<EmbeddingService>,
    pub ocr: OcrClient,
    pub upload_commit: Arc<Mutex<()>>,
}

pub async fn build_app(config: AppConfig) -> Result<Router> {
    config.check()?;
    let layout = DataLayout::create(&config.data_dir).await?;
    let documents = DocumentRepository::open(&layout).await?;
    let pages = PageRepository::open(&layout).await?;
    let chunks = ChunkRepository::open(&layout.lance).await?;
    let objects = ObjectStore::new(layout.clone());
    let previews = PreviewService::new(
        layout.clone(),
        config.render_concurrency,
        config.eager_thumbnail_pages,
        config.ocr.pages_per_request,
    )?;
    let embeddings = match &config.embeddings {
        Some(embedding) => {
            Some(EmbeddingService::load(&embedding.model_dir, embedding.max_concurrency).await?)
        }
        None => None,
    };
    let ocr = OcrClient::from_environment(config.ocr)?;
    let ingestion = IngestionQueue::start(
        documents.clone(),
        pages.clone(),
        chunks.clone(),
        previews.clone(),
        ocr.clone(),
        embeddings.clone(),
        config.queue_capacity,
        config.render_concurrency,
    )
    .await?;
    let cleanup = CleanupQueue::start(
        documents.clone(),
        pages.clone(),
        chunks.clone(),
        objects.clone(),
        layout.clone(),
        config.queue_capacity,
        1,
    )
    .await?;
    let metadata = MetadataService::new(documents.clone(), chunks.clone());
    let state = AppState {
        layout,
        documents,
        pages,
        chunks,
        objects,
        previews,
        ingestion,
        cleanup,
        metadata,
        embeddings,
        ocr,
        upload_commit: Arc::new(Mutex::new(())),
    };

    Ok(Router::new()
        .route("/api/health", get(routes::health))
        .route(
            "/api/documents",
            post(routes::upload_document).get(routes::list_documents),
        )
        .route(
            "/api/documents/{id}",
            get(routes::get_document)
                .patch(routes::patch_document)
                .delete(routes::delete_document),
        )
        .route("/api/documents/{id}/file", get(routes::get_file))
        .route("/api/documents/{id}/pages", get(routes::get_pages))
        .route(
            "/api/documents/{id}/thumbnails/{page}",
            get(routes::get_thumbnail),
        )
        .route("/api/documents/{id}/retry", post(routes::retry_document))
        .route("/api/search", post(routes::search))
        .route("/api/document-types", get(routes::document_types))
        .route("/api/openapi.json", get(routes::openapi))
        .fallback_service(ServeDir::new("web/dist").fallback(ServeFile::new("web/dist/index.html")))
        .layer(DefaultBodyLimit::disable())
        .layer(CatchPanicLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state))
}
