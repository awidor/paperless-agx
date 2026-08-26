use std::{io::ErrorKind, path::PathBuf};

use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use crate::layout::DataLayout;

const COPY_BUFFER_SIZE: usize = 64 * 1024;
const TYPE_SNIFF_SIZE: usize = 512;

#[derive(Debug)]
pub struct StoredObject {
    pub content_hash: [u8; 32],
    pub file_size: u64,
    pub path: PathBuf,
    pub existed: bool,
    pub prefix: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ObjectStore {
    layout: DataLayout,
}

impl ObjectStore {
    pub fn new(layout: DataLayout) -> Self {
        Self { layout }
    }

    pub fn path(&self, hash: &[u8; 32]) -> PathBuf {
        self.layout.object_path(hash)
    }

    pub async fn store<R>(&self, mut reader: R) -> Result<StoredObject>
    where
        R: AsyncRead + Unpin,
    {
        let named = tempfile::Builder::new()
            .prefix("upload-")
            .tempfile_in(&self.layout.temporary)
            .context("create upload temporary file")?;
        let (temporary, temporary_path) = named
            .keep()
            .map_err(|error| error.error)
            .context("keep upload temporary file")?;
        let mut temporary = tokio::fs::File::from_std(temporary);
        let mut hasher = blake3::Hasher::new();
        let mut file_size = 0_u64;
        let mut prefix = Vec::with_capacity(TYPE_SNIFF_SIZE);
        let mut buffer = vec![0_u8; COPY_BUFFER_SIZE];

        loop {
            let read = reader
                .read(&mut buffer)
                .await
                .context("read upload stream")?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            temporary
                .write_all(&buffer[..read])
                .await
                .context("write upload temporary file")?;
            if prefix.len() < TYPE_SNIFF_SIZE {
                let take = (TYPE_SNIFF_SIZE - prefix.len()).min(read);
                prefix.extend_from_slice(&buffer[..take]);
            }
            file_size = file_size
                .checked_add(read as u64)
                .context("upload file is too large")?;
        }

        temporary
            .flush()
            .await
            .context("flush upload temporary file")?;
        temporary
            .sync_all()
            .await
            .context("sync upload temporary file")?;
        drop(temporary);

        let content_hash = *hasher.finalize().as_bytes();
        let destination = self.layout.object_path(&content_hash);
        let parent = destination.parent().context("object path has no parent")?;
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("create object directory {}", parent.display()))?;

        let existed = match tokio::fs::hard_link(&temporary_path, &destination).await {
            Ok(()) => false,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => true,
            Err(error) => {
                let _ = tokio::fs::remove_file(&temporary_path).await;
                return Err(error).with_context(|| {
                    format!("atomically publish object {}", destination.display())
                });
            }
        };
        tokio::fs::remove_file(&temporary_path)
            .await
            .with_context(|| format!("remove temporary file {}", temporary_path.display()))?;

        Ok(StoredObject {
            content_hash,
            file_size,
            path: destination,
            existed,
            prefix,
        })
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncReadExt;

    use super::ObjectStore;
    use crate::layout::DataLayout;

    #[tokio::test]
    async fn streams_and_deduplicates_objects() {
        let temporary = tempfile::tempdir().unwrap();
        let layout = DataLayout::create(temporary.path()).await.unwrap();
        let store = ObjectStore::new(layout);
        let content = b"%PDF-1.7\nstreamed content";

        let first = store.store(content.as_slice()).await.unwrap();
        let second = store.store(content.as_slice()).await.unwrap();

        assert!(!first.existed);
        assert!(second.existed);
        assert_eq!(first.content_hash, second.content_hash);
        assert_eq!(first.file_size, content.len() as u64);
        assert_eq!(first.prefix, content);
        let mut persisted = Vec::new();
        tokio::fs::File::open(first.path)
            .await
            .unwrap()
            .read_to_end(&mut persisted)
            .await
            .unwrap();
        assert_eq!(persisted, content);
    }
}
