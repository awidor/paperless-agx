use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use url::Url;

#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingConfig {
    pub base_url: Url,
    pub model: String,
    pub api_key_env: String,
    pub max_concurrency: usize,
}

/// The agent service (`agent/`): it indexes every document and answers agent searches.
/// It is the only part that talks to a language model.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentConfig {
    pub url: Url,
}

/// The network scanner behind `/api/scan`: a Samsung SL-M3870FW, or another MFP speaking its
/// protocol on TCP port 9400.
#[derive(Debug, Clone, Deserialize)]
pub struct ScannerConfig {
    pub host: String,
    #[serde(default = "default_scanner_port")]
    pub port: u16,
}

const fn default_scanner_port() -> u16 {
    paperless_scanner::DEFAULT_PORT
}

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub data_dir: PathBuf,
    pub listen_addr: SocketAddr,
    pub queue_capacity: usize,
    pub render_concurrency: usize,
    pub eager_thumbnail_pages: u32,
    /// Resolution PDF pages are rendered at for the indexing agent and the page viewer.
    #[serde(default = "default_page_dpi")]
    pub page_dpi: u32,
    #[serde(default)]
    pub embeddings: Option<EmbeddingConfig>,
    pub agent: AgentConfig,
    #[serde(default)]
    pub scanner: Option<ScannerConfig>,
}

const fn default_page_dpi() -> u32 {
    150
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
        if self.page_dpi == 0 {
            bail!("page_dpi must be greater than zero");
        }
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
        if self
            .scanner
            .as_ref()
            .is_some_and(|scanner| scanner.host.trim().is_empty())
        {
            bail!("scanner.host must not be empty");
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
base_url = "https://openrouter.ai/api/v1"
model = "google/gemini-embedding-2"
api_key_env = "OPENROUTER_API_KEY"
max_concurrency = 2

[agent]
url = "http://paperless-agent:3100"

[scanner]
host = "192.168.1.218"
            "#,
        )
        .await
        .unwrap();
        let config = AppConfig::load(path).await.unwrap();
        assert_eq!(
            config.embeddings.as_ref().unwrap().base_url.as_str(),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            config.embeddings.as_ref().unwrap().model,
            "google/gemini-embedding-2"
        );
        assert_eq!(
            config.embeddings.as_ref().unwrap().api_key_env,
            "OPENROUTER_API_KEY"
        );
        assert_eq!(config.embeddings.as_ref().unwrap().max_concurrency, 2);
        assert_eq!(config.agent.url.as_str(), "http://paperless-agent:3100/");
        assert_eq!(config.page_dpi, 150);
        let scanner = config.scanner.as_ref().unwrap();
        assert_eq!(
            (scanner.host.as_str(), scanner.port),
            ("192.168.1.218", 9400)
        );
    }

    #[test]
    fn requires_the_agent_service() {
        let error = toml::from_str::<AppConfig>(
            r#"
data_dir = "/data"
listen_addr = "0.0.0.0:3000"
queue_capacity = 16
render_concurrency = 2
eager_thumbnail_pages = 3

"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("missing field `agent`"));
    }
}
