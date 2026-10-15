/// 2 (M4b part 3): titles follow the first-line H1 rule (§1); pages gain
/// `cover_x` (§3); `target_key` follows `\` in Windows paths and Markdown
/// `file:` links are indexed (§9).
/// 3 (M5): `page_text` and its full-text index `fts` (search). An index built
/// by an older version is rebuilt.
/// 4 (M5b §4): pages gain `icon`, the frontmatter emoji.
pub const SCHEMA_VERSION: i64 = 4;

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
    frontmatter_error TEXT,
    icon TEXT
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
-- M5 §2, §10.3: what search reads of each page, and its full-text index
-- (external content: snippets need the text). The triggers keep `fts` in
-- step with every write; deletes and renames of `files` cascade here.
CREATE TABLE page_text (
    rowid INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
    title TEXT NOT NULL,
    name TEXT NOT NULL,
    folders TEXT NOT NULL,
    tags TEXT NOT NULL,
    links TEXT NOT NULL,
    body TEXT NOT NULL
);
CREATE VIRTUAL TABLE fts USING fts5(
    title, name, folders, tags, links, body,
    content = 'page_text', content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);
CREATE TRIGGER page_text_ai AFTER INSERT ON page_text BEGIN
    INSERT INTO fts (rowid, title, name, folders, tags, links, body)
    VALUES (new.rowid, new.title, new.name, new.folders, new.tags, new.links, new.body);
END;
CREATE TRIGGER page_text_ad AFTER DELETE ON page_text BEGIN
    INSERT INTO fts (fts, rowid, title, name, folders, tags, links, body)
    VALUES ('delete', old.rowid, old.title, old.name, old.folders, old.tags, old.links, old.body);
END;
CREATE TRIGGER page_text_au AFTER UPDATE OF title, name, folders, tags, links, body ON page_text BEGIN
    INSERT INTO fts (fts, rowid, title, name, folders, tags, links, body)
    VALUES ('delete', old.rowid, old.title, old.name, old.folders, old.tags, old.links, old.body);
    INSERT INTO fts (rowid, title, name, folders, tags, links, body)
    VALUES (new.rowid, new.title, new.name, new.folders, new.tags, new.links, new.body);
END;
"#;
