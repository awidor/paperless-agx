use std::{env, sync::Arc};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, Request};
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use url::Url;

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
        Ok(Self {
            http: Client::new(),
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

    pub fn prepare_page_request(&self, pages: &[PageImage]) -> Result<Request> {
        let api_key = self
            .api_key
            .as_deref()
            .context("OCR API key environment variable is not set")?;
        if pages.is_empty() {
            bail!("OCR request must contain at least one page");
        }
        if pages.len() > self.config.pages_per_request {
            bail!(
                "OCR request has {} pages, configured maximum is {}",
                pages.len(),
                self.config.pages_per_request
            );
        }

        let mut content = Vec::with_capacity(pages.len() * 2 + 1);
        content.push(UserContent::Text {
            text: "Transcribe each page exactly. Preserve Markdown structure when useful. Return each page under a marker of the form <!-- page:N -->. Do not combine pages.".into(),
        });
        for page in pages {
            content.push(UserContent::Text {
                text: format!("Page {}", page.page),
            });
            content.push(UserContent::ImageUrl {
                image_url: ImageUrl {
                    url: format!(
                        "data:{};base64,{}",
                        page.media_type,
                        STANDARD.encode(&page.bytes)
                    ),
                },
            });
        }

        let body = ChatRequest {
            model: self.config.model.clone(),
            temperature: 0,
            messages: vec![ChatMessage {
                role: "user",
                content,
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
}

#[derive(Debug, Serialize)]
struct ChatRequest {
    model: String,
    temperature: u8,
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

#[cfg(test)]
mod tests {
    use std::sync::LazyLock;

    use parking_lot::Mutex;
    use serde_json::Value;
    use url::Url;

    use super::{OcrClient, OcrConfig, PageImage};

    static ENVIRONMENT_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    #[test]
    fn prepares_bounded_page_aware_openai_request() {
        let _guard = ENVIRONMENT_LOCK.lock();
        unsafe { std::env::set_var("PAPERLESS_TEST_OCR_KEY", "secret") };
        let client = OcrClient::from_environment(OcrConfig {
            base_url: Url::parse("http://localhost:8000/v1").unwrap(),
            model: "vision-model".into(),
            api_key_env: "PAPERLESS_TEST_OCR_KEY".into(),
            max_concurrency: 2,
            pages_per_request: 2,
        })
        .unwrap();
        let request = client
            .prepare_page_request(&[PageImage {
                page: 4,
                media_type: "image/png".into(),
                bytes: vec![1, 2, 3],
            }])
            .unwrap();

        assert_eq!(
            request.url().as_str(),
            "http://localhost:8000/v1/chat/completions"
        );
        assert_eq!(request.headers()["authorization"], "Bearer secret");
        let body: Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body["model"], "vision-model");
        assert_eq!(body["messages"][0]["content"][1]["text"], "Page 4");
        assert_eq!(
            body["messages"][0]["content"][2]["image_url"]["url"],
            "data:image/png;base64,AQID"
        );
        unsafe { std::env::remove_var("PAPERLESS_TEST_OCR_KEY") };
    }

    #[test]
    fn rejects_oversized_page_batches() {
        let _guard = ENVIRONMENT_LOCK.lock();
        unsafe { std::env::set_var("PAPERLESS_TEST_OCR_LIMIT_KEY", "secret") };
        let client = OcrClient::from_environment(OcrConfig {
            base_url: Url::parse("http://localhost:8000/v1").unwrap(),
            model: "vision-model".into(),
            api_key_env: "PAPERLESS_TEST_OCR_LIMIT_KEY".into(),
            max_concurrency: 1,
            pages_per_request: 1,
        })
        .unwrap();
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
        assert!(client.prepare_page_request(&pages).is_err());
        unsafe { std::env::remove_var("PAPERLESS_TEST_OCR_LIMIT_KEY") };
    }
}
