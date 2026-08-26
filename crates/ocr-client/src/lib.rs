use std::{env, future::Future, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use futures::{StreamExt, TryStreamExt, stream};
use html5ever::{parse_document, tendril::TendrilSink};
use markup5ever_rcdom::{Handle, NodeData, RcDom};
use paperless_models::{DocumentPage, InferredMetadata, OcrBlock};
use reqwest::{Client, Request, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use url::Url;

const SURYA_FULL_PAGE_PROMPT: &str = "OCR this image to HTML. Each block is a div with data-label and data-bbox (x0 y0 x1 y1, normalized 0-1000).";
const SURYA_MAX_TOKENS: u32 = 12_288;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_ATTEMPTS: usize = 3;
const METADATA_PROMPT: &str = "Infer document metadata from the OCR text. Return only JSON with nullable string fields title, document_type, and created_at. Use YYYY-MM-DD for created_at.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrConfig {
    pub base_url: Url,
    pub model: String,
    pub api_key_env: String,
    pub max_concurrency: usize,
    pub pages_per_request: usize,
}

impl OcrConfig {
    pub fn check(&self) -> Result<()> {
        if self.model.trim().is_empty() {
            bail!("ocr.model must not be empty");
        }
        if self.api_key_env.trim().is_empty() {
            bail!("ocr.api_key_env must not be empty");
        }
        if self.max_concurrency == 0 {
            bail!("ocr.max_concurrency must be greater than zero");
        }
        if self.pages_per_request == 0 {
            bail!("ocr.pages_per_request must be greater than zero");
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct PageImage {
    pub page: u32,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OcrPage {
    pub page: u32,
    pub text: String,
    pub blocks: Vec<OcrBlock>,
}

#[derive(Clone)]
pub struct OcrClient {
    http: Client,
    config: OcrConfig,
    api_key: Option<String>,
    request_gate: Arc<Semaphore>,
}

impl OcrClient {
    pub fn from_environment(config: OcrConfig) -> Result<Self> {
        config.check()?;
        let api_key = env::var(&config.api_key_env)
            .ok()
            .filter(|value| !value.is_empty());
        let http = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .context("build OCR HTTP client")?;
        Ok(Self {
            http,
            request_gate: Arc::new(Semaphore::new(config.max_concurrency)),
            config,
            api_key,
        })
    }

    pub fn configured(&self) -> bool {
        self.api_key.is_some()
    }

    pub fn config(&self) -> &OcrConfig {
        &self.config
    }

    pub async fn acquire_request_slot(&self) -> Result<OwnedSemaphorePermit> {
        self.request_gate
            .clone()
            .acquire_owned()
            .await
            .context("OCR request gate closed")
    }

    pub fn recognize_pages(
        &self,
        pages: Vec<PageImage>,
    ) -> impl Future<Output = Result<Vec<OcrPage>>> + Send + 'static {
        let client = self.clone();
        async move {
            if pages.is_empty() {
                bail!("OCR page batch must not be empty");
            }
            if pages.len() > client.config.pages_per_request {
                bail!(
                    "OCR page batch has {} pages, configured maximum is {}",
                    pages.len(),
                    client.config.pages_per_request
                );
            }

            let concurrency = client.config.max_concurrency;
            let mut recognized = stream::iter(pages)
                .map(move |page| client.clone().recognize_page(page))
                .buffer_unordered(concurrency)
                .try_collect::<Vec<_>>()
                .await?;
            recognized.sort_by_key(|page| page.page);
            Ok(recognized)
        }
    }

    pub fn prepare_page_request(&self, page: &PageImage) -> Result<Request> {
        let api_key = self
            .api_key
            .as_deref()
            .context("OCR API key environment variable is not set")?;
        if page.page == 0 {
            bail!("OCR page number must start at one");
        }

        let body = ChatRequest {
            model: self.config.model.clone(),
            max_tokens: SURYA_MAX_TOKENS,
            temperature: 0.0,
            top_p: 0.1,
            messages: vec![ChatMessage {
                role: "user",
                content: vec![
                    UserContent::ImageUrl {
                        image_url: ImageUrl {
                            url: format!(
                                "data:{};base64,{}",
                                page.media_type,
                                STANDARD.encode(&page.bytes)
                            ),
                        },
                    },
                    UserContent::Text {
                        text: SURYA_FULL_PAGE_PROMPT.into(),
                    },
                ],
            }],
        };
        let endpoint = Url::parse(&format!(
            "{}/chat/completions",
            self.config.base_url.as_str().trim_end_matches('/')
        ))
        .context("build OCR chat completions URL")?;
        self.http
            .post(endpoint)
            .bearer_auth(api_key)
            .json(&body)
            .build()
            .context("build OCR request")
    }

    pub async fn infer_metadata(&self, pages: Vec<DocumentPage>) -> Result<InferredMetadata> {
        let text = pages
            .into_iter()
            .map(|page| format!("Page {}:\\n{}", page.page, page.text))
            .collect::<Vec<_>>()
            .join("\\n\\n");
        let text = truncate(&text, 40_000);
        let body = ChatRequest {
            model: self.config.model.clone(),
            max_tokens: 1_024,
            temperature: 0.0,
            top_p: 0.1,
            messages: vec![ChatMessage {
                role: "user",
                content: vec![UserContent::Text {
                    text: format!("{METADATA_PROMPT}\\n\\n{text}"),
                }],
            }],
        };
        let api_key = self
            .api_key
            .as_deref()
            .context("OCR API key environment variable is not set")?;
        let endpoint = Url::parse(&format!(
            "{}/chat/completions",
            self.config.base_url.as_str().trim_end_matches('/')
        ))
        .context("build metadata chat completions URL")?;
        let _permit = self.acquire_request_slot().await?;
        let response = self
            .http
            .post(endpoint)
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
            .context("request inferred metadata")?;
        let status = response.status();
        let bytes = response.bytes().await.context("read metadata response")?;
        if !status.is_success() {
            bail!(
                "metadata API returned {status}: {}",
                truncate(&String::from_utf8_lossy(&bytes), 2_000)
            );
        }
        parse_metadata_response(&bytes)
    }

    async fn recognize_page(self, page: PageImage) -> Result<OcrPage> {
        for attempt in 1..=MAX_ATTEMPTS {
            let permit = self.acquire_request_slot().await?;
            let request = self.prepare_page_request(&page)?;
            let response = self.http.execute(request).await;
            let result = match response {
                Ok(response) if response.status().is_success() => {
                    let bytes = response.bytes().await.context("read OCR response body")?;
                    parse_page_response(page.page, &bytes)
                }
                Ok(response) => {
                    let status = response.status();
                    let retryable = is_retryable_status(status);
                    let body = response.text().await.unwrap_or_default();
                    Err(anyhow::anyhow!(
                        "OCR API returned {status}: {}",
                        truncate(&body, 2_000)
                    ))
                    .with_context(|| {
                        if retryable {
                            "transient OCR response"
                        } else {
                            "OCR response"
                        }
                    })
                }
                Err(error) => {
                    let retryable = error.is_connect() || error.is_timeout();
                    Err(error).context(if retryable {
                        "transient OCR request"
                    } else {
                        "OCR request"
                    })
                }
            };
            drop(permit);

            match result {
                Ok(page) => return Ok(page),
                Err(error) if attempt < MAX_ATTEMPTS && is_transient(&error) => {
                    tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await;
                }
                Err(error) => return Err(error).with_context(|| format!("OCR page {}", page.page)),
            }
        }
        unreachable!("OCR attempt loop always returns")
    }
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    max_tokens: u32,
    temperature: f32,
    top_p: f32,
    messages: Vec<ChatMessage>,
}

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: &'static str,
    content: Vec<UserContent>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum UserContent {
    Text { text: String },
    ImageUrl { image_url: ImageUrl },
}

#[derive(Debug, Serialize)]
struct ImageUrl {
    url: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
}

#[derive(Debug, Deserialize)]
struct ChatResponseMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawMetadata {
    title: Option<String>,
    document_type: Option<String>,
    created_at: Option<String>,
}

fn parse_metadata_response(body: &[u8]) -> Result<InferredMetadata> {
    let response: ChatResponse =
        serde_json::from_slice(body).context("parse metadata JSON response")?;
    let content = response
        .choices
        .first()
        .context("metadata response has no choices")?
        .message
        .content
        .as_deref()
        .context("metadata response has no content")?
        .trim();
    let content = content
        .strip_prefix("```json")
        .or_else(|| content.strip_prefix("```"))
        .unwrap_or(content)
        .strip_suffix("```")
        .unwrap_or(content)
        .trim();
    let raw: RawMetadata = serde_json::from_str(content).context("parse inferred metadata")?;
    let title = clean_metadata_value(raw.title, 500, "title")?;
    let document_type = clean_metadata_value(raw.document_type, 100, "document_type")?;
    let created_at = raw
        .created_at
        .map(|value| {
            DateTime::parse_from_rfc3339(&value)
                .map(|date| date.with_timezone(&Utc))
                .or_else(|_| {
                    NaiveDate::parse_from_str(&value, "%Y-%m-%d")
                        .map(|date| Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap()))
                })
                .with_context(|| format!("invalid inferred created_at: {value}"))
        })
        .transpose()?;
    Ok(InferredMetadata {
        title,
        document_type,
        created_at,
    })
}

fn clean_metadata_value(
    value: Option<String>,
    maximum_chars: usize,
    field: &str,
) -> Result<Option<String>> {
    let value = value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if value
        .as_ref()
        .is_some_and(|value| value.chars().count() > maximum_chars)
    {
        bail!("inferred {field} exceeds {maximum_chars} characters");
    }
    Ok(value)
}

fn parse_page_response(page: u32, body: &[u8]) -> Result<OcrPage> {
    let response: ChatResponse = serde_json::from_slice(body).context("parse OCR JSON response")?;
    let html = response
        .choices
        .first()
        .context("OCR response has no choices")?
        .message
        .content
        .as_deref()
        .unwrap_or_default();
    let text = html2md::parse_html(html).trim().to_owned();
    let blocks = parse_ocr_blocks(html)?;
    Ok(OcrPage { page, text, blocks })
}

fn parse_ocr_blocks(html: &str) -> Result<Vec<OcrBlock>> {
    let document = parse_document(RcDom::default(), Default::default()).one(html);
    let mut blocks = Vec::new();
    collect_ocr_blocks(&document.document, &mut blocks)?;
    if !html.trim().is_empty() && blocks.is_empty() {
        bail!("OCR response contains no positioned blocks");
    }
    Ok(blocks)
}

fn collect_ocr_blocks(handle: &Handle, blocks: &mut Vec<OcrBlock>) -> Result<()> {
    if let NodeData::Element { name, attrs, .. } = &handle.data
        && name.local.as_ref() == "div"
    {
        let attributes = attrs.borrow();
        let label = attributes
            .iter()
            .find(|attribute| attribute.name.local.as_ref() == "data-label")
            .map(|attribute| attribute.value.to_string());
        let bbox = attributes
            .iter()
            .find(|attribute| attribute.name.local.as_ref() == "data-bbox")
            .map(|attribute| attribute.value.to_string());
        drop(attributes);
        if label.is_some() || bbox.is_some() {
            let label = label.context("OCR block has no data-label")?;
            if label.trim().is_empty() {
                bail!("OCR block has an empty data-label");
            }
            let bbox =
                parse_normalized_bbox(bbox.as_deref().context("OCR block has no data-bbox")?)?;
            let mut raw_text = String::new();
            collect_node_text(handle, &mut raw_text);
            let text = raw_text.split_whitespace().collect::<Vec<_>>().join(" ");
            blocks.push(OcrBlock {
                label: label.trim().to_owned(),
                bbox,
                text,
            });
            return Ok(());
        }
    }
    for child in handle.children.borrow().iter() {
        collect_ocr_blocks(child, blocks)?;
    }
    Ok(())
}

fn collect_node_text(handle: &Handle, output: &mut String) {
    if let NodeData::Text { contents } = &handle.data {
        output.push_str(&contents.borrow());
        output.push(' ');
    }
    for child in handle.children.borrow().iter() {
        collect_node_text(child, output);
    }
}

fn parse_normalized_bbox(value: &str) -> Result<[u16; 4]> {
    let coordinates = value
        .split_whitespace()
        .map(str::parse::<f32>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("OCR block data-bbox contains a non-number")?;
    if coordinates.len() != 4
        || coordinates
            .iter()
            .any(|coordinate| !coordinate.is_finite() || !(0.0..=1000.0).contains(coordinate))
        || coordinates[0] >= coordinates[2]
        || coordinates[1] >= coordinates[3]
    {
        bail!("OCR block data-bbox must be x0 y0 x1 y1 within 0-1000");
    }
    Ok([
        coordinates[0].round() as u16,
        coordinates[1].round() as u16,
        coordinates[2].round() as u16,
        coordinates[3].round() as u16,
    ])
}

fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn is_transient(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        let message = cause.to_string();
        message == "transient OCR response" || message == "transient OCR request"
    })
}

fn truncate(value: &str, maximum_chars: usize) -> String {
    value.chars().take(maximum_chars).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use parking_lot::Mutex;
    use serde_json::Value;
    use url::Url;

    use super::{OcrClient, OcrConfig, PageImage, parse_metadata_response, parse_page_response};

    static ENVIRONMENT_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn client(key_name: &str, pages_per_request: usize) -> OcrClient {
        unsafe { std::env::set_var(key_name, "secret") };
        OcrClient::from_environment(OcrConfig {
            base_url: Url::parse("http://localhost:8000/v1").unwrap(),
            model: "datalab-to/surya-ocr-2".into(),
            api_key_env: key_name.into(),
            max_concurrency: 2,
            pages_per_request,
        })
        .unwrap()
    }

    #[test]
    fn prepares_surya_openai_request() {
        let _guard = ENVIRONMENT_LOCK.lock();
        let client = client("PAPERLESS_TEST_OCR_KEY", 2);
        let request = client
            .prepare_page_request(&PageImage {
                page: 4,
                media_type: "image/png".into(),
                bytes: vec![1, 2, 3],
            })
            .unwrap();

        assert_eq!(
            request.url().as_str(),
            "http://localhost:8000/v1/chat/completions"
        );
        assert_eq!(request.headers()["authorization"], "Bearer secret");
        let body: Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body["model"], "datalab-to/surya-ocr-2");
        assert_eq!(body["max_tokens"], 12_288);
        assert_eq!(
            body["messages"][0]["content"][0]["image_url"]["url"],
            "data:image/png;base64,AQID"
        );
        assert_eq!(
            body["messages"][0]["content"][1]["text"],
            "OCR this image to HTML. Each block is a div with data-label and data-bbox (x0 y0 x1 y1, normalized 0-1000)."
        );
        unsafe { std::env::remove_var("PAPERLESS_TEST_OCR_KEY") };
    }

    #[tokio::test]
    async fn rejects_oversized_page_batches() {
        let _guard = ENVIRONMENT_LOCK.lock();
        let client = client("PAPERLESS_TEST_OCR_LIMIT_KEY", 1);
        let pages = vec![
            PageImage {
                page: 1,
                media_type: "image/png".into(),
                bytes: vec![],
            },
            PageImage {
                page: 2,
                media_type: "image/png".into(),
                bytes: vec![],
            },
        ];
        assert!(client.recognize_pages(pages).await.is_err());
        unsafe { std::env::remove_var("PAPERLESS_TEST_OCR_LIMIT_KEY") };
    }

    #[test]
    fn converts_surya_html_to_page_markdown() {
        let page = parse_page_response(
            3,
            br#"{"choices":[{"message":{"content":"<div data-label=\"SectionHeader\" data-bbox=\"0 0 1000 100\"><h1>Title</h1></div><div data-label=\"Text\" data-bbox=\"0 100 1000 200\"><p>Body text</p></div>"}}]}"#,
        )
        .unwrap();
        assert_eq!(page.page, 3);
        assert!(page.text.contains("Title"));
        assert!(page.text.contains("Body text"));
        assert_eq!(page.blocks.len(), 2);
        assert_eq!(page.blocks[0].label, "SectionHeader");
        assert_eq!(page.blocks[0].bbox, [0, 0, 1000, 100]);
        assert_eq!(page.blocks[0].text, "Title");
        assert_eq!(page.blocks[1].bbox, [0, 100, 1000, 200]);
        assert_eq!(page.blocks[1].text, "Body text");
    }

    #[test]
    fn parses_and_validates_structured_metadata() {
        let body = serde_json::json!({
            "choices": [{
                "message": {
                    "content": "```json\n{\"title\":\"  Annual statement  \",\"document_type\":\"statement\",\"created_at\":\"2026-01-31\"}\n```"
                }
            }]
        });
        let inferred = parse_metadata_response(&serde_json::to_vec(&body).unwrap()).unwrap();
        assert_eq!(inferred.title.as_deref(), Some("Annual statement"));
        assert_eq!(inferred.document_type.as_deref(), Some("statement"));
        assert_eq!(
            inferred.created_at.unwrap().to_rfc3339(),
            "2026-01-31T00:00:00+00:00"
        );

        let invalid = serde_json::json!({
            "choices": [{"message": {
                "content": "{\"title\":null,\"document_type\":null,\"created_at\":\"31/01/2026\"}"
            }}]
        });
        assert!(parse_metadata_response(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
}
