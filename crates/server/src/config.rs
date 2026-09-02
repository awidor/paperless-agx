use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use paperless_ocr_client::{LlmConfig, OcrConfig};
use serde::Deserialize;
use url::Url;

#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingConfig {
    pub base_url: Url,
    pub model: String,
    pub api_key_env: String,
    pub max_concurrency: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub data_dir: PathBuf,
    pub listen_addr: SocketAddr,
    pub queue_capacity: usize,
    pub render_concurrency: usize,
    pub eager_thumbnail_pages: u32,
    #[serde(default)]
    pub embeddings: Option<EmbeddingConfig>,
    pub llm: LlmConfig,
    pub ocr: OcrConfig,
}

impl AppConfig {
    pub async fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let bytes = tokio::fs::read(path)
            .await
            .with_context(|| format!("read configuration {}", path.display()))?;
        let config: Self = toml::from_slice(&bytes)
            .with_context(|| format!("parse configuration {}", path.display()))?;
        config.check()?;
        Ok(config)
    }

    pub fn check(&self) -> Result<()> {
        if self.queue_capacity == 0 {
            bail!("queue_capacity must be greater than zero");
        }
        if self.render_concurrency == 0 {
            bail!("render_concurrency must be greater than zero");
        }
        self.ocr.check()?;
        self.llm.check()?;
        if let Some(embedding) = &self.embeddings {
            if embedding.model.trim().is_empty() {
                bail!("embedding.model must not be empty");
            }
            if embedding.api_key_env.trim().is_empty() {
                bail!("embedding.api_key_env must not be empty");
            }
            if embedding.max_concurrency == 0 {
                bail!("embedding max_concurrency must be greater than zero");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::AppConfig;

    #[tokio::test]
    async fn loads_mounted_toml_configuration() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("config.toml");
        tokio::fs::write(
            &path,
            r#"
data_dir = "/data"
listen_addr = "0.0.0.0:3000"
queue_capacity = 16
render_concurrency = 2
eager_thumbnail_pages = 3

[embeddings]
base_url = "http://127.0.0.1:8765/v1"
model = "harrier"
api_key_env = "OCR_API_KEY"
max_concurrency = 1
[ocr]
base_url = "http://127.0.0.1:8765/v1"
model = "chandra"
api_key_env = "OCR_API_KEY"
max_concurrency = 2
pages_per_request = 2
max_output_tokens = 24576

[llm]
base_url = "https://openrouter.ai/api/v1"
model = "z-ai/glm-5.3-flash"
api_key_env = "OPENROUTER_API_KEY"
max_concurrency = 1
            "#,
        )
        .await
        .unwrap();
        let config = AppConfig::load(path).await.unwrap();
        assert_eq!(
            config.embeddings.as_ref().unwrap().base_url.as_str(),
            "http://127.0.0.1:8765/v1"
        );
        assert_eq!(config.embeddings.as_ref().unwrap().model, "harrier");
        assert_eq!(
            config.embeddings.as_ref().unwrap().api_key_env,
            "OCR_API_KEY"
        );
        assert_eq!(config.embeddings.as_ref().unwrap().max_concurrency, 1);
        assert_eq!(config.ocr.pages_per_request, 2);
        assert_eq!(config.ocr.model, "chandra");
        assert_eq!(config.ocr.max_output_tokens, 24_576);
        assert_eq!(config.llm.model, "z-ai/glm-5.3-flash");
        assert_eq!(config.llm.max_concurrency, 1);
    }

    #[test]
    fn requires_llm_configuration() {
        let error = toml::from_str::<AppConfig>(
            r#"
data_dir = "/data"
listen_addr = "0.0.0.0:3000"
queue_capacity = 16
render_concurrency = 2
eager_thumbnail_pages = 3

[ocr]
base_url = "http://127.0.0.1:8765/v1"
model = "chandra"
api_key_env = "OCR_API_KEY"
max_concurrency = 2
pages_per_request = 2
max_output_tokens = 24576
"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("missing field `llm`"));
    }
}
