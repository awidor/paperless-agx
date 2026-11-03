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
use paperless_ingest::{
    CleanupQueue, IngestionQueue, MetadataService, PreviewService, backfill_summaries,
    embed_pending_chunks,
};
use paperless_models::IngestionStatus;
use paperless_ocr_client::OcrClient;
use paperless_storage::{
    ChunkRepository, DataLayout, DocumentRepository, ObjectStore, PageRepository,
};
use tokio::sync::Mutex;
use tower_http::{
    catch_panic::CatchPanicLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::{error, info, warn};

pub use config::{AgentConfig, AppConfig, EmbeddingConfig};
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
    pub embedding_model: String,
    pub ocr: OcrClient,
    pub agent: Option<routes::AgentProxy>,
    pub upload_commit: Arc<Mutex<()>>,
}

pub async fn build_app(config: AppConfig) -> Result<Router> {
    config.check()?;
    let layout = DataLayout::create(&config.data_dir).await?;
    let documents = DocumentRepository::open(&layout).await?;
    let pages = PageRepository::open(&layout).await?;
    let chunks = ChunkRepository::open(&layout).await?;
    for document_id in pages.documents_missing_layout().await? {
        let Some(document) = documents.get(document_id).await? else {
            continue;
        };
        if document.deleted_at.is_none()
            && !matches!(
                document.status,
                IngestionStatus::Stored
                    | IngestionStatus::Previewing
                    | IngestionStatus::Ocr
                    | IngestionStatus::Failed
            )
        {
            documents
                .set_status(document_id, IngestionStatus::Ocr, None)
                .await?;
        }
    }
    let objects = ObjectStore::new(layout.clone());
    let previews = PreviewService::new(
        layout.clone(),
        config.render_concurrency,
        config.eager_thumbnail_pages,
        config.ocr.pages_per_request,
        config.ocr.dpi,
    )?;
    let embedding_model = config
        .embeddings
        .as_ref()
        .map(|embedding| embedding.model.clone())
        .unwrap_or_default();
    let embeddings = match &config.embeddings {
        Some(embedding) => match EmbeddingService::from_environment(
            embedding.base_url.as_str(),
            embedding.model.clone(),
            &embedding.api_key_env,
            embedding.max_concurrency,
        ) {
            Ok(service) => Some(service),
            Err(error) => {
                warn!(error = %format!("{error:#}"), "embeddings disabled; search and new uploads need them");
                None
            }
        },
        None => None,
    };
    if let Some(service) = &embeddings {
        let cleared = chunks.reset_vector_space(&service.vector_space()).await?;
        if cleared > 0 {
            info!(cleared, vector_space = %service.vector_space(), "embedding model changed; re-embedding stored chunks");
        }
    }
    let ocr = OcrClient::from_environment(config.ocr, config.llm)?;
    let agent = config
        .agent
        .as_ref()
        .map(routes::AgentProxy::new)
        .transpose()?;
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
    if let Some(service) = &embeddings {
        let (documents, pages, chunks, metadata, ocr, service) = (
            documents.clone(),
            pages.clone(),
            chunks.clone(),
            metadata.clone(),
            ocr.clone(),
            service.clone(),
        );
        tokio::spawn(async move {
            match backfill_summaries(&documents, &pages, &metadata, &ocr).await {
                Ok(0) => {}
                Ok(count) => info!(count, "summarized documents"),
                Err(error) => error!(error = %format!("{error:#}"), "summarize documents"),
            }
            match embed_pending_chunks(&chunks, &service).await {
                Ok(0) => {}
                Ok(count) => info!(count, "embedded stored chunks"),
                Err(error) => error!(error = %format!("{error:#}"), "embed stored chunks"),
            }
        });
    }
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
        embedding_model,
        ocr,
        agent,
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
        .route(
            "/api/documents/{id}/pages/{page}/image",
            get(routes::get_page_image),
        )
        .route("/api/documents/{id}/retry", post(routes::retry_document))
        .route(
            "/api/documents/{id}/infer-metadata",
            post(routes::infer_document_metadata),
        )
        .route("/api/search", post(routes::search))
        .route("/api/search/agent", post(routes::agent_search))
        .route("/api/senders", get(routes::senders))
        .route("/api/openapi.json", get(routes::openapi))
        .fallback_service(ServeDir::new("web/dist").fallback(ServeFile::new("web/dist/index.html")))
        .layer(DefaultBodyLimit::disable())
        .layer(CatchPanicLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state))
}
