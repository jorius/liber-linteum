use crate::types::{LinkKind, LinkRef, Tag};
use crate::wikilink;
use std::ops::Range;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// App-owned frontmatter values (arch §3.3). Unknown keys are ignored.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Frontmatter {
    pub subtitle: Option<String>,
    pub cover_y: Option<u8>,
    pub tags: Vec<Tag>,
    pub links: Vec<LinkRef>,
    pub cover: Option<String>,
    pub error: Option<String>,
}

/// Byte range of the YAML between the opening `---` line and the closing
/// `---`/`...` line, and the byte offset where the body starts.
pub(crate) fn split(src: &str) -> Option<(Range<usize>, usize)> {
    let first_len = if src.starts_with("---\n") {
        4
    } else if src.starts_with("---\r\n") {
        5
    } else {
        return None;
    };
    let mut pos = first_len;
    while pos <= src.len() {
        let line_end = src[pos..].find('\n').map(|i| pos + i).unwrap_or(src.len());
        let line = src[pos..line_end].trim_end_matches('\r');
        if line == "---" || line == "..." {
            let body = (line_end + 1).min(src.len());
            return Some((first_len..pos, body));
        }
        if line_end == src.len() {
            return None;
        }
        pos = line_end + 1;
    }
    None
}

#[derive(Debug)]
enum Node {
    Scalar { value: String, start: usize },
    Seq(Vec<Node>),
    Map(Vec<(Node, Node)>),
}

impl Node {
    fn as_scalar(&self) -> Option<&str> {
        match self {
            Node::Scalar { value, .. } => Some(value),
            _ => None,
        }
    }
}

/// Builds a tiny document tree with byte offsets (yaml-rust2 markers are
/// *character* indices, so they are mapped to bytes here).
struct Builder<'a> {
    yaml: &'a str,
    char_to_byte: Vec<usize>,
    stack: Vec<Node>,
    keys: Vec<Option<Node>>,
    root: Option<Node>,
}

impl<'a> Builder<'a> {
    fn new(yaml: &'a str) -> Self {
        let mut char_to_byte: Vec<usize> = yaml.char_indices().map(|(b, _)| b).collect();
        char_to_byte.push(yaml.len());
        Builder {
            yaml,
            char_to_byte,
            stack: Vec::new(),
            keys: Vec::new(),
            root: None,
        }
    }

    fn byte(&self, mark: Marker) -> usize {
        *self
            .char_to_byte
            .get(mark.index())
            .unwrap_or(&self.yaml.len())
    }

    fn push_value(&mut self, node: Node) {
        match self.stack.last_mut() {
            None => self.root = Some(node),
            Some(Node::Seq(items)) => items.push(node),
            Some(Node::Map(entries)) => {
                let slot = self.keys.last_mut().expect("map has a key slot");
                match slot.take() {
                    None => *slot = Some(node),
                    Some(key) => entries.push((key, node)),
                }
            }
            Some(Node::Scalar { .. }) => unreachable!("scalars are never on the stack"),
        }
    }
}

impl MarkedEventReceiver for Builder<'_> {
    fn on_event(&mut self, ev: Event, mark: Marker) {
        match ev {
            Event::Scalar(value, style, ..) => {
                let start = self.byte(mark)
                    + usize::from(matches!(
                        style,
                        TScalarStyle::SingleQuoted | TScalarStyle::DoubleQuoted
                    ));
                self.push_value(Node::Scalar { value, start });
            }
            Event::SequenceStart(..) => self.stack.push(Node::Seq(Vec::new())),
            Event::MappingStart(..) => {
                self.stack.push(Node::Map(Vec::new()));
                self.keys.push(None);
            }
            Event::SequenceEnd | Event::MappingEnd => {
                let node = self.stack.pop().expect("balanced events");
                if matches!(node, Node::Map(_)) {
                    self.keys.pop();
                }
                self.push_value(node);
            }
            _ => {}
        }
    }
}

/// Parses the frontmatter at `yaml` (absolute byte range in `src`).
pub(crate) fn parse(src: &str, yaml: Range<usize>) -> Frontmatter {
    let text = &src[yaml.clone()];
    let mut builder = Builder::new(text);
    if let Err(e) = Parser::new_from_str(text).load(&mut builder, false) {
        return Frontmatter {
            error: Some(e.to_string()),
            ..Frontmatter::default()
        };
    }
    let mut fm = Frontmatter::default();
    let Some(Node::Map(entries)) = builder.root else {
        return fm;
    };
    // Absolute byte range of a scalar's value, if its raw text equals the value.
    let locate = |node: &Node| -> Option<(String, Range<usize>)> {
        let Node::Scalar { value, start, .. } = node else {
            return None;
        };
        let abs = yaml.start + start;
        let line_end = src[abs..].find('\n').map(|i| abs + i).unwrap_or(src.len());
        let found = src[abs..line_end].find(value.as_str())?;
        Some((value.clone(), abs + found..abs + found + value.len()))
    };
    for (key, value) in &entries {
        match key.as_scalar() {
            Some("subtitle") => fm.subtitle = value.as_scalar().map(str::to_string),
            Some("cover") => {
                if let Some((v, range)) = locate(value) {
                    fm.cover = Some(v.clone());
                    fm.links
                        .push(LinkRef::new(LinkKind::FrontmatterCover, &v, range));
                } else {
                    fm.cover = value.as_scalar().map(str::to_string);
                }
            }
            Some("cover-y") => {
                fm.cover_y = value
                    .as_scalar()
                    .and_then(|s| s.trim().parse::<f64>().ok())
                    .map(|n| n.clamp(0.0, 100.0).round() as u8);
            }
            Some("tags") => {
                let raw: Vec<String> = match value {
                    Node::Seq(items) => items
                        .iter()
                        .filter_map(|n| n.as_scalar())
                        .map(str::to_string)
                        .collect(),
                    Node::Scalar { value, .. } => value
                        .split(|c: char| c == ',' || c.is_whitespace())
                        .map(str::to_string)
                        .collect(),
                    Node::Map(_) => Vec::new(),
                };
                for t in raw {
                    let t = t.trim().trim_start_matches('#');
                    if !t.is_empty() {
                        fm.tags.push(Tag::new(t));
                    }
                }
            }
            Some("related") => {
                if let Node::Seq(items) = value {
                    for item in items {
                        if let Some(link) = related_link(item, &locate) {
                            fm.links.push(link);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    fm
}

/// Finds a scalar's value and its absolute byte range in the source.
type Locate<'a> = dyn Fn(&Node) -> Option<(String, Range<usize>)> + 'a;

fn related_link(item: &Node, locate: &Locate<'_>) -> Option<LinkRef> {
    let (link_node, label, directed) = match item {
        Node::Scalar { .. } => (item, None, false),
        Node::Map(entries) => {
            let get = |k: &str| {
                entries
                    .iter()
                    .find(|(key, _)| key.as_scalar() == Some(k))
                    .map(|(_, v)| v)
            };
            (
                get("link")?,
                get("label").and_then(|n| n.as_scalar()).map(str::to_string),
                get("directed").and_then(|n| n.as_scalar()) == Some("true"),
            )
        }
        Node::Seq(_) => return None,
    };
    let (value, range) = locate(link_node)?;
    let inner_start = value.find("[[")? + 2;
    let inner_end = inner_start + value[inner_start..].find("]]")?;
    let parts = wikilink::parse_inner(&value[inner_start..inner_end])?;
    let abs = range.start + inner_start + parts.target_range.start;
    let mut link = LinkRef::new(
        LinkKind::FrontmatterRelated,
        parts.target,
        abs..abs + parts.target.len(),
    );
    link.heading = parts.heading.map(str::to_string);
    link.alias = parts.alias.map(str::to_string);
    link.label = label;
    link.directed = directed;
    Some(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fm(src: &str) -> Frontmatter {
        let (yaml, _) = split(src).expect("has frontmatter");
        parse(src, yaml)
    }

    #[test]
    fn split_finds_yaml_and_body() {
        let src = "---\na: 1\n---\n# Body\n";
        let (yaml, body) = split(src).unwrap();
        assert_eq!(&src[yaml], "a: 1\n");
        assert_eq!(&src[body..], "# Body\n");
        assert!(split("# no frontmatter\n---\n").is_none());
        assert!(split("---\nnever closed\n").is_none());
        let crlf = "---\r\na: 1\r\n---\r\nbody";
        assert_eq!(&crlf[split(crlf).unwrap().1..], "body");
        assert_eq!(split("---\n---\n").unwrap().0, 4..4);
    }

    #[test]
    fn pg_02_03_subtitle_cover_and_cover_y() {
        let src =
            "---\nsubtitle: Hero redesign · v3\ncover: 'assets/rex cover.png'\ncover-y: 140\n---\n";
        let f = fm(src);
        assert_eq!(f.subtitle.as_deref(), Some("Hero redesign · v3"));
        assert_eq!(f.cover.as_deref(), Some("assets/rex cover.png"));
        assert_eq!(f.cover_y, Some(100));
        let cover = &f.links[0];
        assert_eq!(cover.kind, LinkKind::FrontmatterCover);
        assert_eq!(&src[cover.range.clone()], "assets/rex cover.png");
        assert_eq!(fm("---\ncover-y: abc\n---\n").cover_y, None);
    }

    #[test]
    fn pg_04_tags_list_and_string_forms() {
        let keys = |s: &str| fm(s).tags.into_iter().map(|t| t.text).collect::<Vec<_>>();
        assert_eq!(
            keys("---\ntags: [Character, '#index']\n---\n"),
            vec!["Character", "index"]
        );
        assert_eq!(keys("---\ntags:\n  - a\n  - b/c\n---\n"), vec!["a", "b/c"]);
        assert_eq!(
            keys("---\ntags: game, art  x\n---\n"),
            vec!["game", "art", "x"]
        );
        assert_eq!(fm("---\ntags: [Character]\n---\n").tags[0].key, "character");
    }

    #[test]
    fn gv_22_related_string_and_object_forms_with_target_ranges() {
        let src = "---\nsubtitle: «é»\nrelated:\n  - \"[[Spárda]]\"\n  - { link: \"[[Game 1#Plan|the game]]\", label: playable version, directed: true }\n  - link: '[[ Z ]]'\n  - not a link\n---\n";
        let f = fm(src);
        let targets: Vec<_> = f
            .links
            .iter()
            .map(|l| (&src[l.range.clone()], l.target.as_str()))
            .collect();
        assert_eq!(
            targets,
            vec![("Spárda", "Spárda"), ("Game 1", "Game 1"), ("Z", "Z")]
        );
        let game = &f.links[1];
        assert_eq!(game.heading.as_deref(), Some("Plan"));
        assert_eq!(game.alias.as_deref(), Some("the game"));
        assert_eq!(game.label.as_deref(), Some("playable version"));
        assert!(game.directed);
        assert!(!f.links[0].directed);
    }

    #[test]
    fn malformed_yaml_sets_error_and_no_values() {
        let f = fm("---\ntags: [unclosed\nsubtitle: x\n---\n");
        assert!(f.error.is_some());
        assert_eq!(f.subtitle, None);
        assert!(f.tags.is_empty());
    }

    #[test]
    fn non_mapping_frontmatter_is_ignored() {
        assert_eq!(fm("---\n- just\n- a list\n---\n"), Frontmatter::default());
    }
}
