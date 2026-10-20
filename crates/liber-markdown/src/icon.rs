//! Optional emoji icons for pages, folders and vaults (M5b §4).

use unicode_segmentation::UnicodeSegmentation;

/// Longest icon accepted, in bytes (a family or a subdivision flag fits).
const MAX_BYTES: usize = 32;

/// An icon is one emoji: a single extended grapheme cluster of at most 32
/// bytes that is pictographic, a keycap (`1️⃣`) or a flag (`🇪🇸`). Plain
/// text, several emoji, and symbols that render as text (© without VS16)
/// are not icons.
pub fn is_icon(s: &str) -> bool {
    if s.is_empty() || s.len() > MAX_BYTES || s.graphemes(true).nth(1).is_some() {
        return false;
    }
    let chars: Vec<char> = s.chars().collect();
    let regional = |c: &char| ('\u{1F1E6}'..='\u{1F1FF}').contains(c);
    if chars.len() == 2 && chars.iter().all(regional) {
        return true;
    }
    if chars.last() == Some(&'\u{20E3}') {
        return matches!(chars[0], '0'..='9' | '#' | '*');
    }
    let selector = chars.contains(&'\u{FE0F}');
    chars.iter().any(|&c| {
        !regional(&c) && pictographic(c) && (c >= '\u{1F000}' || selector || presentation(c))
    })
}

/// Roughly Unicode's `Extended_Pictographic`.
// shortcut: hand-kept ranges, not the UCD property; upgrade to generated
// tables if a real emoji is ever refused.
fn pictographic(c: char) -> bool {
    matches!(c,
        '\u{00A9}' | '\u{00AE}' | '\u{203C}' | '\u{2049}' | '\u{2122}' | '\u{2139}'
        | '\u{2190}'..='\u{21FF}' | '\u{2300}'..='\u{23FF}' | '\u{24C2}'
        | '\u{25A0}'..='\u{25FF}' | '\u{2600}'..='\u{27BF}' | '\u{2934}'..='\u{2935}'
        | '\u{2B00}'..='\u{2BFF}' | '\u{3030}' | '\u{303D}' | '\u{3297}' | '\u{3299}'
        | '\u{1F000}'..='\u{1FAFF}' | '\u{1FC00}'..='\u{1FFFD}')
}

/// BMP emoji shown as emoji without VS16 (`Emoji_Presentation`).
fn presentation(c: char) -> bool {
    matches!(c,
        '\u{231A}'..='\u{231B}' | '\u{23E9}'..='\u{23EC}' | '\u{23F0}' | '\u{23F3}'
        | '\u{25FD}'..='\u{25FE}' | '\u{2614}'..='\u{2615}' | '\u{2648}'..='\u{2653}'
        | '\u{267F}' | '\u{2693}' | '\u{26A1}' | '\u{26AA}'..='\u{26AB}'
        | '\u{26BD}'..='\u{26BE}' | '\u{26C4}'..='\u{26C5}' | '\u{26CE}' | '\u{26D4}'
        | '\u{26EA}' | '\u{26F2}'..='\u{26F3}' | '\u{26F5}' | '\u{26FA}' | '\u{26FD}'
        | '\u{2705}' | '\u{270A}'..='\u{270B}' | '\u{2728}' | '\u{274C}' | '\u{274E}'
        | '\u{2753}'..='\u{2755}' | '\u{2757}' | '\u{2795}'..='\u{2797}' | '\u{27B0}'
        | '\u{27BF}' | '\u{2B1B}'..='\u{2B1C}' | '\u{2B50}' | '\u{2B55}')
}

#[cfg(test)]
mod tests {
    use super::is_icon;

    #[test]
    fn single_emoji_are_icons() {
        for s in [
            "🚀",
            "❤️",
            "👨‍👩‍👧",
            "🇪🇸",
            "1️⃣",
            "#️⃣",
            "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
            "⚡",
            "☕",
            "©️",
            "👍🏽",
        ] {
            assert!(is_icon(s), "{s:?} should be an icon");
        }
    }

    #[test]
    fn text_and_runs_are_not() {
        for s in ["", "a", "🚀🚀", "hello", "©", "1", " 🚀", "🇪", "x\u{20E3}"] {
            assert!(!is_icon(s), "{s:?} should not be an icon");
        }
        assert!(!is_icon(&"👍".repeat(9)));
    }
}
