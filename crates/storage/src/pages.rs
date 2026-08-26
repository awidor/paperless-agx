use std::{future::Future, sync::Arc};

use anyhow::{Context, Result, bail};
use arrow_array::{
    Array, ArrayRef, RecordBatch, RecordBatchIterator, RecordBatchReader, StringArray,
    TimestampMicrosecondArray, UInt32Array, UInt64Array,
};
use arrow_schema::{DataType, Field, Schema, SchemaRef, TimeUnit};
use chrono::DateTime;
use futures::TryStreamExt;
use lancedb::{
    Connection, Table,
    query::{ExecutableQuery, QueryBase},
    table::NewColumnTransform,
};
use paperless_models::DocumentPage;

use crate::DataLayout;

const PAGES_TABLE: &str = "pages";

#[derive(Clone)]
pub struct PageRepository {
    table: Table,
}

impl PageRepository {
    pub async fn open(layout: &DataLayout) -> Result<Self> {
        let connection = lancedb::connect(layout.lance.to_string_lossy().as_ref())
            .execute()
            .await
            .context("connect to LanceDB for pages")?;
        let table = open_or_create_pages(&connection).await?;
        Ok(Self { table })
    }

    pub fn replace_document_pages(
        &self,
        document_id: u64,
        pages: Vec<DocumentPage>,
    ) -> impl Future<Output = Result<()>> + Send + 'static {
        let table = self.table.clone();
        async move {
            for (index, page) in pages.iter().enumerate() {
                if page.document_id != document_id {
                    bail!("OCR page belongs to a different document");
                }
                let expected = index as u32 + 1;
                if page.page != expected {
                    bail!("OCR pages must be contiguous from page one");
                }
            }

            let predicate = format!("document_id = {document_id}");
            table
                .delete(&predicate)
                .await
                .context("remove prior OCR pages")?;
            if pages.is_empty() {
                return Ok(());
            }

            let batch = page_batch(&pages)?;
            let schema = batch.schema();
            let reader: Box<dyn RecordBatchReader + Send> =
                Box::new(RecordBatchIterator::new(vec![Ok(batch)], schema));
            table
                .add(reader)
                .execute()
                .await
                .context("store OCR pages")?;
            Ok(())
        }
    }

    pub async fn list(&self, document_id: u64) -> Result<Vec<DocumentPage>> {
        let batches = self
            .table
            .query()
            .only_if(format!("document_id = {document_id}"))
            .execute()
            .await
            .context("query OCR pages")?
            .try_collect::<Vec<_>>()
            .await
            .context("read OCR pages")?;
        let mut pages = pages_from_batches(&batches)?;
        pages.sort_by_key(|page| page.page);
        Ok(pages)
    }

    pub async fn documents_missing_layout(&self) -> Result<Vec<u64>> {
        let batches = self
            .table
            .query()
            .only_if("blocks IS NULL")
            .execute()
            .await
            .context("query OCR pages without layout")?
            .try_collect::<Vec<_>>()
            .await
            .context("read OCR pages without layout")?;
        let mut document_ids = Vec::new();
        for batch in batches {
            let ids: &UInt64Array = column(&batch, "document_id")?;
            document_ids.extend(ids.values().iter().copied());
        }
        document_ids.sort_unstable();
        document_ids.dedup();
        Ok(document_ids)
    }

    pub async fn delete_document(&self, document_id: u64) -> Result<()> {
        let predicate = format!("document_id = {document_id}");
        self.table
            .delete(&predicate)
            .await
            .context("delete document OCR pages")?;
        Ok(())
    }
}

async fn open_or_create_pages(connection: &Connection) -> Result<Table> {
    let names = connection
        .table_names()
        .execute()
        .await
        .context("list LanceDB tables for pages")?;
    if names.iter().any(|name| name == PAGES_TABLE) {
        let table = connection
            .open_table(PAGES_TABLE)
            .execute()
            .await
            .context("open pages table")?;
        if table.schema().await?.field_with_name("blocks").is_err() {
            table
                .add_columns()
                .transform(NewColumnTransform::AllNulls(Arc::new(Schema::new(vec![
                    Field::new("blocks", DataType::Utf8, true),
                ]))))
                .execute()
                .await
                .context("add OCR block layout column")?;
        }
        Ok(table)
    } else {
        connection
            .create_empty_table(PAGES_TABLE, page_schema())
            .execute()
            .await
            .context("create pages table")
    }
}

pub fn page_schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("document_id", DataType::UInt64, false),
        Field::new("page", DataType::UInt32, false),
        Field::new("text", DataType::Utf8, false),
        Field::new("blocks", DataType::Utf8, true),
        Field::new(
            "updated_at",
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
            false,
        ),
    ]))
}

fn page_batch(pages: &[DocumentPage]) -> Result<RecordBatch> {
    let schema = page_schema();
    let blocks = pages
        .iter()
        .map(|page| serde_json::to_string(&page.blocks).context("serialize OCR page blocks"))
        .collect::<Result<Vec<_>>>()?;
    let columns: Vec<ArrayRef> = vec![
        Arc::new(UInt64Array::from_iter_values(
            pages.iter().map(|page| page.document_id),
        )),
        Arc::new(UInt32Array::from_iter_values(
            pages.iter().map(|page| page.page),
        )),
        Arc::new(StringArray::from_iter_values(
            pages.iter().map(|page| page.text.as_str()),
        )),
        Arc::new(StringArray::from_iter_values(
            blocks.iter().map(String::as_str),
        )),
        Arc::new(
            TimestampMicrosecondArray::from_iter_values(
                pages.iter().map(|page| page.updated_at.timestamp_micros()),
            )
            .with_timezone("UTC"),
        ),
    ];
    RecordBatch::try_new(schema, columns).context("build OCR page batch")
}

fn pages_from_batches(batches: &[RecordBatch]) -> Result<Vec<DocumentPage>> {
    let mut pages = Vec::new();
    for batch in batches {
        let document_ids: &UInt64Array = column(batch, "document_id")?;
        let page_numbers: &UInt32Array = column(batch, "page")?;
        let texts: &StringArray = column(batch, "text")?;
        let blocks: &StringArray = column(batch, "blocks")?;
        let updated: &TimestampMicrosecondArray = column(batch, "updated_at")?;
        for row in 0..batch.num_rows() {
            pages.push(DocumentPage {
                document_id: document_ids.value(row),
                page: page_numbers.value(row),
                text: texts.value(row).to_owned(),
                blocks: if blocks.is_null(row) {
                    Vec::new()
                } else {
                    serde_json::from_str(blocks.value(row))
                        .context("parse stored OCR page blocks")?
                },
                updated_at: DateTime::from_timestamp_micros(updated.value(row))
                    .context("stored OCR page has an invalid timestamp")?,
            });
        }
    }
    Ok(pages)
}

fn column<'a, T: Array + 'static>(batch: &'a RecordBatch, name: &str) -> Result<&'a T> {
    batch
        .column_by_name(name)
        .with_context(|| format!("OCR page batch has no {name} column"))?
        .as_any()
        .downcast_ref::<T>()
        .with_context(|| format!("OCR page column {name} has the wrong Arrow type"))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow_array::{
        ArrayRef, RecordBatch, RecordBatchIterator, RecordBatchReader, StringArray,
        TimestampMicrosecondArray, UInt32Array, UInt64Array,
    };
    use arrow_schema::{DataType, Field, Schema, TimeUnit};
    use chrono::Utc;
    use paperless_models::{DocumentPage, OcrBlock};

    use super::PageRepository;
    use crate::DataLayout;

    #[tokio::test]
    async fn replaces_pages_idempotently() {
        let temporary = tempfile::tempdir().unwrap();
        let layout = DataLayout::create(temporary.path()).await.unwrap();
        let repository = PageRepository::open(&layout).await.unwrap();
        let first = vec![
            DocumentPage {
                document_id: 7,
                page: 1,
                text: "first".into(),
                blocks: vec![],
                updated_at: Utc::now(),
            },
            DocumentPage {
                document_id: 7,
                page: 2,
                text: "second".into(),
                blocks: vec![],
                updated_at: Utc::now(),
            },
        ];
        repository.replace_document_pages(7, first).await.unwrap();
        let replacement = vec![DocumentPage {
            document_id: 7,
            page: 1,
            text: "replacement".into(),
            blocks: vec![OcrBlock {
                label: "Text".into(),
                bbox: [10, 20, 900, 120],
                text: "replacement".into(),
            }],
            updated_at: Utc::now(),
        }];
        repository
            .replace_document_pages(7, replacement.clone())
            .await
            .unwrap();

        assert_eq!(repository.list(7).await.unwrap(), replacement);
    }

    #[tokio::test]
    async fn adds_layout_storage_to_existing_page_tables() {
        let temporary = tempfile::tempdir().unwrap();
        let layout = DataLayout::create(temporary.path()).await.unwrap();
        let connection = lancedb::connect(layout.lance.to_string_lossy().as_ref())
            .execute()
            .await
            .unwrap();
        let schema = Arc::new(Schema::new(vec![
            Field::new("document_id", DataType::UInt64, false),
            Field::new("page", DataType::UInt32, false),
            Field::new("text", DataType::Utf8, false),
            Field::new(
                "updated_at",
                DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
                false,
            ),
        ]));
        let columns: Vec<ArrayRef> = vec![
            Arc::new(UInt64Array::from(vec![7])),
            Arc::new(UInt32Array::from(vec![1])),
            Arc::new(StringArray::from(vec!["legacy text"])),
            Arc::new(
                TimestampMicrosecondArray::from(vec![Utc::now().timestamp_micros()])
                    .with_timezone("UTC"),
            ),
        ];
        let batch = RecordBatch::try_new(schema.clone(), columns).unwrap();
        let reader: Box<dyn RecordBatchReader + Send> =
            Box::new(RecordBatchIterator::new(vec![Ok(batch)], schema));
        connection
            .create_table("pages", reader)
            .execute()
            .await
            .unwrap();

        let repository = PageRepository::open(&layout).await.unwrap();
        assert_eq!(
            repository.documents_missing_layout().await.unwrap(),
            vec![7]
        );
        assert!(repository.list(7).await.unwrap()[0].blocks.is_empty());
    }
}
