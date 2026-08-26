use std::path::PathBuf;

use paperless_embeddings::Harrier;
use paperless_search::{
    SpikeChunk, collapse_to_documents, create_spike_table, lexical_search, reciprocal_rank_fusion,
    vector_search,
};

#[tokio::test]
async fn lance_retrieves_real_harrier_embeddings() {
    let Some(model_directory) = std::env::var_os("PAPERLESS_HARRIER_MODEL_DIR").map(PathBuf::from)
    else {
        eprintln!("PAPERLESS_HARRIER_MODEL_DIR is not set; skipping model asset test");
        return;
    };
    let texts = vec![
        "Invoice for mountain safety equipment. Payment is due in thirty days.".to_owned(),
        "A summit is the highest point of a mountain.".to_owned(),
        "The train timetable changes on Sunday.".to_owned(),
    ];
    let harrier = Harrier::load(model_directory).unwrap();
    let embeddings = harrier.embed_documents(&texts).unwrap();
    let query = harrier
        .embed_queries(&["summit define".to_owned()])
        .unwrap()
        .remove(0);
    let chunks: Vec<_> = texts
        .into_iter()
        .zip(embeddings)
        .enumerate()
        .map(|(index, (text, embedding))| SpikeChunk {
            chunk_id: index as u64 + 1,
            document_id: index as u64 + 10,
            document_type: if index == 0 { "invoice" } else { "reference" }.into(),
            text,
            created_at_micros: 1_700_000_000_000_000 + index as i64,
            embedding,
        })
        .collect();
    let temporary = tempfile::tempdir().unwrap();
    let connection = lancedb::connect(temporary.path().to_string_lossy().as_ref())
        .execute()
        .await
        .unwrap();
    let table = create_spike_table(&connection, &chunks).await.unwrap();

    let vector = vector_search(&table, &query, None, 3).await.unwrap();
    assert_eq!(vector[0].chunk_id, 2);
    let lexical = lexical_search(&table, "invoice", None, 3).await.unwrap();
    assert_eq!(lexical[0].chunk_id, 1);
    let filtered = vector_search(&table, &query, Some("document_type = 'invoice'"), 3)
        .await
        .unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].chunk_id, 1);

    let fused = reciprocal_rank_fusion(&lexical, &vector, 60.0);
    let documents = collapse_to_documents(&fused);
    assert_eq!(documents.len(), 3);
    assert_eq!(documents[0].best_chunk_id, 1);
}
