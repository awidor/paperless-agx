use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct DataLayout {
    pub root: PathBuf,
    pub objects: PathBuf,
    pub lance: PathBuf,
    pub thumbnails: PathBuf,
    pub temporary: PathBuf,
}

impl DataLayout {
    pub async fn create(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        let layout = Self {
            objects: root.join("objects"),
            lance: root.join("lance"),
            thumbnails: root.join("thumbnails"),
            temporary: root.join("tmp"),
            root,
        };
        for directory in [
            &layout.root,
            &layout.objects,
            &layout.lance,
            &layout.thumbnails,
            &layout.temporary,
        ] {
            tokio::fs::create_dir_all(directory)
                .await
                .with_context(|| format!("create data directory {}", directory.display()))?;
        }
        Ok(layout)
    }

    pub fn object_path(&self, hash: &[u8; 32]) -> PathBuf {
        let hex = hash_hex(hash);
        self.objects.join(&hex[..2]).join(hex)
    }

    pub fn thumbnail_directory(&self, document_id: u64) -> PathBuf {
        self.thumbnails.join(document_id.to_string())
    }

    pub fn thumbnail_path(&self, document_id: u64, page: u32) -> PathBuf {
        self.thumbnail_directory(document_id)
            .join(format!("{page}.webp"))
    }
}

pub fn hash_hex(hash: &[u8; 32]) -> String {
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::DataLayout;

    #[tokio::test]
    async fn creates_all_persistent_directories() {
        let temporary = tempfile::tempdir().unwrap();
        let layout = DataLayout::create(temporary.path()).await.unwrap();
        assert!(layout.objects.is_dir());
        assert!(layout.lance.is_dir());
        assert!(layout.thumbnails.is_dir());
        assert!(layout.temporary.is_dir());
        assert_eq!(
            layout.object_path(&[2; 32]),
            layout.objects.join("02").join("02".repeat(32))
        );
    }
}
