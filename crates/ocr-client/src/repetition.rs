//! Port of `detect_repeat_token` from Datalab's Chandra client (`chandra/model/util.py`),
//! used to spot OCR output that degenerated into a loop.

const BASE_MAX_REPEATS: f64 = 4.0;
const WINDOW_SIZE: usize = 500;
const SCALING_FACTOR: f64 = 3.0;
/// Datalab also checks the output without its last characters, so a loop followed by a
/// short closing tail is still caught.
const CUT_FROM_END: usize = 50;

/// Reports whether `text` ends in a sequence of up to 250 characters repeated more often
/// than a page would contain on purpose. Shorter sequences need more repeats: a single
/// character must repeat 17 times, a 250-character sequence 5 times.
pub(crate) fn ends_in_repetition(text: &str) -> bool {
    let chars = text.chars().collect::<Vec<_>>();
    repeats_at_end(&chars)
        || (chars.len() > CUT_FROM_END && repeats_at_end(&chars[..chars.len() - CUT_FROM_END]))
}

fn repeats_at_end(chars: &[char]) -> bool {
    for sequence_length in 1..=WINDOW_SIZE / 2 {
        if sequence_length > chars.len() {
            break;
        }
        let max_repeats =
            (BASE_MAX_REPEATS * (1.0 + SCALING_FACTOR / sequence_length as f64)) as usize;
        let candidate = &chars[chars.len() - sequence_length..];
        let mut repeats = 0;
        let mut end = chars.len();
        while end >= sequence_length && &chars[end - sequence_length..end] == candidate {
            repeats += 1;
            if repeats > max_repeats {
                return true;
            }
            end -= sequence_length;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::ends_in_repetition;

    #[test]
    fn detects_looping_ocr_output() {
        let page =
            "<div data-label=\"Text\" data-bbox=\"10 20 900 60\"><p>Ihre Mitgliedschaft</p></div>";
        assert!(!ends_in_repetition(page));

        let looped = format!("{page}{}", "<p>Text</p>".repeat(9));
        assert!(ends_in_repetition(&looped));

        // A loop followed by a short, non-repeating tail is caught by the 50-character cut.
        let tail = "</div><p>Zahlbar bis 01.06.2025</p></div>";
        assert!(!ends_in_repetition(&format!("{page}{tail}")));
        assert!(ends_in_repetition(&format!("{looped}{tail}")));

        // Five repeats of an 11-character sequence is within the allowance of five.
        assert!(!ends_in_repetition(&format!(
            "{page}{}",
            "<p>Text</p>".repeat(5)
        )));
    }
}
