use std::io;

use anyhow::{Context, Result};
use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use paperless_models::{
    Document, HealthResponse, IngestionStatus, MediaType, MetadataSource, PageInfo, UploadMetadata,
};
use paperless_storage::StoredObject;
use tokio::io::AsyncReadExt;
use tokio_util::io::{ReaderStream, StreamReader};

use crate::AppState;

pub async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        ocr_configured: state.ocr.configured(),
        ocr_base_url: state.ocr.config().base_url.to_string(),
        ocr_model: state.ocr.config().model.clone(),
    })
}

pub async fn upload_document(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    let mut filename = None;
    let mut title = None;
    let mut document_type = None;
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
            "document_type" => {
                document_type = nonempty(
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
        document_type,
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
        type_source: metadata
            .document_type
            .as_ref()
            .map(|_| MetadataSource::Manual),
        created_at_source: metadata.created_at.map(|_| MetadataSource::Manual),
        title: metadata.title,
        document_type: metadata.document_type,
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
) -> Result<Json<Vec<Document>>, AppError> {
    Ok(Json(state.documents.list_active().await?))
}

pub async fn get_document(
    State(state): State<AppState>,
    Path(document_id): Path<u64>,
) -> Result<Json<Document>, AppError> {
    Ok(Json(active_document(&state, document_id).await?))
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
    let pages = (1..=document.page_count)
        .map(|page| PageInfo {
            page,
            thumbnail_ready: state
                .layout
                .thumbnail_path(document.document_id, page)
                .is_file(),
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
