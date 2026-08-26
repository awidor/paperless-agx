use std::path::PathBuf;

use paperless_embeddings::{EMBEDDING_DIMENSION, Harrier};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Reference {
    kind: String,
    text: String,
    embedding: Vec<f32>,
}

#[test]
fn rust_runtime_matches_transformers_references() {
    let Some(model_directory) = std::env::var_os("PAPERLESS_HARRIER_MODEL_DIR").map(PathBuf::from)
    else {
        eprintln!("PAPERLESS_HARRIER_MODEL_DIR is not set; skipping model asset test");
        return;
    };
    let references: Vec<Reference> =
        serde_json::from_str(include_str!("fixtures/harrier-references.json")).unwrap();
    let model = Harrier::load(model_directory).unwrap();

    for reference in references {
        assert_eq!(reference.embedding.len(), EMBEDDING_DIMENSION);
        let actual = match reference.kind.as_str() {
            "query" => model
                .embed_queries(&[reference.text.clone()])
                .unwrap()
                .remove(0),
            "document" => model
                .embed_documents(&[reference.text.clone()])
                .unwrap()
                .remove(0),
            kind => panic!("unknown reference kind {kind}"),
        };
        assert_eq!(actual.len(), EMBEDDING_DIMENSION);
        let cosine: f32 = actual
            .iter()
            .zip(&reference.embedding)
            .map(|(left, right)| left * right)
            .sum();
        let max_absolute_error = actual
            .iter()
            .zip(&reference.embedding)
            .map(|(left, right)| (left - right).abs())
            .fold(0.0_f32, f32::max);
        assert!(
            cosine > 0.999,
            "{} reference cosine was {cosine}",
            reference.kind
        );
        assert!(
            max_absolute_error < 0.02,
            "{} reference maximum error was {max_absolute_error}",
            reference.kind
        );
    }
}
