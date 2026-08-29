use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result, bail};
use image::{DynamicImage, ImageFormat, ImageReader};
use paperless_models::{Document, MediaType};
use paperless_ocr_client::PageImage;
use paperless_storage::DataLayout;
use tokio::{process::Command, sync::Semaphore};

const THUMBNAIL_WIDTH: u32 = 320;
const THUMBNAIL_HEIGHT: u32 = 480;
const OCR_DPI: u32 = 150;

#[derive(Clone)]
pub struct PreviewService {
    layout: DataLayout,
    render_gate: Arc<Semaphore>,
    eager_thumbnail_pages: u32,
    max_ocr_batch_pages: usize,
}

impl PreviewService {
    pub fn new(
        layout: DataLayout,
        render_concurrency: usize,
        eager_thumbnail_pages: u32,
        max_ocr_batch_pages: usize,
    ) -> Result<Self> {
        if render_concurrency == 0 {
            bail!("render_concurrency must be greater than zero");
        }
        if max_ocr_batch_pages == 0 {
            bail!("max_ocr_batch_pages must be greater than zero");
        }
        Ok(Self {
            layout,
            render_gate: Arc::new(Semaphore::new(render_concurrency)),
            eager_thumbnail_pages,
            max_ocr_batch_pages,
        })
    }
    pub const fn max_ocr_batch_pages(&self) -> usize {
        self.max_ocr_batch_pages
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

    /// Full page render at OCR resolution, cached on disk. OCR block
    /// coordinates are normalized against exactly this image, so crops taken
    /// from it line up with the layout the OCR saw.
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
                let rendered = render_pdf_page(&self.layout, &source, page, Some(OCR_DPI), None)
                    .await?;
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

    pub async fn render_ocr_batch(
        &self,
        document: &Document,
        first_page: u32,
        page_count: u32,
    ) -> Result<Vec<PageImage>> {
        if first_page == 0 || page_count == 0 {
            bail!("OCR page range must start at one and contain at least one page");
        }
        if page_count as usize > self.max_ocr_batch_pages {
            bail!(
                "OCR page batch has {page_count} pages, configured maximum is {}",
                self.max_ocr_batch_pages
            );
        }
        let last_page = first_page
            .checked_add(page_count - 1)
            .context("OCR page range overflows")?;
        if document.page_count != 0 && last_page > document.page_count {
            bail!("OCR page range ends after the document");
        }
        let _permit = self
            .render_gate
            .acquire()
            .await
            .context("preview render gate closed")?;
        let source = self.layout.object_path(&document.content_hash);
        match document.media_type {
            MediaType::Image => {
                if first_page != 1 || page_count != 1 {
                    bail!("an image document has exactly one page");
                }
                let bytes = tokio::fs::read(source)
                    .await
                    .context("read image for OCR")?;
                let media_type = image_media_type(&bytes)?;
                Ok(vec![PageImage {
                    page: 1,
                    media_type,
                    bytes,
                }])
            }
            MediaType::Pdf => {
                let mut pages = Vec::with_capacity(page_count as usize);
                for page in first_page..=last_page {
                    let path =
                        render_pdf_page(&self.layout, &source, page, Some(OCR_DPI), None).await?;
                    let bytes = tokio::fs::read(&path)
                        .await
                        .context("read rendered OCR page")?;
                    tokio::fs::remove_file(&path)
                        .await
                        .context("remove rendered OCR page")?;
                    pages.push(PageImage {
                        page,
                        media_type: "image/png".into(),
                        bytes,
                    });
                }
                Ok(pages)
            }
        }
    }
    pub fn render_ocr_batch_owned(
        &self,
        document: Document,
        first_page: u32,
        page_count: u32,
    ) -> impl Future<Output = Result<Vec<PageImage>>> + Send + 'static {
        let service = self.clone();
        async move {
            service
                .render_ocr_batch(&document, first_page, page_count)
                .await
        }
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

fn image_media_type(bytes: &[u8]) -> Result<String> {
    let format = image::guess_format(bytes).context("detect image type for OCR")?;
    let media_type = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Tiff => "image/tiff",
        ImageFormat::WebP => "image/webp",
        other => bail!("unsupported OCR image format: {other:?}"),
    };
    Ok(media_type.into())
}
