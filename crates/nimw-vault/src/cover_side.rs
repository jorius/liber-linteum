//! Side covers (M4b part 3 §3): where a page's cover sits.

use serde::{Deserialize, Serialize};

/// Where a page's cover sits: the header band (default) or a tall strip
/// beside the text.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoverSide {
    #[default]
    Top,
    Left,
    Right,
}

impl CoverSide {
    pub fn as_str(self) -> &'static str {
        match self {
            CoverSide::Top => "top",
            CoverSide::Left => "left",
            CoverSide::Right => "right",
        }
    }
}
