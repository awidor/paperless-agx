//! Network scanning from the Samsung SL-M3870FW (and other MFPs speaking SANE's `xerox_mfp`
//! protocol on TCP port 9400), into a PDF with one page per sheet.

#[cfg(any(test, feature = "fake"))]
pub mod fake;
mod pdf;
mod protocol;

use std::{fmt, io::Cursor};

use image::{DynamicImage, GrayImage, ImageFormat, RgbImage, codecs::jpeg::JpegEncoder};
pub use paperless_models::{ScanMode, ScanSource};
pub use protocol::ScannerInfo;
use protocol::{Connection, SOURCE_DUPLEX, SOURCE_FEEDER, SOURCE_GLASS, Window, dpi_code};

pub const DEFAULT_PORT: u16 = 9400;
/// The resolutions offered for scanning.
pub const SUPPORTED_DPI: [u16; 4] = [150, 200, 300, 600];

/// A4 in 1/1200 inch, the unit of the scan window.
const A4_WIDTH: u32 = 9_921;
const A4_LENGTH: u32 = 14_031;
/// Gray level from which a black-and-white page is white.
const WHITE_FROM: u8 = 160;
const JPEG_QUALITY_GRAY: u8 = 85;
const JPEG_QUALITY_COLOR: u8 = 88;

#[derive(Debug)]
pub enum ScanError {
    Unreachable { address: String, reason: String },
    NotResponding,
    Busy,
    NoPaper,
    PaperJam,
    CoverOpen,
    CancelledAtPrinter,
    UnsupportedDpi(u16),
    UnsupportedDuplex,
    Connection(std::io::Error),
    Protocol(String),
}

impl ScanError {
    fn io(error: std::io::Error) -> Self {
        Self::Connection(error)
    }
}

impl fmt::Display for ScanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable { address, reason } => {
                write!(f, "The scanner at {address} cannot be reached ({reason}). Is the printer on?")
            }
            Self::NotResponding => f.write_str(
                "The scanner stopped answering. It may still be finishing an earlier scan; try again in a minute.",
            ),
            Self::Busy => f.write_str("The printer is busy copying, faxing or scanning. Try again when it is done."),
            Self::NoPaper => f.write_str("There is no paper in the feeder."),
            Self::PaperJam => f.write_str("Paper jam: clear the feeder and scan again."),
            Self::CoverOpen => f.write_str("The scanner lid or the feeder cover is open."),
            Self::CancelledAtPrinter => f.write_str("The scan was cancelled at the printer."),
            Self::UnsupportedDpi(dpi) => write!(f, "The scanner does not scan at {dpi} dpi."),
            Self::UnsupportedDuplex => {
                f.write_str("This scanner does not support dual-sided scanning.")
            }
            Self::Connection(error) => write!(f, "The connection to the scanner broke: {error}."),
            Self::Protocol(detail) => write!(f, "The scanner sent something unexpected: {detail}."),
        }
    }
}

impl std::error::Error for ScanError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanSettings {
    pub source: ScanSource,
    pub dpi: u16,
    pub duplex: bool,
}

/// One scanned page as the scanner sent it: color JPEG strips from top to bottom.
#[derive(Debug, Clone)]
pub struct RawPage {
    strips: Vec<Vec<u8>>,
    dpi: u16,
    /// The scan window in pixels; strips are padded wider than it.
    width: u32,
    height: u32,
    /// Reversing feeders turn sheets head-to-foot for the back side, so back pages arrive upside down.
    rotate_180: bool,
}

impl RawPage {
    /// The page as one image, cropped to the scan window and turned right-side up.
    pub fn image(&self) -> Result<RgbImage, ScanError> {
        let strips = self
            .strips
            .iter()
            .map(|strip| {
                image::load_from_memory_with_format(strip, ImageFormat::Jpeg)
                    .map(DynamicImage::into_rgb8)
                    .map_err(|error| {
                        ScanError::Protocol(format!("unreadable image strip: {error}"))
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let full_width = strips.iter().map(RgbImage::width).max().unwrap_or(0);
        let full_height = strips.iter().map(RgbImage::height).sum::<u32>();
        let mut page = RgbImage::from_pixel(full_width, full_height, image::Rgb([255, 255, 255]));
        let mut top = 0;
        for strip in &strips {
            image::imageops::replace(&mut page, strip, 0, i64::from(top));
            top += strip.height();
        }
        let width = self.width.min(full_width);
        let height = self.height.min(full_height);
        let cropped = image::imageops::crop_imm(&page, 0, 0, width, height).to_image();
        Ok(if self.rotate_180 {
            image::imageops::rotate180(&cropped)
        } else {
            cropped
        })
    }
}

#[derive(Debug, Clone)]
pub struct Scanner {
    address: String,
}

impl Scanner {
    pub fn new(host: &str, port: u16) -> Self {
        Self {
            address: format!("{host}:{port}"),
        }
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    pub async fn info(&self) -> Result<ScannerInfo, ScanError> {
        Connection::open(&self.address).await?.inquiry().await
    }

    /// Scans A4 pages: one from the glass, or every sheet in the feeder. `on_page` hears the
    /// number of pages done after each one. The scanner is released again however this ends.
    pub async fn scan(
        &self,
        settings: ScanSettings,
        mut on_page: impl FnMut(u32) + Send,
    ) -> Result<Vec<RawPage>, ScanError> {
        let mut connection = Connection::open(&self.address).await?;
        let info = connection.inquiry().await?;
        if !info.jpeg {
            return Err(ScanError::Protocol("this scanner cannot send JPEG".into()));
        }
        let code = dpi_code(settings.dpi)
            .filter(|_| info.resolutions.contains(&settings.dpi))
            .ok_or(ScanError::UnsupportedDpi(settings.dpi))?;
        let feeder = match settings.source {
            ScanSource::Auto => info.feeder_loaded,
            ScanSource::Feeder if info.feeder_loaded => true,
            ScanSource::Feeder => return Err(ScanError::NoPaper),
            ScanSource::Glass => false,
        };
        let duplex = feeder && settings.duplex;
        if duplex && !info.has_duplex {
            return Err(ScanError::UnsupportedDuplex);
        }
        let max_length = if feeder {
            info.max_length_feeder
        } else {
            info.max_length_glass
        };
        let window = Window {
            width: A4_WIDTH.min(info.max_width),
            length: A4_LENGTH.min(max_length),
            dpi_code: code,
            source: if duplex {
                SOURCE_DUPLEX
            } else if feeder {
                SOURCE_FEEDER
            } else {
                SOURCE_GLASS
            },
        };
        let pixels =
            |length: u32| (u64::from(length) * u64::from(settings.dpi)).div_ceil(1200) as u32;
        let (width, height) = (pixels(window.width), pixels(window.length));

        let mut pages = Vec::new();
        let outcome = async {
            connection.reserve(&window).await?;
            loop {
                match connection.next_page().await {
                    Ok(()) => {}
                    // The feeder ran out after at least one sheet: that is the end of the stack.
                    Err(ScanError::NoPaper) if !pages.is_empty() => break,
                    Err(error) => return Err(error),
                }
                let mut strips = Vec::new();
                loop {
                    let (strip, last) = connection.read_strip().await?;
                    strips.push(strip);
                    if last {
                        break;
                    }
                }
                let back_side = duplex && pages.len() % 2 == 1;
                pages.push(RawPage {
                    strips,
                    dpi: settings.dpi,
                    width,
                    height,
                    rotate_180: back_side,
                });
                on_page(pages.len() as u32);
                if !feeder {
                    break;
                }
            }
            Ok(())
        }
        .await;
        if outcome.is_err() {
            connection.abort().await;
        }
        connection.release().await;
        outcome.map(|()| pages)
    }
}

/// Renders scanned pages into one PDF. Color and gray pages are JPEG; black-and-white pages are
/// 1-bit and compressed losslessly. Pages are decoded one at a time to keep memory small.
pub fn render_pdf(pages: &[RawPage], mode: ScanMode) -> Result<Vec<u8>, ScanError> {
    let mut images = Vec::with_capacity(pages.len());
    for page in pages {
        let rgb = page.image()?;
        let (width, height) = rgb.dimensions();
        let image = match mode {
            ScanMode::Color => pdf::PageImage {
                data: jpeg(DynamicImage::ImageRgb8(rgb), JPEG_QUALITY_COLOR)?,
                width,
                height,
                kind: pdf::ImageKind::JpegRgb,
            },
            ScanMode::Gray => pdf::PageImage {
                data: jpeg(
                    DynamicImage::ImageRgb8(rgb).into_luma8().into(),
                    JPEG_QUALITY_GRAY,
                )?,
                width,
                height,
                kind: pdf::ImageKind::JpegGray,
            },
            ScanMode::BlackWhite => pdf::PageImage {
                data: pdf::deflate(&pack_bits(&DynamicImage::ImageRgb8(rgb).into_luma8())),
                width,
                height,
                kind: pdf::ImageKind::Bilevel,
            },
        };
        images.push((image, page.dpi));
    }
    Ok(pdf::write(&images))
}

fn jpeg(image: DynamicImage, quality: u8) -> Result<Vec<u8>, ScanError> {
    let mut output = Cursor::new(Vec::new());
    image
        .write_with_encoder(JpegEncoder::new_with_quality(&mut output, quality))
        .map_err(|error| ScanError::Protocol(format!("encode page: {error}")))?;
    Ok(output.into_inner())
}

/// Rows of 1-bit samples, most significant bit first, 1 for white (PDF DeviceGray).
fn pack_bits(gray: &GrayImage) -> Vec<u8> {
    let (width, height) = gray.dimensions();
    let row_bytes = width.div_ceil(8) as usize;
    let mut packed = vec![0_u8; row_bytes * height as usize];
    for (y, row) in gray.rows().enumerate() {
        for (x, pixel) in row.enumerate() {
            if pixel.0[0] >= WHITE_FROM {
                packed[y * row_bytes + x / 8] |= 0x80 >> (x % 8);
            }
        }
    }
    packed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{FakeScanner, FakeSetup};

    fn settings(source: ScanSource) -> ScanSettings {
        ScanSettings {
            source,
            dpi: 150,
            duplex: false,
        }
    }

    #[tokio::test]
    async fn glass_scan_stitches_the_strips_and_releases_the_scanner() {
        let fake = FakeScanner::start(FakeSetup::default()).await;
        let scanner = Scanner::new("127.0.0.1", fake.port());
        let mut progress = Vec::new();
        let pages = scanner
            .scan(settings(ScanSource::Glass), |pages| progress.push(pages))
            .await
            .unwrap();
        assert_eq!(progress, vec![1]);
        assert_eq!(pages.len(), 1);
        let image = pages[0].image().unwrap();
        // Two 16-line strips of 64 px; the window is wider and longer, so nothing is cut.
        assert_eq!(image.dimensions(), (64, 32));
        assert!(image.get_pixel(10, 4).0[0].abs_diff(fake.shade(0, 0)) < 8);
        assert!(image.get_pixel(10, 20).0[0].abs_diff(fake.shade(0, 1)) < 8);

        let window = fake.window().unwrap();
        assert_eq!(window[19], SOURCE_GLASS);
        assert_eq!((window[9], window[15], window[16]), (2, 0x05, 0x06));
        assert_eq!(
            fake.commands().last(),
            Some(&0x17),
            "RELEASE_UNIT ends the scan"
        );
    }

    #[tokio::test]
    async fn feeder_scans_every_sheet_until_it_is_empty() {
        let fake = FakeScanner::start(FakeSetup {
            feeder_sheets: 3,
            ..FakeSetup::default()
        })
        .await;
        let scanner = Scanner::new("127.0.0.1", fake.port());
        let mut progress = Vec::new();
        let pages = scanner
            .scan(settings(ScanSource::Auto), |pages| progress.push(pages))
            .await
            .unwrap();
        assert_eq!(progress, vec![1, 2, 3]);
        assert_eq!(fake.window().unwrap()[19], SOURCE_FEEDER);
        for (index, page) in pages.iter().enumerate() {
            let shade = page.image().unwrap().get_pixel(10, 4).0[0];
            assert!(
                shade.abs_diff(fake.shade(index, 0)) < 8,
                "page {index} out of order"
            );
        }
    }

    #[tokio::test]
    async fn empty_feeder_is_reported_and_auto_uses_the_glass() {
        let fake = FakeScanner::start(FakeSetup::default()).await;
        let scanner = Scanner::new("127.0.0.1", fake.port());
        let error = scanner
            .scan(settings(ScanSource::Feeder), |_| {})
            .await
            .unwrap_err();
        assert!(matches!(error, ScanError::NoPaper), "{error:?}");
        scanner
            .scan(settings(ScanSource::Auto), |_| {})
            .await
            .unwrap();
        assert_eq!(fake.window().unwrap()[19], SOURCE_GLASS);
    }

    #[tokio::test]
    async fn waits_while_busy_and_aborts_on_a_jam() {
        let fake = FakeScanner::start(FakeSetup {
            feeder_sheets: 3,
            busy_reserves: 2,
            jam_on_sheet: Some(2),
            ..FakeSetup::default()
        })
        .await;
        let scanner = Scanner::new("127.0.0.1", fake.port());
        let mut progress = Vec::new();
        let error = scanner
            .scan(settings(ScanSource::Feeder), |pages| progress.push(pages))
            .await
            .unwrap_err();
        assert!(matches!(error, ScanError::PaperJam), "{error:?}");
        assert_eq!(progress, vec![1]);
        let commands = fake.commands();
        assert_eq!(
            commands.iter().filter(|&&c| c == 0x16).count(),
            3,
            "two busy RESERVE_UNIT replies, then ready"
        );
        assert_eq!(
            &commands[commands.len() - 2..],
            &[0x06, 0x17],
            "ABORT, then RELEASE_UNIT"
        );
    }

    #[tokio::test]
    async fn rejects_resolutions_the_scanner_lacks() {
        let fake = FakeScanner::start(FakeSetup::default()).await;
        let scanner = Scanner::new("127.0.0.1", fake.port());
        let too_fine = ScanSettings {
            source: ScanSource::Glass,
            dpi: 1200,
            duplex: false,
        };
        let error = scanner.scan(too_fine, |_| {}).await.unwrap_err();
        assert!(
            matches!(error, ScanError::UnsupportedDpi(1200)),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn duplex_feeder_scans_both_sides_and_rotates_back_pages() {
        let fake = FakeScanner::start(FakeSetup {
            feeder_sheets: 2,
            ..FakeSetup::default()
        })
        .await;
        let scanner = Scanner::new("127.0.0.1", fake.port());
        let mut progress = Vec::new();
        let pages = scanner
            .scan(
                ScanSettings {
                    source: ScanSource::Feeder,
                    dpi: 150,
                    duplex: true,
                },
                |pages| progress.push(pages),
            )
            .await
            .unwrap();
        assert_eq!(progress, vec![1, 2, 3, 4]);
        assert_eq!(fake.window().unwrap()[19], SOURCE_DUPLEX);
        // Front sides keep strip 0 at the top; back sides are rotated 180 degrees so strip 1 moves to the top.
        for (index, page) in pages.iter().enumerate() {
            let image = page.image().unwrap();
            let top = image.get_pixel(10, 4).0[0];
            let bottom = image.get_pixel(10, 20).0[0];
            let (expected_top, expected_bottom) = if index % 2 == 1 {
                (fake.shade(index, 1), fake.shade(index, 0))
            } else {
                (fake.shade(index, 0), fake.shade(index, 1))
            };
            assert!(top.abs_diff(expected_top) < 8, "page {index} top");
            assert!(bottom.abs_diff(expected_bottom) < 8, "page {index} bottom");
        }
    }

    #[tokio::test]
    async fn duplex_is_rejected_when_scanner_lacks_it_and_ignored_on_glass() {
        let fake = FakeScanner::start(FakeSetup {
            feeder_sheets: 1,
            has_duplex: false,
            ..FakeSetup::default()
        })
        .await;
        let scanner = Scanner::new("127.0.0.1", fake.port());
        let error = scanner
            .scan(
                ScanSettings {
                    source: ScanSource::Feeder,
                    dpi: 150,
                    duplex: true,
                },
                |_| {},
            )
            .await
            .unwrap_err();
        assert!(matches!(error, ScanError::UnsupportedDuplex), "{error:?}");

        let pages = scanner
            .scan(
                ScanSettings {
                    source: ScanSource::Glass,
                    dpi: 150,
                    duplex: true,
                },
                |_| {},
            )
            .await
            .unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(fake.window().unwrap()[19], SOURCE_GLASS);
    }

    #[tokio::test]
    async fn renders_every_mode_into_a_pdf() {
        let fake = FakeScanner::start(FakeSetup {
            feeder_sheets: 2,
            ..FakeSetup::default()
        })
        .await;
        let pages = Scanner::new("127.0.0.1", fake.port())
            .scan(settings(ScanSource::Feeder), |_| {})
            .await
            .unwrap();
        for mode in [ScanMode::Color, ScanMode::Gray, ScanMode::BlackWhite] {
            let pdf = render_pdf(&pages, mode).unwrap();
            pdf::tests::assert_well_formed(&pdf, 2);
        }
    }

    #[test]
    fn black_and_white_rows_are_packed_white_high() {
        let mut gray = GrayImage::from_pixel(10, 2, image::Luma([255]));
        gray.put_pixel(0, 0, image::Luma([0]));
        gray.put_pixel(9, 1, image::Luma([WHITE_FROM - 1]));
        assert_eq!(
            pack_bits(&gray),
            vec![0b0111_1111, 0b1100_0000, 0b1111_1111, 0b1000_0000]
        );
    }
}
