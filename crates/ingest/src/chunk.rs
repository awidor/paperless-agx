use anyhow::{Result, bail};
use paperless_models::{Chunk, Document, DocumentPage};

pub const TARGET_CHUNK_CHARS: usize = 3_000;

pub fn chunk_document(document: &Document, pages: &[DocumentPage]) -> Result<Vec<Chunk>> {
    if document.document_id > u32::MAX as u64 {
        bail!("document id is too large for deterministic chunk ids");
    }
    let mut ordered = pages.to_vec();
    ordered.sort_by_key(|page| page.page);
    for (index, page) in ordered.iter().enumerate() {
        if page.document_id != document.document_id || page.page != index as u32 + 1 {
            bail!("document pages must be contiguous from page one");
        }
    }

    let mut chunks = Vec::new();
    let mut document_char_base = 0_usize;
    for page in ordered {
        for (start, end) in page_ranges(&page.text, TARGET_CHUNK_CHARS) {
            let text = page.text[start..end].to_owned();
            let local_start = page.text[..start].chars().count();
            let local_end = local_start + text.chars().count();
            let ordinal = chunks.len() as u64 + 1;
            chunks.push(Chunk {
                chunk_id: (document.document_id << 32) | ordinal,
                document_id: document.document_id,
                page_start: page.page,
                page_end: page.page,
                char_start: u32::try_from(document_char_base + local_start)?,
                char_end: u32::try_from(document_char_base + local_end)?,
                text,
                embedding: Vec::new(),
                created_at: document.created_at,
                document_type: document.document_type.clone(),
            });
        }
        document_char_base = document_char_base
            .checked_add(page.text.chars().count() + 2)
            .ok_or_else(|| anyhow::anyhow!("document character offsets overflow"))?;
    }
    Ok(chunks)
}

fn page_ranges(text: &str, target: usize) -> Vec<(usize, usize)> {
    let units = sentence_ranges(text, target);
    let mut chunks = Vec::new();
    let mut current: Option<(usize, usize)> = None;
    for (start, end) in units {
        match current {
            None => current = Some((start, end)),
            Some((chunk_start, _)) if text[chunk_start..end].chars().count() <= target => {
                current = Some((chunk_start, end));
            }
            Some(range) => {
                chunks.push(range);
                current = Some((start, end));
            }
        }
    }
    if let Some(range) = current {
        chunks.push(range);
    }
    chunks
}

fn sentence_ranges(text: &str, target: usize) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0;
    for (index, character) in text.char_indices() {
        let end = index + character.len_utf8();
        let boundary = matches!(character, '.' | '!' | '?' | '\n')
            && text[end..].chars().next().is_none_or(char::is_whitespace);
        if boundary {
            push_trimmed_or_split(text, start, end, target, &mut ranges);
            start = end;
        }
    }
    push_trimmed_or_split(text, start, text.len(), target, &mut ranges);
    ranges
}

fn push_trimmed_or_split(
    text: &str,
    start: usize,
    end: usize,
    target: usize,
    ranges: &mut Vec<(usize, usize)>,
) {
    let Some((mut start, end)) = trimmed_range(text, start, end) else {
        return;
    };
    while text[start..end].chars().count() > target {
        let mut split = start;
        for (index, character) in text[start..end].char_indices() {
            if index > 0 && index >= target && character.is_whitespace() {
                split = start + index;
                break;
            }
            if index >= target + 256 {
                split = start + index;
                break;
            }
        }
        if split == start {
            split = text[start..end]
                .char_indices()
                .nth(target)
                .map_or(end, |(index, _)| start + index);
        }
        if let Some(range) = trimmed_range(text, start, split) {
            ranges.push(range);
        }
        start = split;
        while start < end
            && text[start..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace)
        {
            start += text[start..].chars().next().unwrap().len_utf8();
        }
    }
    if let Some(range) = trimmed_range(text, start, end) {
        ranges.push(range);
    }
}

fn trimmed_range(text: &str, mut start: usize, mut end: usize) -> Option<(usize, usize)> {
    while start < end
        && text[start..]
            .chars()
            .next()
            .is_some_and(char::is_whitespace)
    {
        start += text[start..].chars().next()?.len_utf8();
    }
    while start < end
        && text[..end]
            .chars()
            .next_back()
            .is_some_and(char::is_whitespace)
    {
        end -= text[..end].chars().next_back()?.len_utf8();
    }
    (start < end).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use paperless_models::{Document, DocumentPage, IngestionStatus, MediaType};

    use super::chunk_document;

    #[test]
    fn chunks_are_deterministic_and_keep_page_offsets() {
        let now = Utc::now();
        let document = Document {
            document_id: 9,
            content_hash: [0; 32],
            media_type: MediaType::Pdf,
            filename: "test.pdf".into(),
            title: None,
            document_type: Some("invoice".into()),
            created_at: Some(now),
            added_at: now,
            updated_at: now,
            title_source: None,
            type_source: None,
            created_at_source: None,
            page_count: 2,
            file_size: 1,
            status: IngestionStatus::TextReady,
            last_error: None,
            retry_count: 0,
            deleted_at: None,
        };
        let pages = vec![
            DocumentPage {
                document_id: 9,
                page: 1,
                text: "First sentence. Second sentence.".into(),
                updated_at: now,
            },
            DocumentPage {
                document_id: 9,
                page: 2,
                text: "Page two.".into(),
                updated_at: now,
            },
        ];
        let first = chunk_document(&document, &pages).unwrap();
        let second = chunk_document(&document, &pages).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].page_start, 1);
        assert_eq!(first[0].char_start, 0);
        assert_eq!(first[1].page_start, 2);
        assert_eq!(first[1].char_start, 34);
    }
}
