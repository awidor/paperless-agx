//! A minimal PDF writer: one full-page image per page, sized from the scan resolution.

use std::io::Write;

use flate2::{Compression, write::ZlibEncoder};

pub(crate) enum ImageKind {
    JpegRgb,
    JpegGray,
    /// 1 bit per sample, 1 for white, zlib-compressed.
    Bilevel,
}

pub(crate) struct PageImage {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub kind: ImageKind,
}

pub(crate) fn deflate(data: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(data)
        .expect("writing to memory cannot fail");
    encoder.finish().expect("writing to memory cannot fail")
}

/// Objects: 1 catalog, 2 page tree, then per page a page, its content stream and its image.
pub(crate) fn write(pages: &[(PageImage, u16)]) -> Vec<u8> {
    let mut out = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = Vec::new();
    let mut object = |out: &mut Vec<u8>, body: &[u8]| {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", offsets.len()).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    };
    let page_id = |index: usize| 3 + 3 * index;
    object(&mut out, b"<< /Type /Catalog /Pages 2 0 R >>");
    let kids = (0..pages.len())
        .map(|index| format!("{} 0 R", page_id(index)))
        .collect::<Vec<_>>()
        .join(" ");
    object(
        &mut out,
        format!("<< /Type /Pages /Kids [{kids}] /Count {} >>", pages.len()).as_bytes(),
    );
    for (index, (image, dpi)) in pages.iter().enumerate() {
        let points = |pixels: u32| f64::from(pixels) * 72.0 / f64::from(*dpi);
        let (width, height) = (points(image.width), points(image.height));
        let content = format!("q {width:.2} 0 0 {height:.2} 0 0 cm /Im0 Do Q");
        object(
            &mut out,
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width:.2} {height:.2}] /Resources << /XObject << /Im0 {} 0 R >> >> /Contents {} 0 R >>",
                page_id(index) + 2,
                page_id(index) + 1
            )
            .as_bytes(),
        );
        object(
            &mut out,
            format!(
                "<< /Length {} >>\nstream\n{content}\nendstream",
                content.len()
            )
            .as_bytes(),
        );
        let (color_space, bits, filter) = match image.kind {
            ImageKind::JpegRgb => ("DeviceRGB", 8, "DCTDecode"),
            ImageKind::JpegGray => ("DeviceGray", 8, "DCTDecode"),
            ImageKind::Bilevel => ("DeviceGray", 1, "FlateDecode"),
        };
        let mut body = format!(
            "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /{color_space} /BitsPerComponent {bits} /Filter /{filter} /Length {} >>\nstream\n",
            image.width,
            image.height,
            image.data.len()
        )
        .into_bytes();
        body.extend_from_slice(&image.data);
        body.extend_from_slice(b"\nendstream");
        object(&mut out, &body);
    }
    let xref = out.len();
    out.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len() + 1).as_bytes(),
    );
    for offset in &offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            offsets.len() + 1
        )
        .as_bytes(),
    );
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Checks the cross-reference table points at every object and the page count matches.
    pub(crate) fn assert_well_formed(pdf: &[u8], pages: usize) {
        assert!(pdf.starts_with(b"%PDF-1.4\n"));
        let find = |needle: &[u8]| {
            pdf.windows(needle.len())
                .rposition(|window| window == needle)
        };
        let startxref = find(b"startxref\n").unwrap() + 10;
        let tail = std::str::from_utf8(&pdf[startxref..]).unwrap();
        let xref: usize = tail.lines().next().unwrap().parse().unwrap();
        assert!(pdf[xref..].starts_with(b"xref\n"));
        // From the cross-reference table on, the file is plain ASCII.
        let table = std::str::from_utf8(&pdf[xref..]).unwrap();
        let count: usize = table
            .lines()
            .nth(1)
            .unwrap()
            .split(' ')
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(count, 3 + 3 * pages);
        for (id, line) in table.lines().skip(3).take(count - 1).enumerate() {
            let offset: usize = line[..10].parse().unwrap();
            assert!(
                pdf[offset..].starts_with(format!("{} 0 obj\n", id + 1).as_bytes()),
                "object {} is not at {offset}",
                id + 1
            );
        }
        assert!(find(format!("/Count {pages} >>").as_bytes()).is_some());
    }

    #[test]
    fn writes_pages_sized_by_resolution() {
        let page = |kind| PageImage {
            data: vec![0xff; 8],
            width: 300,
            height: 600,
            kind,
        };
        let pdf = write(&[
            (page(ImageKind::JpegGray), 150),
            (page(ImageKind::Bilevel), 300),
        ]);
        assert_well_formed(&pdf, 2);
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/MediaBox [0 0 144.00 288.00]"));
        assert!(text.contains("/MediaBox [0 0 72.00 144.00]"));
        assert!(text.contains("/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode"));
    }
}
