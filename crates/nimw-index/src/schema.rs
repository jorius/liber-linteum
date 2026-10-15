/// 2: titles follow the first-line H1 rule (M4b part 3 §1); pages gain `cover_x` (§3).
pub const SCHEMA_VERSION: i64 = 2;

pub(crate) const SCHEMA: &str = r#"
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (
    path TEXT PRIMARY KEY,
    parent TEXT NOT NULL,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('page', 'folder', 'attachment')),
    mtime_ns INTEGER NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT
);
CREATE INDEX files_parent ON files(parent);
CREATE TABLE pages (
    path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
    title TEXT NOT NULL,
    subtitle TEXT,
    cover TEXT,
    cover_y INTEGER,
    cover_x INTEGER,
    excerpt TEXT NOT NULL,
    has_image INTEGER NOT NULL,
    has_audio INTEGER NOT NULL,
    frontmatter_error TEXT
);
CREATE TABLE tags (
    path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
    tag TEXT NOT NULL,
    tag_key TEXT NOT NULL
);
CREATE INDEX tags_key ON tags(tag_key);
CREATE INDEX tags_path ON tags(path);
CREATE TABLE links (
    id INTEGER PRIMARY KEY,
    src TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
    kind TEXT NOT NULL,
    target_raw TEXT NOT NULL,
    target_key TEXT NOT NULL,
    target_path TEXT,
    heading TEXT,
    alias TEXT,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    encoded INTEGER NOT NULL,
    angle INTEGER NOT NULL,
    label TEXT,
    directed INTEGER NOT NULL
);
CREATE INDEX links_target_path ON links(target_path);
CREATE INDEX links_target_key ON links(target_key);
CREATE INDEX links_src ON links(src);
"#;
