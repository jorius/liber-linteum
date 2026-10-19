//! Accent- and case-insensitive keys (M5 §2), as FTS5's
//! `remove_diacritics` reads text: `Canción` and `CANCION` fold alike.

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

/// `s` decomposed, its combining marks dropped, lowercased.
pub fn fold(s: &str) -> String {
    s.nfd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::fold;

    #[test]
    fn folds_accents_and_case() {
        assert_eq!(fold("Canción"), "cancion");
        assert_eq!(fold("CANCIÓN"), "cancion");
        assert_eq!(fold("Ñandú"), "nandu");
        assert_eq!(fold("straße"), "straße");
        assert_eq!(fold(""), "");
    }
}
