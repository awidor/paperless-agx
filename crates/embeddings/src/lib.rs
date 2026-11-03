use std::sync::Arc;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

pub use paperless_models::EMBEDDING_DIMENSION;

/// Asymmetric retrieval prompt for search queries, as documented for `gemini-embedding-2`.
pub fn query_input(query: &str) -> String {
    format!("task: search result | query: {query}")
}

/// Asymmetric retrieval prompt for indexed passages, as documented for `gemini-embedding-2`.
pub fn document_input(title: Option<&str>, text: &str) -> String {
    let title = title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or("none");
    format!("title: {title} | text: {text}")
}

#[derive(Clone)]
pub struct EmbeddingService {
    client: reqwest::Client,
    endpoint: Arc<str>,
    model: Arc<str>,
    api_key: Arc<str>,
    gate: Arc<Semaphore>,
}

impl EmbeddingService {
    pub fn from_environment(
        base_url: impl AsRef<str>,
        model: impl Into<String>,
        api_key_env: impl AsRef<str>,
        max_concurrency: usize,
    ) -> Result<Self> {
        let api_key_env = api_key_env.as_ref();
        let api_key = std::env::var(api_key_env)
            .ok()
            .filter(|key| !key.trim().is_empty())
            .with_context(|| format!("embedding API key {api_key_env} is not set"))?;
        Self::new(base_url, model, api_key, max_concurrency)
    }

    pub fn new(
        base_url: impl AsRef<str>,
        model: impl Into<String>,
        api_key: impl Into<String>,
        max_concurrency: usize,
    ) -> Result<Self> {
        if max_concurrency == 0 {
            bail!("embedding max_concurrency must be greater than zero");
        }
        let base_url = base_url.as_ref().trim_end_matches('/');
        if base_url.is_empty() {
            bail!("embedding base_url must not be empty");
        }
        let model = model.into().trim().to_owned();
        if model.is_empty() {
            bail!("embedding model must not be empty");
        }
        Ok(Self {
            client: reqwest::Client::new(),
            endpoint: Arc::from(format!("{base_url}/embeddings")),
            model: Arc::from(model),
            api_key: Arc::from(api_key.into()),
            gate: Arc::new(Semaphore::new(max_concurrency)),
        })
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// Identifies the vector space stored chunks belong to; a change requires re-embedding.
    pub fn vector_space(&self) -> String {
        format!("{}:{EMBEDDING_DIMENSION}", self.model)
    }

    /// Embeds passages, each paired with the title of the document it belongs to.
    pub async fn embed_documents(
        &self,
        passages: Vec<(Option<String>, String)>,
    ) -> Result<Vec<Vec<f32>>> {
        self.embed_inputs(
            passages
                .iter()
                .map(|(title, text)| document_input(title.as_deref(), text))
                .collect(),
        )
        .await
    }

    pub async fn embed_query(&self, query: String) -> Result<Vec<f32>> {
        self.embed_inputs(vec![query_input(&query)])
            .await?
            .pop()
            .context("embedding service returned no query embedding")
    }

    /// Sends one input per request: OpenRouter only routes batched `gemini-embedding-2`
    /// requests to Google AI Studio, which the zero-data-retention policy excludes, while
    /// single inputs reach Google Vertex. The gate bounds how many run at once.
    async fn embed_inputs(&self, inputs: Vec<String>) -> Result<Vec<Vec<f32>>> {
        futures::future::try_join_all(inputs.iter().map(|input| self.embed_one(input))).await
    }

    async fn embed_one(&self, input: &str) -> Result<Vec<f32>> {
        let _permit = self
            .gate
            .clone()
            .acquire_owned()
            .await
            .context("embedding gate closed")?;
        let request = EmbeddingRequest {
            model: &self.model,
            input,
            encoding_format: "float",
            provider: ProviderPreferences {
                zdr: true,
                data_collection: "deny",
            },
        };
        let response = self
            .client
            .post(self.endpoint.as_ref())
            .bearer_auth(self.api_key.as_ref())
            .json(&request)
            .send()
            .await
            .context("send embedding request")?;
        let status = response.status();
        let body = response.text().await.context("read embedding response")?;
        if !status.is_success() {
            bail!("embedding request failed with {status}: {body}");
        }
        let result: EmbeddingResponse =
            serde_json::from_str(&body).context("parse embedding response")?;
        let [item] = <[EmbeddingItem; 1]>::try_from(result.data).map_err(|data| {
            anyhow::anyhow!(
                "embedding service returned {} embeddings for one input",
                data.len()
            )
        })?;
        normalize_embedding(item.embedding)
    }
}

#[derive(Debug, Serialize)]
struct EmbeddingRequest<'a> {
    model: &'a str,
    input: &'a str,
    encoding_format: &'static str,
    provider: ProviderPreferences,
}

/// Same privacy routing as metadata and answers: only zero-data-retention endpoints that
/// do not collect prompts (for `google/gemini-embedding-2`, Google Vertex).
#[derive(Debug, Serialize)]
struct ProviderPreferences {
    zdr: bool,
    data_collection: &'static str,
}

#[derive(Debug, Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingItem>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingItem {
    embedding: Vec<f32>,
}

fn normalize_embedding(embedding: Vec<f32>) -> Result<Vec<f32>> {
    if embedding.len() != EMBEDDING_DIMENSION {
        bail!(
            "embedding service returned {} dimensions, expected {EMBEDDING_DIMENSION}",
            embedding.len()
        );
    }
    if embedding.iter().any(|value| !value.is_finite()) {
        bail!("embedding service returned a non-finite embedding value");
    }
    let norm = embedding
        .iter()
        .map(|value| value * value)
        .sum::<f32>()
        .sqrt();
    if !norm.is_finite() || norm == 0.0 {
        bail!("embedding service returned an embedding with no usable norm");
    }
    Ok(embedding.into_iter().map(|value| value / norm).collect())
}

#[cfg(test)]
mod tests {
    use super::{EMBEDDING_DIMENSION, document_input, normalize_embedding, query_input};

    #[test]
    fn formats_gemini_retrieval_prompts() {
        assert_eq!(
            query_input("summit define"),
            "task: search result | query: summit define"
        );
        assert_eq!(
            document_input(Some("Beitragsbescheid"), "Ihr Beitrag"),
            "title: Beitragsbescheid | text: Ihr Beitrag"
        );
        assert_eq!(
            document_input(Some("  "), "Ihr Beitrag"),
            "title: none | text: Ihr Beitrag"
        );
    }

    #[test]
    fn normalizes_and_checks_embedding_shape() {
        let mut values = vec![0.0; EMBEDDING_DIMENSION];
        values[0] = 3.0;
        values[1] = 4.0;
        let normalized = normalize_embedding(values).unwrap();
        assert_eq!(normalized[0], 0.6);
        assert_eq!(normalized[1], 0.8);
        let error = normalize_embedding(vec![1.0]).unwrap_err();
        assert!(error.to_string().contains("3072"));
    }
}
