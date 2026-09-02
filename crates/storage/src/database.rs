use std::{path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};

use crate::DataLayout;

#[derive(Clone)]
pub(crate) struct Database {
    path: Arc<PathBuf>,
}

impl Database {
    pub(crate) async fn open(layout: &DataLayout) -> Result<Self> {
        let database = Self {
            path: Arc::new(layout.database.clone()),
        };
        database
            .run(|connection| initialize(connection))
            .await
            .context("initialize SQLite store")?;
        Ok(database)
    }

    pub(crate) async fn run<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = Connection::open_with_flags(
                path.as_ref(),
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_CREATE
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .with_context(|| format!("open SQLite store {}", path.display()))?;
            configure(&mut connection)?;
            operation(&mut connection)
        })
        .await
        .context("join SQLite store operation")?
    }
}

fn configure(connection: &mut Connection) -> Result<()> {
    connection
        .busy_timeout(std::time::Duration::from_secs(30))
        .context("set SQLite busy timeout")?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;\n\
             PRAGMA journal_mode = WAL;\n\
             PRAGMA synchronous = NORMAL;\n\
             PRAGMA temp_store = MEMORY;",
        )
        .context("configure SQLite store")?;
    Ok(())
}

fn initialize(connection: &mut Connection) -> Result<()> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS documents (\n\
                 document_id INTEGER PRIMARY KEY,\n\
                 content_hash BLOB NOT NULL CHECK(length(content_hash) = 32),\n\
                 media_type TEXT NOT NULL,\n\
                 filename TEXT NOT NULL,\n\
                 title TEXT,\n\
                 sender TEXT,\n\
                 created_at INTEGER,\n\
                 added_at INTEGER NOT NULL,\n\
                 updated_at INTEGER NOT NULL,\n\
                 title_source TEXT,\n\
                 sender_source TEXT,\n\
                 created_at_source TEXT,\n\
                 page_count INTEGER NOT NULL,\n\
                 file_size INTEGER NOT NULL,\n\
                 status TEXT NOT NULL,\n\
                 last_error TEXT,\n\
                 retry_count INTEGER NOT NULL,\n\
                 deleted_at INTEGER\n\
             );\n\
             CREATE UNIQUE INDEX IF NOT EXISTS documents_active_hash\n\
                 ON documents(content_hash) WHERE deleted_at IS NULL;\n\
             CREATE INDEX IF NOT EXISTS documents_status ON documents(status, deleted_at);\n\
             CREATE TABLE IF NOT EXISTS pages (\n\
                 document_id INTEGER NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,\n\
                 page INTEGER NOT NULL,\n\
                 text TEXT NOT NULL,\n\
                 blocks TEXT,\n\
                 html TEXT,\n\
                 updated_at INTEGER NOT NULL,\n\
                 PRIMARY KEY(document_id, page)\n\
             );\n\
             CREATE TABLE IF NOT EXISTS chunks (\n\
                 chunk_id INTEGER PRIMARY KEY,\n\
                 document_id INTEGER NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,\n\
                 page_start INTEGER NOT NULL,\n\
                 page_end INTEGER NOT NULL,\n\
                 char_start INTEGER NOT NULL,\n\
                 char_end INTEGER NOT NULL,\n\
                 text TEXT NOT NULL,\n\
                 embedding BLOB NOT NULL CHECK(length(embedding) = 4096),\n\
                 created_at INTEGER,\n\
                 sender TEXT\n\
             );\n\
             CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id, chunk_id);\n\
             CREATE INDEX IF NOT EXISTS chunks_sender_date ON chunks(sender, created_at);\n\
             CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(\n\
                 text, content='chunks', content_rowid='chunk_id', tokenize='unicode61'\n\
             );\n\
             CREATE TRIGGER IF NOT EXISTS chunks_insert AFTER INSERT ON chunks BEGIN\n\
                 INSERT INTO chunks_fts(rowid, text) VALUES (new.chunk_id, new.text);\n\
             END;\n\
             CREATE TRIGGER IF NOT EXISTS chunks_delete AFTER DELETE ON chunks BEGIN\n\
                 INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.chunk_id, old.text);\n\
             END;\n\
             CREATE TRIGGER IF NOT EXISTS chunks_update AFTER UPDATE OF text ON chunks BEGIN\n\
                 INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.chunk_id, old.text);\n\
                 INSERT INTO chunks_fts(rowid, text) VALUES (new.chunk_id, new.text);\n\
             END;",
        )
        .context("create SQLite schema")?;
    Ok(())
}
