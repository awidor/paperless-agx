use std::sync::Arc;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

pub const HARRIER_MODEL_ID: &str = "microsoft/harrier-oss-v1-0.6b";
pub const HARRIER_MODEL_ALIAS: &str = "harrier";
pub const EMBEDDING_DIMENSION: usize = 1024;
pub const QUERY_TASK: &str =
    "Given a web search query, retrieve relevant passages that answer the query";

pub fn query_input(query: &str) -> String {
    format!("Instruct: {QUERY_TASK}\nQuery: {query}")
}

pub fn document_input(document: &str) -> &str {
    document
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
            .with_context(|| format!("read embedding API key from {api_key_env}"))?;
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
        Ok(Self {
            client: reqwest::Client::new(),
            endpoint: Arc::from(format!("{base_url}/embeddings")),
            model: Arc::from(model.into()),
            api_key: Arc::from(api_key.into()),
            gate: Arc::new(Semaphore::new(max_concurrency)),
        })
    }

    pub async fn embed_documents(&self, documents: Vec<String>) -> Result<Vec<Vec<f32>>> {
        self.embed_batch(
            documents
                .iter()
                .map(|document| document_input(document).to_owned())
                .collect(),
        )
        .await
    }

    pub async fn embed_query(&self, query: String) -> Result<Vec<f32>> {
        self.embed_batch(vec![query_input(&query)])
            .await?
            .pop()
            .context("Harrier returned no query embedding")
    }

    async fn embed_batch(&self, inputs: Vec<String>) -> Result<Vec<Vec<f32>>> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        let _permit = self
            .gate
            .clone()
            .acquire_owned()
            .await
            .context("embedding gate closed")?;
        let request = EmbeddingRequest {
            model: self.model.as_ref(),
            input: &inputs,
        };
        let response = self
            .client
            .post(self.endpoint.as_ref())
            .bearer_auth(self.api_key.as_ref())
            .json(&request)
            .send()
            .await
            .context("send Harrier embedding request")?;
        let status = response.status();
        let body = response
            .text()
            .await
            .context("read Harrier embedding response")?;
        if !status.is_success() {
            bail!("Harrier embedding request failed with {status}: {body}");
        }
        let mut result: EmbeddingResponse =
            serde_json::from_str(&body).with_context(|| "parse Harrier embedding response")?;
        result.data.sort_by_key(|item| item.index);
        if result.data.len() != inputs.len() {
            bail!(
                "Harrier returned {} embeddings for {} inputs",
                result.data.len(),
                inputs.len()
            );
        }
        result
            .data
            .into_iter()
            .map(|item| normalize_embedding(item.embedding))
            .collect()
    }
}

#[derive(Debug, Serialize)]
struct EmbeddingRequest<'a> {
    model: &'a str,
    input: &'a [String],
}

#[derive(Debug, Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingItem>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingItem {
    embedding: Vec<f32>,
    index: usize,
}

fn normalize_embedding(embedding: Vec<f32>) -> Result<Vec<f32>> {
    if embedding.len() != EMBEDDING_DIMENSION {
        bail!(
            "Harrier returned {} dimensions, expected {EMBEDDING_DIMENSION}",
            embedding.len()
        );
    }
    if embedding.iter().any(|value| !value.is_finite()) {
        bail!("Harrier returned a non-finite embedding value");
    }
    let norm = embedding
        .iter()
        .map(|value| value * value)
        .sum::<f32>()
        .sqrt();
    if !norm.is_finite() || norm == 0.0 {
        bail!("Harrier returned an embedding with no usable norm");
    }
    Ok(embedding.into_iter().map(|value| value / norm).collect())
}

#[cfg(test)]
mod tests {
    use super::{EMBEDDING_DIMENSION, document_input, normalize_embedding, query_input};

    #[test]
    fn query_has_required_instruction_and_document_has_none() {
        assert_eq!(
            query_input("summit define"),
            "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: summit define"
        );
        assert_eq!(document_input("summit definition"), "summit definition");
    }

    #[test]
    fn normalizes_and_checks_embedding_shape() {
        let mut values = vec![0.0; EMBEDDING_DIMENSION];
        values[0] = 3.0;
        values[1] = 4.0;
        let normalized = normalize_embedding(values).unwrap();
        assert_eq!(normalized[0], 0.6);
        assert_eq!(normalized[1], 0.8);
    }

    #[test]
    fn rejects_invalid_embedding_shape() {
        let error = normalize_embedding(vec![1.0]).unwrap_err();
        assert!(error.to_string().contains("1024"));
    }
}
