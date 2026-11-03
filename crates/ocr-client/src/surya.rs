//! Surya OCR 2.5 full-page output, after `surya/inference/compact.py` and
//! `surya/inference/parsers.py` from Datalab's Surya client.
//!
//! A block starts with one label token and four coordinate tokens (0-1000) instead of
//! `<div data-bbox data-label>`, for example `<|Page-Header|><|71|><|33|><|143|><|45|>`, and
//! has no `</div>`: the next header or the end of the output closes it. `</td>`, `</th>` and
//! `</tr>` are left out, which the HTML5 parser restores. A `data-bbox` on a nested tag is
//! written as `<|box|>` plus four coordinates; Paperless does not use those and drops them.

use std::fmt::Write;

/// The full-page prompt Surya was trained on; Datalab notes the wording must not change.
pub(crate) const FULL_PAGE_PROMPT: &str = "OCR this image to HTML. Each block is a div with data-label and data-bbox (x0 y0 x1 y1, normalized 0-1000).";

const BLOCK_LABELS: [&str; 20] = [
    "Caption",
    "Footnote",
    "Equation-Block",
    "List-Group",
    "Page-Header",
    "Page-Footer",
    "Image",
    "Section-Header",
    "Table",
    "Text",
    "Complex-Block",
    "Code-Block",
    "Form",
    "Table-Of-Contents",
    "Figure",
    "Chemical-Block",
    "Diagram",
    "Bibliography",
    "Blank-Page",
    "Picture",
];

/// llama-server with `--special` returns the end token as text.
const END_MARKERS: [&str; 3] = ["<|im_end!>", "<|im_end|>", "<|endoftext|>"];

/// Turns compact Surya output into the `<div data-bbox data-label>` HTML Chandra writes.
pub(crate) fn decode(output: &str) -> String {
    let mut rest = strip_end_marker(output);
    let mut html = String::with_capacity(rest.len() + 256);
    let mut in_block = false;
    while let Some(start) = rest.find("<|") {
        html.push_str(&rest[..start]);
        let marker = &rest[start..];
        if let Some((label, bbox, length)) = block_header(marker) {
            if in_block {
                html.push_str("</div>");
            }
            if !html.is_empty() && !html.ends_with('\n') {
                html.push('\n');
            }
            let [x0, y0, x1, y1] = bbox;
            let _ = write!(
                html,
                "<div data-bbox=\"{x0} {y0} {x1} {y1}\" data-label=\"{label}\">"
            );
            in_block = true;
            rest = &marker[length..];
        } else if let Some(length) = nested_box(marker) {
            rest = &marker[length..];
        } else {
            html.push_str("<|");
            rest = &marker[2..];
        }
    }
    html.push_str(rest);
    if in_block {
        html.push_str("</div>");
    }
    html
}

fn strip_end_marker(output: &str) -> &str {
    let trimmed = output.trim_end();
    END_MARKERS
        .iter()
        .find_map(|marker| trimmed.strip_suffix(marker))
        .map_or(output, str::trim_end)
}

/// Reads one `<|name|>` token at the start of `text`, returning the name and token length.
fn token(text: &str) -> Option<(&str, usize)> {
    let inner = text.strip_prefix("<|")?;
    let end = inner.find("|>")?;
    Some((&inner[..end], end + 4))
}

fn coordinates(mut text: &str) -> Option<([u16; 4], usize)> {
    let mut values = [0; 4];
    let mut length = 0;
    for value in &mut values {
        let (digits, token_length) = token(text)?;
        if digits.is_empty() || digits.len() > 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *value = digits.parse().ok()?;
        text = &text[token_length..];
        length += token_length;
    }
    Some((values, length))
}

fn block_header(text: &str) -> Option<(&str, [u16; 4], usize)> {
    let (label, label_length) = token(text)?;
    if !BLOCK_LABELS.contains(&label) {
        return None;
    }
    let (bbox, coordinates_length) = coordinates(&text[label_length..])?;
    Some((label, bbox, label_length + coordinates_length))
}

fn nested_box(text: &str) -> Option<usize> {
    let (name, name_length) = token(text)?;
    if name != "box" {
        return None;
    }
    let (_, coordinates_length) = coordinates(&text[name_length..])?;
    Some(name_length + coordinates_length)
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn decodes_compact_blocks_to_chandra_html() {
        let output = "<|Page-Header|><|71|><|33|><|143|><|45|>Continental BKK\
<|Table|><|60|><|100|><|940|><|300|><table><tr><td>Beitrag<td>212,50 €<tr><td>Zeitraum<td>06/2025</table>\
<|Text|><|60|><|320|><|940|><|360|><p>Siehe <|box|><|1|><|2|><|3|><|4|><img alt=\"Logo\"/> oben, a <| b.</p>\
<|im_end|>\n";
        assert_eq!(
            decode(output),
            "<div data-bbox=\"71 33 143 45\" data-label=\"Page-Header\">Continental BKK</div>\n\
<div data-bbox=\"60 100 940 300\" data-label=\"Table\"><table><tr><td>Beitrag<td>212,50 €<tr><td>Zeitraum<td>06/2025</table></div>\n\
<div data-bbox=\"60 320 940 360\" data-label=\"Text\"><p>Siehe <img alt=\"Logo\"/> oben, a <| b.</p></div>"
        );
        assert_eq!(decode("<p>plain</p>"), "<p>plain</p>");
    }
}
