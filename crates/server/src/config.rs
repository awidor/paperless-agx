use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use paperless_ocr_client::OcrConfig;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingConfig {
    pub model_dir: PathBuf,
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
        if self
            .embeddings
            .as_ref()
            .is_some_and(|embedding| embedding.max_concurrency == 0)
        {
            bail!("embedding max_concurrency must be greater than zero");
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

[ocr]
base_url = "http://host.docker.internal:8000/v1"
model = "vision"
api_key_env = "OCR_API_KEY"
max_concurrency = 2
pages_per_request = 4
"#,
        )
        .await
        .unwrap();
        let config = AppConfig::load(path).await.unwrap();
        assert_eq!(config.listen_addr.to_string(), "0.0.0.0:3000");
        assert_eq!(config.ocr.pages_per_request, 4);
    }
}
