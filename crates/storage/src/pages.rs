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
        connection
            .open_table(PAGES_TABLE)
            .execute()
            .await
            .context("open pages table")
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
        Field::new(
            "updated_at",
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
            false,
        ),
    ]))
}

fn page_batch(pages: &[DocumentPage]) -> Result<RecordBatch> {
    let schema = page_schema();
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
        let updated: &TimestampMicrosecondArray = column(batch, "updated_at")?;
        for row in 0..batch.num_rows() {
            pages.push(DocumentPage {
                document_id: document_ids.value(row),
                page: page_numbers.value(row),
                text: texts.value(row).to_owned(),
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
    use chrono::Utc;
    use paperless_models::DocumentPage;

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
                updated_at: Utc::now(),
            },
            DocumentPage {
                document_id: 7,
                page: 2,
                text: "second".into(),
                updated_at: Utc::now(),
            },
        ];
        repository.replace_document_pages(7, first).await.unwrap();
        let replacement = vec![DocumentPage {
            document_id: 7,
            page: 1,
            text: "replacement".into(),
            updated_at: Utc::now(),
        }];
        repository
            .replace_document_pages(7, replacement.clone())
            .await
            .unwrap();

        assert_eq!(repository.list(7).await.unwrap(), replacement);
    }
}
