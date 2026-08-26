use std::{env, future::Future, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures::{StreamExt, TryStreamExt, stream};
use reqwest::{Client, Request, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use url::Url;

const SURYA_FULL_PAGE_PROMPT: &str = "OCR this image to HTML. Each block is a div with data-label and data-bbox (x0 y0 x1 y1, normalized 0-1000).";
const SURYA_MAX_TOKENS: u32 = 12_288;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_ATTEMPTS: usize = 3;

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
    Ok(OcrPage { page, text })
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

    use super::{OcrClient, OcrConfig, PageImage, parse_page_response};

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
    }
}
