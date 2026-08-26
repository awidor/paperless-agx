use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use paperless_embeddings::{EMBEDDING_DIMENSION, HARRIER_MODEL_ID, HARRIER_REVISION, Harrier};

#[derive(Debug, Parser)]
#[command(about = "Run the pinned Harrier model through the Rust inference path")]
struct Arguments {
    #[arg(long, env = "PAPERLESS_HARRIER_MODEL_DIR")]
    model_directory: PathBuf,
    #[arg(long, default_value = "summit define")]
    query: String,
    #[arg(long, default_value = "A summit is the highest point of a mountain.")]
    document: String,
}

fn main() -> Result<()> {
    let arguments = Arguments::parse();
    let harrier = Harrier::load(arguments.model_directory)?;
    let query = harrier.embed_queries(&[arguments.query])?.remove(0);
    let document = harrier.embed_documents(&[arguments.document])?.remove(0);
    let similarity: f32 = query
        .iter()
        .zip(&document)
        .map(|(left, right)| left * right)
        .sum();

    println!("model={HARRIER_MODEL_ID}");
    println!("revision={HARRIER_REVISION}");
    println!("dimensions={EMBEDDING_DIMENSION}");
    println!("query_l2={:.6}", l2(&query));
    println!("document_l2={:.6}", l2(&document));
    println!("similarity={similarity:.6}");
    Ok(())
}

fn l2(values: &[f32]) -> f32 {
    values.iter().map(|value| value * value).sum::<f32>().sqrt()
}
