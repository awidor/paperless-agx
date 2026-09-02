use std::{
    collections::{HashMap, HashSet},
    io,
};

use anyhow::{Context, Result};
use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Datelike, TimeDelta, TimeZone, Utc};
use futures::TryStreamExt;
use paperless_models::{
    Document, DocumentPageResult, DocumentPatch, DocumentQuery, DocumentSort, HealthResponse,
    IngestionStatus, MediaType, MetadataSource, PageInfo, SearchAnswerRequest,
    SearchAnswerResponse, SearchHit, SearchInterpretation, SearchPassage, SearchRequest,
    SearchResponse, UploadMetadata,
};
use paperless_search::{RankedChunk, collapse_to_documents, reciprocal_rank_fusion};
use paperless_storage::{ChunkMatch, SearchFilter, StoredObject};
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
                .query
                .as_deref()
                .is_none_or(|value| metadata_matches(document, value))
                && query
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
    let known_senders = if request.sender.is_none() && !request.skip_inferred_sender {
        state.documents.senders().await?
    } else {
        Vec::new()
    };
    let interpretation = infer_search_interpretation(&request, &known_senders, Utc::now());
    let mut effective_request = request.clone();
    effective_request.sender = request
        .sender
        .clone()
        .or_else(|| interpretation.sender.clone());
    effective_request.created_from = request.created_from.or(interpretation.created_from);
    effective_request.created_to = request.created_to.or(interpretation.created_to);

    let embeddings = state.embeddings.as_ref().ok_or_else(|| {
        AppError::service_unavailable(anyhow::anyhow!("embedding model is not configured"))
    })?;
    let query_embedding = embeddings
        .embed_query(request.query.trim().to_owned())
        .await?;
    let filter = search_filter(&effective_request);
    let lexical = state
        .chunks
        .lexical_candidates(&request.query, filter.clone(), 50)
        .await?;
    let vector = state
        .chunks
        .vector_candidates(&query_embedding, filter, 50)
        .await?;
    let ranked = |matches: Vec<ChunkMatch>| {
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
    let mut passage_hits: HashMap<u64, Vec<(u64, f32)>> = HashMap::new();
    for hit in &fused {
        let passages = passage_hits.entry(hit.document_id).or_default();
        if passages.len() < 3 {
            passages.push((hit.chunk_id, hit.score));
        }
    }
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
        let mut passages = Vec::new();
        for &(chunk_id, score) in passage_hits.get(&hit.document_id).into_iter().flatten() {
            let Some(chunk) = state.chunks.get(chunk_id).await? else {
                continue;
            };
            passages.push(SearchPassage {
                chunk_id,
                page: chunk.page_start,
                char_start: chunk.char_start,
                char_end: chunk.char_end,
                snippet: chunk.text,
                score,
            });
        }
        let Some(best) = passages.first() else {
            continue;
        };
        items.push(SearchHit {
            document,
            best_chunk_id: best.chunk_id,
            page: best.page,
            snippet: best.snippet.clone(),
            score: best.score,
            passages,
        });
    }
    Ok(Json(SearchResponse {
        items,
        page: request.page,
        page_size: request.page_size,
        total,
        interpretation,
    }))
}

pub async fn answer_search(
    State(state): State<AppState>,
    Json(request): Json<SearchAnswerRequest>,
) -> Result<Json<SearchAnswerResponse>, AppError> {
    if request.query.trim().is_empty() {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "search question must not be empty"
        )));
    }
    let unique = request.chunk_ids.iter().copied().collect::<HashSet<_>>();
    if !(1..=12).contains(&request.chunk_ids.len()) || unique.len() != request.chunk_ids.len() {
        return Err(AppError::bad_request(anyhow::anyhow!(
            "chunk_ids must contain between 1 and 12 unique IDs"
        )));
    }

    let mut sources = Vec::with_capacity(request.chunk_ids.len());
    for chunk_id in &request.chunk_ids {
        let chunk =
            state.chunks.get(*chunk_id).await?.ok_or_else(|| {
                AppError::bad_request(anyhow::anyhow!("unknown chunk ID {chunk_id}"))
            })?;
        let document = active_document(&state, chunk.document_id).await?;
        sources.push(format!(
            "{}, page {}:\n{}",
            document.title.as_deref().unwrap_or(&document.filename),
            chunk.page_start,
            chunk.text
        ));
    }

    let generated = state
        .ocr
        .answer_question(request.query.trim(), &sources)
        .await?;
    let Some(answer) = generated.answer.filter(|value| !value.trim().is_empty()) else {
        return Ok(Json(SearchAnswerResponse {
            answer: None,
            citations: Vec::new(),
        }));
    };
    if generated.citations.is_empty()
        || generated
            .citations
            .iter()
            .any(|index| *index >= request.chunk_ids.len())
    {
        return Ok(Json(SearchAnswerResponse {
            answer: None,
            citations: Vec::new(),
        }));
    }
    Ok(Json(SearchAnswerResponse {
        answer: Some(answer),
        citations: generated
            .citations
            .into_iter()
            .map(|index| request.chunk_ids[index])
            .collect(),
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
            html: stored_pages
                .get(&page)
                .and_then(|stored| stored.html.clone()),
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

pub async fn get_page_image(
    State(state): State<AppState>,
    Path((document_id, page)): Path<(u64, u32)>,
) -> Result<Response, AppError> {
    let document = active_document(&state, document_id).await?;
    let path = state
        .previews
        .ensure_page_image(&document, page)
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

fn metadata_matches(document: &Document, query: &str) -> bool {
    let terms = query
        .split_whitespace()
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    terms.is_empty()
        || terms.iter().all(|term| {
            [
                Some(document.filename.as_str()),
                document.title.as_deref(),
                document.sender.as_deref(),
            ]
            .into_iter()
            .flatten()
            .any(|value| value.to_lowercase().contains(term))
        })
}

fn search_filter(request: &SearchRequest) -> SearchFilter {
    SearchFilter {
        sender: request.sender.clone(),
        created_from: request.created_from,
        created_to: request.created_to,
    }
}

fn infer_search_interpretation(
    request: &SearchRequest,
    known_senders: &[String],
    now: DateTime<Utc>,
) -> SearchInterpretation {
    let words = normalized_words(&request.query);
    let sender = (request.sender.is_none() && !request.skip_inferred_sender)
        .then(|| {
            known_senders
                .iter()
                .filter_map(|sender| {
                    let sender_words = normalized_words(sender);
                    (!sender_words.is_empty()
                        && words
                            .windows(sender_words.len())
                            .any(|window| window == sender_words))
                    .then_some((sender, sender_words.iter().map(String::len).sum::<usize>()))
                })
                .max_by_key(|(_, length)| *length)
                .map(|(sender, _)| sender.clone())
        })
        .flatten();

    let mut interpretation = SearchInterpretation {
        sender,
        ..Default::default()
    };
    if !request.skip_inferred_dates
        && (request.created_from.is_none() || request.created_to.is_none())
        && let Some((from, to)) = inferred_date_range(&words, now)
    {
        if request.created_from.is_none() {
            interpretation.created_from = Some(from);
        }
        if request.created_to.is_none() {
            interpretation.created_to = Some(to);
        }
    }
    interpretation
}

fn normalized_words(value: &str) -> Vec<String> {
    value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn inferred_date_range(
    words: &[String],
    now: DateTime<Utc>,
) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let month_year = words
        .windows(2)
        .filter_map(|pair| Some((parse_year(&pair[1], now.year())?, month_number(&pair[0])?)))
        .filter_map(|(year, month)| month_range(year, month))
        .collect::<Vec<_>>();
    if !month_year.is_empty() {
        return unique_range(month_year);
    }

    let relative = words
        .windows(2)
        .filter_map(|pair| {
            let this = is_this(&pair[0]);
            let last = is_last(&pair[0]);
            if !(this || last) {
                return None;
            }
            match pair[1].as_str() {
                "year" | "jahr" => year_range(now.year() - i32::from(last)),
                "month" | "monat" => {
                    let (year, month) = if last {
                        previous_month(now.year(), now.month())
                    } else {
                        (now.year(), now.month())
                    };
                    month_range(year, month)
                }
                month_name => {
                    let month = month_number(month_name)?;
                    let year = if last && month >= now.month() {
                        now.year() - 1
                    } else {
                        now.year()
                    };
                    month_range(year, month)
                }
            }
        })
        .collect::<Vec<_>>();
    if !relative.is_empty() {
        return unique_range(relative);
    }

    let years = words
        .iter()
        .filter_map(|word| parse_year(word, now.year()))
        .filter_map(year_range)
        .collect::<Vec<_>>();
    unique_range(years)
}

fn unique_range(
    mut ranges: Vec<(DateTime<Utc>, DateTime<Utc>)>,
) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let first = ranges.pop()?;
    ranges
        .into_iter()
        .all(|range| range == first)
        .then_some(first)
}

fn parse_year(word: &str, current_year: i32) -> Option<i32> {
    (word.len() == 4 && word.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| word.parse().ok())
        .flatten()
        .filter(|year| (1900..=current_year + 1).contains(year))
}

fn is_this(word: &str) -> bool {
    matches!(word, "this" | "dieser" | "diese" | "dieses" | "diesen")
}

fn is_last(word: &str) -> bool {
    matches!(word, "last" | "letzter" | "letzte" | "letztes" | "letzten")
}

fn month_number(word: &str) -> Option<u32> {
    match word {
        "january" | "januar" => Some(1),
        "february" | "februar" => Some(2),
        "march" | "märz" | "maerz" => Some(3),
        "april" => Some(4),
        "may" | "mai" => Some(5),
        "june" | "juni" => Some(6),
        "july" | "juli" => Some(7),
        "august" => Some(8),
        "september" => Some(9),
        "october" | "oktober" => Some(10),
        "november" => Some(11),
        "december" | "dezember" => Some(12),
        _ => None,
    }
}

fn previous_month(year: i32, month: u32) -> (i32, u32) {
    if month == 1 {
        (year - 1, 12)
    } else {
        (year, month - 1)
    }
}

fn year_range(year: i32) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let start = Utc.with_ymd_and_hms(year, 1, 1, 0, 0, 0).single()?;
    let next = Utc.with_ymd_and_hms(year + 1, 1, 1, 0, 0, 0).single()?;
    Some((start, next - TimeDelta::microseconds(1)))
}

fn month_range(year: i32, month: u32) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    let start = Utc.with_ymd_and_hms(year, month, 1, 0, 0, 0).single()?;
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let next = Utc
        .with_ymd_and_hms(next_year, next_month, 1, 0, 0, 0)
        .single()?;
    Some((start, next - TimeDelta::microseconds(1)))
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

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use paperless_models::SearchRequest;

    use super::infer_search_interpretation;

    fn request(query: &str) -> SearchRequest {
        SearchRequest {
            query: query.into(),
            page: 1,
            page_size: 10,
            sender: None,
            created_from: None,
            created_to: None,
            skip_inferred_sender: false,
            skip_inferred_dates: false,
        }
    }

    #[test]
    fn search_interpretation_uses_whole_longest_sender_and_explicit_month() {
        let interpretation = infer_search_interpretation(
            &request("Allianz Versicherungs AG renewal from March 2025"),
            &["Allianz".into(), "Allianz Versicherungs AG".into()],
            Utc.with_ymd_and_hms(2026, 8, 31, 12, 0, 0).unwrap(),
        );

        assert_eq!(
            interpretation.sender.as_deref(),
            Some("Allianz Versicherungs AG")
        );
        assert_eq!(
            interpretation.created_from,
            Some(Utc.with_ymd_and_hms(2025, 3, 1, 0, 0, 0).unwrap())
        );
        assert_eq!(
            interpretation.created_to,
            Some(
                Utc.with_ymd_and_hms(2025, 3, 31, 23, 59, 59).unwrap()
                    + chrono::TimeDelta::microseconds(999_999)
            )
        );
    }

    #[test]
    fn search_interpretation_handles_relative_german_dates_and_respects_controls() {
        let now = Utc.with_ymd_and_hms(2026, 1, 15, 12, 0, 0).unwrap();
        let interpretation = infer_search_interpretation(
            &request("Schreiben vom letzten März"),
            &["Mär".into()],
            now,
        );
        assert_eq!(
            interpretation.created_from,
            Some(Utc.with_ymd_and_hms(2025, 3, 1, 0, 0, 0).unwrap())
        );
        assert_eq!(interpretation.sender, None);

        let mut controlled = request("Allianz last year");
        controlled.sender = Some("Explicit".into());
        controlled.skip_inferred_dates = true;
        assert_eq!(
            infer_search_interpretation(&controlled, &["Allianz".into()], now),
            Default::default()
        );
    }

    #[test]
    fn search_interpretation_handles_relative_periods_and_standalone_years() {
        let now = Utc.with_ymd_and_hms(2026, 8, 31, 12, 0, 0).unwrap();
        for (query, year, month) in [
            ("this year", 2026, 1),
            ("last year", 2025, 1),
            ("this month", 2026, 8),
            ("last month", 2026, 7),
            ("invoice 2024", 2024, 1),
            ("Januar 2023", 2023, 1),
            ("this March", 2026, 3),
            ("last March", 2026, 3),
        ] {
            assert_eq!(
                infer_search_interpretation(&request(query), &[], now).created_from,
                Some(Utc.with_ymd_and_hms(year, month, 1, 0, 0, 0).unwrap()),
                "{query}"
            );
        }
        assert_eq!(
            infer_search_interpretation(&request("reference 7319"), &[], now).created_from,
            None
        );
    }
}
