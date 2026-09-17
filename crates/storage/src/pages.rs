use anyhow::{Context, Result, bail};
use chrono::DateTime;
use paperless_models::DocumentPage;
use rusqlite::params;

use crate::{DataLayout, database::Database};

#[derive(Clone)]
pub struct PageRepository {
    database: Database,
}

impl PageRepository {
    pub async fn open(layout: &DataLayout) -> Result<Self> {
        Ok(Self {
            database: Database::open(layout).await?,
        })
    }

    pub async fn replace_document_pages(
        &self,
        document_id: u64,
        pages: Vec<DocumentPage>,
    ) -> Result<()> {
        for (index, page) in pages.iter().enumerate() {
            if page.document_id != document_id {
                bail!("OCR page belongs to a different document");
            }
            let expected = index as u32 + 1;
            if page.page != expected {
                bail!("OCR pages must be contiguous from page one");
            }
        }
        let document_id = i64_value(document_id, "document id")?;
        self.database
            .run(move |connection| {
                let transaction = connection
                    .transaction()
                    .context("start OCR page transaction")?;
                transaction
                    .execute("DELETE FROM pages WHERE document_id = ?", [document_id])
                    .context("remove prior OCR pages")?;
                for page in pages {
                    transaction
                        .execute(
                            "INSERT INTO pages (document_id, page, text, blocks, html, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?)",
                            params![
                                document_id,
                                i64_value(u64::from(page.page), "page number")?,
                                page.text,
                                serde_json::to_string(&page.blocks)
                                    .context("serialize OCR page blocks")?,
                                page.html,
                                page.updated_at.timestamp_micros(),
                            ],
                        )
                        .context("store OCR page")?;
                }
                transaction
                    .commit()
                    .context("commit OCR page transaction")?;
                Ok(())
            })
            .await
    }

    pub async fn list(&self, document_id: u64) -> Result<Vec<DocumentPage>> {
        let document_id = i64_value(document_id, "document id")?;
        self.database
            .run(move |connection| {
                let mut statement = connection
                    .prepare(
                        "SELECT document_id, page, text, blocks, html, updated_at
                         FROM pages WHERE document_id = ? ORDER BY page",
                    )
                    .context("query OCR pages")?;
                let rows = statement
                    .query_map([document_id], page_from_row)
                    .context("read OCR pages")?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
                    .context("decode OCR pages")
            })
            .await
    }

    pub async fn documents_missing_layout(&self) -> Result<Vec<u64>> {
        self.database
            .run(|connection| {
                let mut statement = connection
                    .prepare(
                        "SELECT DISTINCT document_id FROM pages
                         WHERE blocks IS NULL OR html IS NULL
                         ORDER BY document_id",
                    )
                    .context("query OCR pages without layout")?;
                let rows = statement
                    .query_map([], |row| row.get::<_, i64>(0))
                    .context("read OCR pages without layout")?;
                rows.map(|row| {
                    let id = row?;
                    u64::try_from(id).map_err(|_| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Integer,
                            Box::new(std::io::Error::other("document id is negative")),
                        )
                    })
                })
                .collect::<rusqlite::Result<Vec<_>>>()
                .context("decode OCR page document ids")
            })
            .await
    }

    pub async fn delete_document(&self, document_id: u64) -> Result<()> {
        let document_id = i64_value(document_id, "document id")?;
        self.database
            .run(move |connection| {
                connection
                    .execute("DELETE FROM pages WHERE document_id = ?", [document_id])
                    .context("delete document OCR pages")?;
                Ok(())
            })
            .await
    }
}

fn page_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocumentPage> {
    let document_id = row.get::<_, i64>(0)?;
    let page = row.get::<_, i64>(1)?;
    let blocks_json = row
        .get::<_, Option<String>>(3)?
        .unwrap_or_else(|| "[]".into());
    let blocks = serde_json::from_str(&blocks_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let updated_at = DateTime::from_timestamp_micros(row.get(5)?).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            5,
            rusqlite::types::Type::Integer,
            Box::new(std::io::Error::other("invalid timestamp")),
        )
    })?;
    Ok(DocumentPage {
        document_id: u64::try_from(document_id).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Integer,
                Box::new(std::io::Error::other("document id is negative")),
            )
        })?,
        page: u32::try_from(page).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Integer,
                Box::new(std::io::Error::other("page number is outside u32 range")),
            )
        })?,
        text: row.get(2)?,
        blocks,
        html: row.get(4)?,
        updated_at,
    })
}

fn i64_value(value: u64, field: &str) -> Result<i64> {
    i64::try_from(value).with_context(|| format!("{field} exceeds SQLite integer range"))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use paperless_models::{Document, DocumentPage, IngestionStatus, MediaType, OcrBlock};

    use super::PageRepository;
    use crate::{DataLayout, DocumentRepository};

    fn document() -> Document {
        let now = Utc::now();
        Document {
            document_id: 7,
            content_hash: [7; 32],
            media_type: MediaType::Pdf,
            filename: "7.pdf".into(),
            title: None,
            sender: None,
            created_at: None,
            added_at: now,
            updated_at: now,
            title_source: None,
            sender_source: None,
            created_at_source: None,
            page_count: 2,
            file_size: 1,
            status: IngestionStatus::Stored,
            last_error: None,
            retry_count: 0,
            deleted_at: None,
        }
    }

    #[tokio::test]
    async fn replaces_pages_idempotently() {
        let temporary = tempfile::tempdir().unwrap();
        let layout = DataLayout::create(temporary.path()).await.unwrap();
        DocumentRepository::open(&layout)
            .await
            .unwrap()
            .insert(&document())
            .await
            .unwrap();
        let repository = PageRepository::open(&layout).await.unwrap();
        let first = vec![
            DocumentPage {
                document_id: 7,
                page: 1,
                text: "first".into(),
                blocks: vec![],
                html: None,
                updated_at: Utc::now(),
            },
            DocumentPage {
                document_id: 7,
                page: 2,
                text: "second".into(),
                blocks: vec![],
                html: None,
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
            html: Some(
                "<div data-label=\"Text\" data-bbox=\"10 20 900 120\"><p>replacement</p></div>"
                    .into(),
            ),
            updated_at: chrono::DateTime::from_timestamp_micros(Utc::now().timestamp_micros())
                .unwrap(),
        }];
        repository
            .replace_document_pages(7, replacement.clone())
            .await
            .unwrap();

        assert_eq!(repository.list(7).await.unwrap(), replacement);
    }

    #[tokio::test]
    async fn finds_pages_without_layout() {
        let temporary = tempfile::tempdir().unwrap();
        let layout = DataLayout::create(temporary.path()).await.unwrap();
        DocumentRepository::open(&layout)
            .await
            .unwrap()
            .insert(&document())
            .await
            .unwrap();
        let repository = PageRepository::open(&layout).await.unwrap();
        repository
            .replace_document_pages(
                7,
                vec![DocumentPage {
                    document_id: 7,
                    page: 1,
                    text: "legacy text".into(),
                    blocks: vec![],
                    html: None,
                    updated_at: Utc::now(),
                }],
            )
            .await
            .unwrap();
        assert_eq!(
            repository.documents_missing_layout().await.unwrap(),
            vec![7]
        );
    }
}
