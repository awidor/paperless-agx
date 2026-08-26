use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use candle_core::{DType, Device, IndexOp, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::qwen3::{Config, Model};
use tokenizers::Tokenizer;

pub const HARRIER_MODEL_ID: &str = "microsoft/harrier-oss-v1-0.6b";
pub const HARRIER_REVISION: &str = "f9b9dc8d367d443f2479d27aa5d8d2850c0774ee";
pub const EMBEDDING_DIMENSION: usize = 1024;
pub const QUERY_TASK: &str =
    "Given a web search query, retrieve relevant passages that answer the query";

pub fn query_input(query: &str) -> String {
    format!("Instruct: {QUERY_TASK}\nQuery: {query}")
}

pub fn document_input(document: &str) -> &str {
    document
}

pub fn l2_normalize(tensor: &Tensor) -> candle_core::Result<Tensor> {
    let tensor = tensor.to_dtype(DType::F32)?;
    let norm = tensor.sqr()?.sum_keepdim(1)?.sqrt()?;
    tensor.broadcast_div(&norm)
}

pub fn last_token_pool(
    last_hidden_states: &Tensor,
    attention_mask: &Tensor,
) -> candle_core::Result<Tensor> {
    let (batch_size, sequence_length, _) = last_hidden_states.dims3()?;
    let masks = attention_mask.to_vec2::<u32>()?;
    if masks.len() != batch_size || masks.iter().any(|mask| mask.len() != sequence_length) {
        candle_core::bail!("attention mask shape does not match hidden states")
    }

    let left_padded = masks.iter().all(|mask| mask.last() == Some(&1));
    let mut rows = Vec::with_capacity(batch_size);
    for (row, mask) in masks.iter().enumerate() {
        let token = if left_padded {
            sequence_length - 1
        } else {
            mask.iter()
                .map(|value| *value as usize)
                .sum::<usize>()
                .checked_sub(1)
                .ok_or_else(|| candle_core::Error::Msg("attention mask has no tokens".into()))?
        };
        rows.push(last_hidden_states.i((row, token, ..))?.unsqueeze(0)?);
    }
    Tensor::cat(&rows, 0)
}

pub struct Harrier {
    model: Model,
    tokenizer: Tokenizer,
    device: Device,
    max_tokens: usize,
}

impl Harrier {
    pub fn load(model_directory: impl AsRef<Path>) -> Result<Self> {
        let model_directory = model_directory.as_ref();
        let config_path = model_directory.join("config.json");
        let tokenizer_path = model_directory.join("tokenizer.json");
        let weights_path = model_directory.join("model.safetensors");

        for path in [&config_path, &tokenizer_path, &weights_path] {
            if !path.is_file() {
                bail!("missing Harrier asset: {}", path.display());
            }
        }

        let config: Config = serde_json::from_slice(
            &std::fs::read(&config_path)
                .with_context(|| format!("read {}", config_path.display()))?,
        )
        .with_context(|| format!("parse {}", config_path.display()))?;
        if config.hidden_size != EMBEDDING_DIMENSION {
            bail!(
                "Harrier hidden size is {}, expected {EMBEDDING_DIMENSION}",
                config.hidden_size
            );
        }

        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|error| anyhow::anyhow!("load {}: {error}", tokenizer_path.display()))?;
        let device = Device::Cpu;
        let variable_builder =
            unsafe { VarBuilder::from_mmaped_safetensors(&[weights_path], DType::F32, &device) }
                .context("map Harrier safetensors")?
                .rename_f(|name| name.strip_prefix("model.").unwrap_or(name).to_owned());
        let model = Model::new(&config, variable_builder).context("load Harrier Qwen3 model")?;

        Ok(Self {
            model,
            tokenizer,
            device,
            max_tokens: config.max_position_embeddings,
        })
    }

    pub fn embed_documents(&self, documents: &[String]) -> Result<Vec<Vec<f32>>> {
        documents
            .iter()
            .map(|document| self.embed(document_input(document)))
            .collect()
    }

    pub fn embed_queries(&self, queries: &[String]) -> Result<Vec<Vec<f32>>> {
        queries
            .iter()
            .map(|query| self.embed(&query_input(query)))
            .collect()
    }

    pub fn embed(&self, input: &str) -> Result<Vec<f32>> {
        let encoding = self
            .tokenizer
            .encode(input, true)
            .map_err(|error| anyhow::anyhow!("tokenize Harrier input: {error}"))?;
        let token_ids = encoding.get_ids();
        if token_ids.is_empty() {
            bail!("Harrier input produced no tokens");
        }
        if token_ids.len() > self.max_tokens {
            bail!(
                "Harrier input has {} tokens, maximum is {}",
                token_ids.len(),
                self.max_tokens
            );
        }

        let input = Tensor::new(token_ids, &self.device)?.unsqueeze(0)?;
        let mut model = self.model.clone();
        let hidden_states = model
            .forward(&input, 0)
            .context("run Harrier Qwen3 forward pass")?;
        let attention_mask = Tensor::ones((1, token_ids.len()), DType::U32, &self.device)?;
        let pooled = last_token_pool(&hidden_states, &attention_mask)?;
        let normalized = l2_normalize(&pooled)?;
        let embedding = normalized.squeeze(0)?.to_vec1::<f32>()?;
        if embedding.len() != EMBEDDING_DIMENSION {
            bail!(
                "Harrier returned {} dimensions, expected {EMBEDDING_DIMENSION}",
                embedding.len()
            );
        }
        Ok(embedding)
    }
}

pub fn required_asset_paths(model_directory: impl AsRef<Path>) -> [PathBuf; 3] {
    let directory = model_directory.as_ref();
    [
        directory.join("config.json"),
        directory.join("tokenizer.json"),
        directory.join("model.safetensors"),
    ]
}

#[cfg(test)]
mod tests {
    use candle_core::{Device, Tensor};

    use super::{EMBEDDING_DIMENSION, document_input, l2_normalize, last_token_pool, query_input};

    #[test]
    fn query_has_required_instruction_and_document_has_none() {
        assert_eq!(
            query_input("summit define"),
            "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: summit define"
        );
        assert_eq!(document_input("summit definition"), "summit definition");
    }

    #[test]
    fn pools_last_non_padding_token_for_right_padding() {
        let hidden = Tensor::from_vec(
            vec![1_f32, 2., 3., 4., 5., 6., 7., 8., 9., 10., 11., 12.],
            (2, 3, 2),
            &Device::Cpu,
        )
        .unwrap();
        let mask = Tensor::from_vec(vec![1_u32, 1, 0, 1, 1, 1], (2, 3), &Device::Cpu).unwrap();
        let pooled = last_token_pool(&hidden, &mask)
            .unwrap()
            .to_vec2::<f32>()
            .unwrap();
        assert_eq!(pooled, vec![vec![3., 4.], vec![11., 12.]]);
    }

    #[test]
    fn pools_last_token_for_left_padding() {
        let hidden = Tensor::from_vec(
            vec![1_f32, 2., 3., 4., 5., 6., 7., 8., 9., 10., 11., 12.],
            (2, 3, 2),
            &Device::Cpu,
        )
        .unwrap();
        let mask = Tensor::from_vec(vec![0_u32, 1, 1, 1, 1, 1], (2, 3), &Device::Cpu).unwrap();
        let pooled = last_token_pool(&hidden, &mask)
            .unwrap()
            .to_vec2::<f32>()
            .unwrap();
        assert_eq!(pooled, vec![vec![5., 6.], vec![11., 12.]]);
    }

    #[test]
    fn normalizes_each_embedding() {
        let input =
            Tensor::from_vec(vec![3_f32, 4., 0., 0., 0., 5.], (2, 3), &Device::Cpu).unwrap();
        let normalized = l2_normalize(&input).unwrap().to_vec2::<f32>().unwrap();
        assert_eq!(normalized[0], vec![0.6, 0.8, 0.0]);
        assert_eq!(normalized[1], vec![0.0, 0.0, 1.0]);
    }

    #[test]
    fn selected_model_dimension_is_1024() {
        assert_eq!(EMBEDDING_DIMENSION, 1024);
    }
}
