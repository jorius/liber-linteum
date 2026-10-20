//! A test `Storage` that delegates to `PlainStorage`, records renames, and
//! keeps the watch sink so a test can inject `RawEvent`s (E2 Task 3).
#![allow(dead_code)] // each test file uses part of it

use liber_vault::{
    Child, Follow, Meta, NewFile, OsUse, PlainStorage, RawEvent, Reach, Reader, Replace, Result,
    Storage, VaultPath, WatchGuard,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub type Sink = Box<dyn Fn(RawEvent) + Send>;

pub struct Spy {
    inner: PlainStorage,
    pub renames: Arc<Mutex<Vec<(String, String)>>>,
    pub sink: Arc<Mutex<Option<Sink>>>,
}

impl Spy {
    pub fn open(root: &Path) -> Spy {
        Spy {
            inner: PlainStorage::open(root).unwrap(),
            renames: Arc::default(),
            sink: Arc::default(),
        }
    }

    /// Sends `events` through the sink `Vault::watch` registered.
    pub fn inject(sink: &Mutex<Option<Sink>>, events: Vec<RawEvent>) {
        let sink = sink.lock().unwrap();
        let sink = sink.as_ref().expect("watching");
        for event in events {
            sink(event);
        }
    }
}

impl std::fmt::Debug for Spy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Spy")
    }
}

impl Storage for Spy {
    fn name(&self) -> &'static str {
        "spy"
    }
    fn location(&self) -> &Path {
        self.inner.location()
    }
    fn meta(&self, path: &VaultPath, follow: Follow) -> Result<Option<Meta>> {
        self.inner.meta(path, follow)
    }
    fn children(&self, dir: &VaultPath) -> Result<Vec<Child>> {
        self.inner.children(dir)
    }
    fn read(&self, path: &VaultPath) -> Result<Vec<u8>> {
        self.inner.read(path)
    }
    fn open_read(&self, path: &VaultPath, reach: Reach) -> Result<Reader> {
        self.inner.open_read(path, reach)
    }
    fn replace_atomic(
        &self,
        path: &VaultPath,
        from: &mut dyn std::io::Read,
        mode: Replace,
    ) -> Result<()> {
        self.inner.replace_atomic(path, from, mode)
    }
    fn create_new(&self, path: &VaultPath) -> Result<Box<dyn NewFile>> {
        self.inner.create_new(path)
    }
    fn create_dir(&self, path: &VaultPath) -> Result<()> {
        self.inner.create_dir(path)
    }
    fn remove_file(&self, path: &VaultPath) -> Result<()> {
        self.inner.remove_file(path)
    }
    fn remove_empty_dir(&self, path: &VaultPath) -> Result<()> {
        self.inner.remove_empty_dir(path)
    }
    fn rename(&self, from: &VaultPath, to: &VaultPath) -> Result<()> {
        self.renames
            .lock()
            .unwrap()
            .push((from.to_string(), to.to_string()));
        self.inner.rename(from, to)
    }
    fn trash_os(&self, path: &VaultPath) -> Result<()> {
        self.inner.trash_os(path)
    }
    fn os_path(&self, path: &VaultPath, use_: OsUse) -> Result<PathBuf> {
        self.inner.os_path(path, use_)
    }
    fn vault_path_of(&self, os: &Path) -> Option<VaultPath> {
        self.inner.vault_path_of(os)
    }
    fn same_entry(&self, a: &VaultPath, b: &VaultPath) -> bool {
        self.inner.same_entry(a, b)
    }
    fn watch(&self, _recursive: bool, sink: Sink) -> Result<WatchGuard> {
        *self.sink.lock().unwrap() = Some(sink);
        Ok(WatchGuard(Box::new(())))
    }
}
