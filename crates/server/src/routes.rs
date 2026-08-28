use std::io;

use anyhow::{Context, Result};
use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use paperless_models::{
    Document, DocumentPageResult, DocumentPatch, DocumentQuery, DocumentSort, HealthResponse,
    IngestionStatus, MediaType, MetadataSource, PageInfo, SearchHit, SearchRequest, SearchResponse,
    UploadMetadata,
};
use paperless_search::{RankedChunk, collapse_to_documents, reciprocal_rank_fusion};
use paperless_storage::StoredObject;
use tokio::io::AsyncReadExt;
use tokio_util::io::{ReaderStream, StreamReader};

use crate::AppState;

pub async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        ocr_configured: true,
        ocr_base_url: state.ocr.config().base_url.to_string(),
        ocr_model: state.ocr.config().model.clone(),
        metadata_model: state.ocr.metadata_model().to_owned(),
        embedding_configured: state.embeddings.is_some(),
        embedding_model: paperless_embeddings::HARRIER_MODEL_ID,
    })
}

pub async fn upload_document(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    let mut filename = None;
    let mut title = None;
    let mut created_at = None;
    let mut stored = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| AppError::bad_request(error.into()))?
    {
        let name = field.name().unwrap_or_default().to_owned();
        match name.as_str() {
            "file" => {
                if stored.is_some() {
                    return Err(AppError::bad_request(anyhow::anyhow!(
                        "upload must contain exactly one file"
                    )));
                }
                filename = Some(field.file_name().unwrap_or("upload").to_owned());
                let stream = field.map_err(io::Error::other);
                let reader = StreamReader::new(stream);
                stored = Some(state.objects.store(reader).await?);
            }
            "title" => {
                title = nonempty(
                    field
                        .text()
                        .await
                        .map_err(|error| AppError::bad_request(error.into()))?,
                );
            }
            "created_at" => {
                let value = field
                    .text()
                    .await
                    .map_err(|error| AppError::bad_request(error.into()))?;
                created_at = nonempty(value)
                    .map(|value| {
                        DateTime::parse_from_rfc3339(&value).map(|value| value.with_timezone(&Utc))
                    })
                    .transpose()
                    .map_err(|error| AppError::bad_request(error.into()))?;
            }
            _ => {}
        }
    }

    let stored =
        stored.ok_or_else(|| AppError::bad_request(anyhow::anyhow!("missing file field")))?;
    if stored.file_size == 0 {
        remove_unreferenced_object(&stored).await;
        return Err(AppError::bad_request(anyhow::anyhow!(
            "uploaded file is empty"
        )));
    }
    let media_type = match detect_media_type(&stored.prefix) {
        Ok(media_type) => media_type,
        Err(error) => {
            remove_unreferenced_object(&stored).await;
            return Err(AppError::bad_request(error));
        }
    };
    let metadata = UploadMetadata {
        filename: filename.unwrap_or_else(|| "upload".into()),
        title,
        created_at,
    };

    let _commit = state.upload_commit.lock().await;
    if let Some(existing) = state.documents.find_by_hash(&stored.content_hash).await? {
        let merged = state
            .documents
            .merge_missing_upload_metadata(&existing, &metadata)
            .await?;
        return Ok((StatusCode::OK, Json(merged)));
    }

    let now = Utc::now();
    let document = Document {
        document_id: state.documents.allocate_id(),
        content_hash: stored.content_hash,
        media_type,
        filename: metadata.filename,
        title_source: metadata.title.as_ref().map(|_| MetadataSource::Manual),
        created_at_source: metadata.created_at.map(|_| MetadataSource::Manual),
        sender_source: None,
        title: metadata.title,
        sender: None,
        created_at: metadata.created_at,
        added_at: now,
        updated_at: now,
        page_count: 0,
        file_size: stored.file_size,
        status: IngestionStatus::Stored,
        last_error: None,
        retry_count: 0,
        deleted_at: None,
    };
    state.documents.insert(&document).await?;
    state.ingestion.enqueue(document.document_id).await?;
    Ok((StatusCode::CREATED, Json(document)))
}

pub async fn list_documents(
    State(state): State<AppState>,
    Query(query): Query<DocumentQuery>,
) -> Result<Json<DocumentPageResult>, AppError> {
    if query.page == 0 || !(1..=100).contains(&query.page_size) {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "page must start at one and page_size must be between 1 and 100"
        )));
    }
    let mut documents = state
        .documents
        .list_active()
        .await?
        .into_iter()
        .filter(|document| {
            query
                .sender
                .as_ref()
                .is_none_or(|value| document.sender.as_ref() == Some(value))
                && query
                    .created_from
                    .is_none_or(|date| document.created_at.is_some_and(|value| value >= date))
                && query
                    .created_to
                    .is_none_or(|date| document.created_at.is_some_and(|value| value <= date))
        })
        .collect::<Vec<_>>();
    sort_documents(&mut documents, query.sort);
    let total = documents.len() as u64;
    let start = ((query.page - 1) * query.page_size) as usize;
    let items = documents
        .into_iter()
        .skip(start)
        .take(query.page_size as usize)
        .collect();
    Ok(Json(DocumentPageResult {
        items,
        page: query.page,
        page_size: query.page_size,
        total,
    }))
}

pub async fn get_document(
    State(state): State<AppState>,
    Path(document_id): Path<u64>,
) -> Result<Json<Document>, AppError> {
    Ok(Json(active_document(&state, document_id).await?))
}

pub async fn patch_document(
    State(state): State<AppState>,
    Path(document_id): Path<u64>,
    Json(patch): Json<DocumentPatch>,
) -> Result<Json<Document>, AppError> {
    active_document(&state, document_id).await?;
    state
        .metadata
        .apply_manual(document_id, patch)
        .await
        .map(Json)
        .map_err(AppError::bad_request)
}

pub async fn delete_document(
    State(state): State<AppState>,
    Path(document_id): Path<u64>,
) -> Result<StatusCode, AppError> {
    active_document(&state, document_id).await?;
    state.documents.soft_delete(document_id).await?;
    state.cleanup.enqueue(document_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn senders(State(state): State<AppState>) -> Result<Json<Vec<String>>, AppError> {
    Ok(Json(state.documents.senders().await?))
}

pub async fn search(
    State(state): State<AppState>,
    Json(request): Json<SearchRequest>,
) -> Result<Json<SearchResponse>, AppError> {
    if request.query.trim().is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "search query must not be empty"
        )));
    }
    if request.page == 0 || !(1..=100).contains(&request.page_size) {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "page must start at one and page_size must be between 1 and 100"
        )));
    }
    let embeddings = state.embeddings.as_ref().ok_or_else(|| {
        AppError::service_unavailable(anyhow::anyhow!("embedding model is not configured"))
    })?;
    let query_embedding = embeddings
        .embed_query(request.query.trim().to_owned())
        .await?;
    let filter = search_filter(&request);
    let lexical = state
        .chunks
        .lexical_candidates(&request.query, filter.as_deref(), 50)
        .await?;
    let vector = state
        .chunks
        .vector_candidates(&query_embedding, filter.as_deref(), 50)
        .await?;
    let ranked = |matches: Vec<paperless_search::ChunkMatch>| {
        matches
            .into_iter()
            .map(|candidate| RankedChunk {
                chunk_id: candidate.chunk.chunk_id,
                document_id: candidate.chunk.document_id,
                rank: candidate.rank,
                score: candidate.score,
            })
            .collect::<Vec<_>>()
    };
    let fused = reciprocal_rank_fusion(&ranked(lexical), &ranked(vector), 60.0);
    let ranked_documents = collapse_to_documents(&fused);
    let mut documents = Vec::with_capacity(ranked_documents.len());
    for hit in ranked_documents {
        let Some(document) = state.documents.get(hit.document_id).await? else {
            continue;
        };
        if document.deleted_at.is_none() {
            documents.push((hit, document));
        }
    }
    let total = documents.len() as u64;
    let start = ((request.page - 1) * request.page_size) as usize;
    let mut items = Vec::new();
    for (hit, document) in documents
        .into_iter()
        .skip(start)
        .take(request.page_size as usize)
    {
        let Some(chunk) = state.chunks.get(hit.best_chunk_id).await? else {
            continue;
        };
        items.push(SearchHit {
            document,
            best_chunk_id: chunk.chunk_id,
            page: chunk.page_start,
            snippet: chunk.text,
            score: hit.score,
        });
    }
    Ok(Json(SearchResponse {
        items,
        page: request.page,
        page_size: request.page_size,
        total,
    }))
}

pub async fn openapi() -> Json<serde_json::Value> {
    Json(
        serde_json::from_str(include_str!("../../../openapi.json"))
            .expect("committed OpenAPI schema must be valid JSON"),
    )
}

pub async fn get_file(
    State(state): State<AppState>,
    Path(document_id): Path<u64>,
) -> Result<Response, AppError> {
    let document = active_document(&state, document_id).await?;
    stream_file(
        state.objects.path(&document.content_hash),
        match document.media_type {
            MediaType::Pdf => "application/pdf",
            MediaType::Image => {
                image_mime_from_path(&state.objects.path(&document.content_hash)).await?
            }
        },
    )
    .await
}

pub async fn get_pages(
    State(state): State<AppState>,
    Path(document_id): Path<u64>,
) -> Result<Json<Vec<PageInfo>>, AppError> {
    let document = active_document(&state, document_id).await?;
    let stored_pages: std::collections::HashMap<_, _> = state
        .pages
        .list(document_id)
        .await?
        .into_iter()
        .map(|page| (page.page, page))
        .collect();
    let pages = (1..=document.page_count)
        .map(|page| PageInfo {
            page,
            thumbnail_ready: state
                .layout
                .thumbnail_path(document.document_id, page)
                .is_file(),
            text: stored_pages.get(&page).map(|stored| stored.text.clone()),
            blocks: stored_pages
                .get(&page)
                .map(|stored| stored.blocks.clone())
                .unwrap_or_default(),
        })
        .collect();
    Ok(Json(pages))
}

pub async fn get_thumbnail(
    State(state): State<AppState>,
    Path((document_id, page)): Path<(u64, u32)>,
) -> Result<Response, AppError> {
    let document = active_document(&state, document_id).await?;
    let path = state
        .previews
        .ensure_thumbnail(&document, page)
        .await
        .map_err(AppError::bad_request)?;
    stream_file(path, "image/webp").await
}

pub async fn retry_document(
    State(state): State<AppState>,
    Path(document_id): Path<u64>,
) -> Result<Json<Document>, AppError> {
    active_document(&state, document_id).await?;
    state
        .ingestion
        .retry(document_id)
        .await
        .map_err(AppError::bad_request)?;
    let document = state
        .documents
        .get(document_id)
        .await?
        .context("document disappeared after retry")?;
    Ok(Json(document))
}

pub async fn infer_document_metadata(
    State(state): State<AppState>,
    Path(document_id): Path<u64>,
) -> Result<Json<Document>, AppError> {
    let document = active_document(&state, document_id).await?;
    match document.status {
        IngestionStatus::Ready | IngestionStatus::Failed => {}
        _ => {
            return Err(AppError::bad_request(anyhow::anyhow!(
                "document is still processing"
            )));
        }
    }
    let page_rows = state.pages.list(document_id).await?;
    let known_senders = state.documents.senders().await?;
    let inferred = state
        .ocr
        .infer_metadata(page_rows, &known_senders)
        .await
        .map_err(AppError::bad_request)?;
    let document = state
        .metadata
        .apply_inferred(document_id, inferred)
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(document))
}

fn sort_documents(documents: &mut [Document], sort: DocumentSort) {
    documents.sort_by(|left, right| match sort {
        DocumentSort::DocumentDateDesc => right
            .created_at
            .unwrap_or(right.added_at)
            .cmp(&left.created_at.unwrap_or(left.added_at))
            .then_with(|| right.document_id.cmp(&left.document_id)),
        DocumentSort::DocumentDateAsc => left
            .created_at
            .unwrap_or(left.added_at)
            .cmp(&right.created_at.unwrap_or(right.added_at))
            .then_with(|| left.document_id.cmp(&right.document_id)),
        DocumentSort::AddedDateDesc => right
            .added_at
            .cmp(&left.added_at)
            .then_with(|| right.document_id.cmp(&left.document_id)),
        DocumentSort::AddedDateAsc => left
            .added_at
            .cmp(&right.added_at)
            .then_with(|| left.document_id.cmp(&right.document_id)),
        DocumentSort::TitleAsc => left
            .title
            .as_deref()
            .unwrap_or("")
            .cmp(right.title.as_deref().unwrap_or(""))
            .then_with(|| left.document_id.cmp(&right.document_id)),
        DocumentSort::TitleDesc => right
            .title
            .as_deref()
            .unwrap_or("")
            .cmp(left.title.as_deref().unwrap_or(""))
            .then_with(|| right.document_id.cmp(&left.document_id)),
        DocumentSort::SenderAsc => left
            .sender
            .as_deref()
            .unwrap_or("")
            .cmp(right.sender.as_deref().unwrap_or(""))
            .then_with(|| left.document_id.cmp(&right.document_id)),
        DocumentSort::SenderDesc => right
            .sender
            .as_deref()
            .unwrap_or("")
            .cmp(left.sender.as_deref().unwrap_or(""))
            .then_with(|| right.document_id.cmp(&left.document_id)),
        DocumentSort::FileSizeAsc => left
            .file_size
            .cmp(&right.file_size)
            .then_with(|| left.document_id.cmp(&right.document_id)),
        DocumentSort::FileSizeDesc => right
            .file_size
            .cmp(&left.file_size)
            .then_with(|| right.document_id.cmp(&left.document_id)),
    });
}

fn search_filter(request: &SearchRequest) -> Option<String> {
    let mut filters = Vec::new();
    if let Some(sender) = request.sender.as_deref() {
        filters.push(format!("sender = '{}'", sender.replace('\'', "''")));
    }
    if let Some(created_from) = request.created_from {
        filters.push(format!(
            "created_at >= to_timestamp_micros({})",
            created_from.timestamp_micros()
        ));
    }
    if let Some(created_to) = request.created_to {
        filters.push(format!(
            "created_at <= to_timestamp_micros({})",
            created_to.timestamp_micros()
        ));
    }
    (!filters.is_empty()).then(|| filters.join(" AND "))
}

async fn active_document(state: &AppState, document_id: u64) -> Result<Document, AppError> {
    state
        .documents
        .get(document_id)
        .await?
        .filter(|document| document.deleted_at.is_none())
        .ok_or_else(|| {
            AppError::not_found(anyhow::anyhow!("document {document_id} does not exist"))
        })
}

async fn stream_file(
    path: impl AsRef<std::path::Path>,
    content_type: &str,
) -> Result<Response, AppError> {
    let file = tokio::fs::File::open(path.as_ref())
        .await
        .with_context(|| format!("open file {}", path.as_ref().display()))?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from_stream(ReaderStream::new(file)))
        .context("build file response")
        .map_err(AppError::internal)
}

fn detect_media_type(prefix: &[u8]) -> Result<MediaType> {
    let kind = infer::get(prefix).context("file type is not recognized")?;
    match kind.mime_type() {
        "application/pdf" => Ok(MediaType::Pdf),
        "image/png" | "image/jpeg" | "image/tiff" | "image/webp" => Ok(MediaType::Image),
        mime => anyhow::bail!("unsupported file type: {mime}"),
    }
}

async fn image_mime_from_path(path: &std::path::Path) -> Result<&'static str, AppError> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut prefix = [0_u8; 512];
    let read = file.read(&mut prefix).await?;
    let kind = infer::get(&prefix[..read]).ok_or_else(|| {
        AppError::internal(anyhow::anyhow!("stored image type is not recognized"))
    })?;
    match kind.mime_type() {
        mime @ ("image/png" | "image/jpeg" | "image/tiff" | "image/webp") => Ok(mime),
        mime => Err(AppError::internal(anyhow::anyhow!(
            "unsupported stored image format: {mime}"
        ))),
    }
}

async fn remove_unreferenced_object(stored: &StoredObject) {
    if !stored.existed {
        let _ = tokio::fs::remove_file(&stored.path).await;
    }
}

fn nonempty(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

#[derive(Debug)]
pub struct AppError {
    status: StatusCode,
    source: anyhow::Error,
}

impl AppError {
    fn bad_request(source: anyhow::Error) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            source,
        }
    }

    fn not_found(source: anyhow::Error) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            source,
        }
    }

    fn service_unavailable(source: anyhow::Error) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            source,
        }
    }

    fn internal(source: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            source,
        }
    }
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(error: E) -> Self {
        Self::internal(error.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let message = if self.status.is_server_error() {
            tracing::error!(error = %self.source, "request failed");
            "internal server error".to_owned()
        } else {
            self.source.to_string()
        };
        (self.status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}
