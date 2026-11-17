use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result, bail};
use image::{DynamicImage, ImageFormat, ImageReader};
use paperless_models::{Document, MediaType};
use paperless_storage::DataLayout;
use tokio::{process::Command, sync::Semaphore};

const THUMBNAIL_WIDTH: u32 = 320;
const THUMBNAIL_HEIGHT: u32 = 480;

#[derive(Clone)]
pub struct PreviewService {
    layout: DataLayout,
    render_gate: Arc<Semaphore>,
    eager_thumbnail_pages: u32,
    /// Resolution PDF pages are rendered at for the indexing agent and the page viewer.
    page_dpi: u32,
}

impl PreviewService {
    pub fn new(
        layout: DataLayout,
        render_concurrency: usize,
        eager_thumbnail_pages: u32,
        page_dpi: u32,
    ) -> Result<Self> {
        if render_concurrency == 0 {
            bail!("render_concurrency must be greater than zero");
        }
        if page_dpi == 0 {
            bail!("page_dpi must be greater than zero");
        }
        Ok(Self {
            layout,
            render_gate: Arc::new(Semaphore::new(render_concurrency)),
            eager_thumbnail_pages,
            page_dpi,
        })
    }

    pub async fn prepare(&self, document: &Document) -> Result<u32> {
        let source = self.layout.object_path(&document.content_hash);
        let page_count = match document.media_type {
            MediaType::Pdf => self.pdf_page_count(&source).await?,
            MediaType::Image => 1,
        };
        for page in 1..=page_count.min(self.eager_thumbnail_pages) {
            self.generate_thumbnail(document, page).await?;
        }
        Ok(page_count)
    }
    pub fn prepare_owned(
        &self,
        document: Document,
    ) -> impl Future<Output = Result<u32>> + Send + 'static {
        let service = self.clone();
        async move { service.prepare(&document).await }
    }

    pub async fn ensure_thumbnail(&self, document: &Document, page: u32) -> Result<PathBuf> {
        if page == 0 || (document.page_count != 0 && page > document.page_count) {
            bail!("page {page} is outside document page range");
        }
        let target = self.layout.thumbnail_path(document.document_id, page);
        if target.is_file() {
            return Ok(target);
        }
        self.generate_thumbnail(document, page).await?;
        Ok(target)
    }

    /// Full page render at page resolution, cached on disk. The indexing agent reads
    /// this image and normalizes block coordinates against it, so crops taken from it
    /// line up with the layout the agent saw.
    pub async fn ensure_page_image(&self, document: &Document, page: u32) -> Result<PathBuf> {
        if page == 0 || (document.page_count != 0 && page > document.page_count) {
            bail!("page {page} is outside document page range");
        }
        let target = self.layout.page_image_path(document.document_id, page);
        if target.is_file() {
            return Ok(target);
        }
        let _permit = self
            .render_gate
            .acquire()
            .await
            .context("preview render gate closed")?;
        let source = self.layout.object_path(&document.content_hash);
        let image = match document.media_type {
            MediaType::Image => load_image(source).await?,
            MediaType::Pdf => {
                let rendered =
                    render_pdf_page(&self.layout, &source, page, Some(self.page_dpi), None).await?;
                let image = load_image(rendered.clone()).await?;
                tokio::fs::remove_file(rendered)
                    .await
                    .context("remove temporary PDF page render")?;
                image
            }
        };
        let directory = self.layout.page_image_directory(document.document_id);
        tokio::fs::create_dir_all(&directory)
            .await
            .context("create page image directory")?;
        save_webp_atomic(image, directory, target.clone()).await?;
        Ok(target)
    }

    async fn generate_thumbnail(&self, document: &Document, page: u32) -> Result<()> {
        let _permit = self
            .render_gate
            .acquire()
            .await
            .context("preview render gate closed")?;
        let source = self.layout.object_path(&document.content_hash);
        let image = match document.media_type {
            MediaType::Image => load_image(source).await?,
            MediaType::Pdf => {
                let rendered = render_pdf_page(
                    &self.layout,
                    &source,
                    page,
                    None,
                    Some((THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)),
                )
                .await?;
                let image = load_image(rendered.clone()).await?;
                tokio::fs::remove_file(rendered)
                    .await
                    .context("remove temporary PDF thumbnail page")?;
                image
            }
        };
        let thumbnail = image.thumbnail(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
        let directory = self.layout.thumbnail_directory(document.document_id);
        tokio::fs::create_dir_all(&directory)
            .await
            .context("create thumbnail directory")?;
        let target = self.layout.thumbnail_path(document.document_id, page);
        save_webp_atomic(thumbnail, directory, target).await
    }

    async fn pdf_page_count(&self, source: &Path) -> Result<u32> {
        let _permit = self
            .render_gate
            .acquire()
            .await
            .context("preview render gate closed")?;
        let output = Command::new("pdfinfo")
            .env("LC_ALL", "C")
            .arg(source)
            .output()
            .await
            .context("start pdfinfo; install Poppler to render PDF previews")?;
        if !output.status.success() {
            bail!(
                "pdfinfo failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let stdout =
            String::from_utf8(output.stdout).context("pdfinfo returned non-UTF-8 output")?;
        stdout
            .lines()
            .find_map(|line| line.strip_prefix("Pages:").map(str::trim))
            .context("pdfinfo output did not contain a page count")?
            .parse()
            .context("parse PDF page count")
    }
}

async fn load_image(path: PathBuf) -> Result<DynamicImage> {
    tokio::task::spawn_blocking(move || {
        ImageReader::open(&path)
            .with_context(|| format!("open image {}", path.display()))?
            .with_guessed_format()
            .context("detect image format")?
            .decode()
            .context("decode image")
    })
    .await
    .context("image decoder task failed")?
}

async fn save_webp_atomic(image: DynamicImage, directory: PathBuf, target: PathBuf) -> Result<()> {
    let temporary = tempfile::Builder::new()
        .prefix("thumbnail-")
        .suffix(".webp")
        .tempfile_in(&directory)
        .context("create thumbnail temporary file")?;
    let temporary_path = temporary.path().to_path_buf();
    drop(temporary);
    let write_path = temporary_path.clone();
    tokio::task::spawn_blocking(move || {
        image
            .save_with_format(&write_path, ImageFormat::WebP)
            .context("encode WebP thumbnail")
    })
    .await
    .context("thumbnail encoder task failed")??;
    tokio::fs::rename(&temporary_path, &target)
        .await
        .with_context(|| format!("publish thumbnail {}", target.display()))?;
    Ok(())
}

async fn render_pdf_page(
    layout: &DataLayout,
    source: &Path,
    page: u32,
    dpi: Option<u32>,
    scale: Option<(u32, u32)>,
) -> Result<PathBuf> {
    let prefix_file = tempfile::Builder::new()
        .prefix("pdf-page-")
        .tempfile_in(&layout.temporary)
        .context("create PDF render path")?;
    let prefix = prefix_file.path().to_path_buf();
    drop(prefix_file);
    let mut command = Command::new("pdftoppm");
    command
        .arg("-f")
        .arg(page.to_string())
        .arg("-l")
        .arg(page.to_string())
        .arg("-singlefile")
        .arg("-png");
    if let Some(dpi) = dpi {
        command.arg("-r").arg(dpi.to_string());
    }
    if let Some((width, height)) = scale {
        command
            .arg("-scale-to-x")
            .arg(width.to_string())
            .arg("-scale-to-y")
            .arg(height.to_string());
    }
    let output = command
        .arg(source)
        .arg(&prefix)
        .output()
        .await
        .context("start pdftoppm; install Poppler to render PDF previews")?;
    let _ = tokio::fs::remove_file(&prefix).await;
    if !output.status.success() {
        bail!(
            "pdftoppm failed for page {page}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let rendered = prefix.with_extension("png");
    if !rendered.is_file() {
        bail!("pdftoppm did not create page {page}");
    }
    Ok(rendered)
}
