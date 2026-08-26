use std::{path::PathBuf, time::Instant};

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
    let load_started = Instant::now();
    let harrier = Harrier::load(arguments.model_directory)?;
    let load_millis = load_started.elapsed().as_millis();
    let query_started = Instant::now();
    let query = harrier.embed_queries(&[arguments.query])?.remove(0);
    let query_millis = query_started.elapsed().as_millis();
    let document_started = Instant::now();
    let document = harrier.embed_documents(&[arguments.document])?.remove(0);
    let document_millis = document_started.elapsed().as_millis();
    let similarity: f32 = query
        .iter()
        .zip(&document)
        .map(|(left, right)| left * right)
        .sum();

    println!("model={HARRIER_MODEL_ID}");
    println!("revision={HARRIER_REVISION}");
    println!("dimensions={EMBEDDING_DIMENSION}");
    println!("query_l2={:.6}", l2(&query));
    println!("load_ms={load_millis}");
    println!("query_embedding_ms={query_millis}");
    println!("document_embedding_ms={document_millis}");
    println!("document_l2={:.6}", l2(&document));
    println!("similarity={similarity:.6}");
    Ok(())
}

fn l2(values: &[f32]) -> f32 {
    values.iter().map(|value| value * value).sum::<f32>().sqrt()
}
