use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use ccsquad_core::{Error, Result, frontmatter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFrontmatter {
    #[serde(
        rename = "type",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub entry_type: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct MemoryEntry {
    pub title: String,
    pub frontmatter: MemoryFrontmatter,
    pub body: String,
}

impl MemoryEntry {
    /// エントリの一意キーを返す。
    /// type あり: `{type}/{title}`, type なし: `{title}`
    pub fn key(&self) -> String {
        match &self.frontmatter.entry_type {
            Some(t) => format!("{t}/{}", self.title),
            None => self.title.clone(),
        }
    }
}

pub struct EntryStore {
    base_dir: PathBuf,
}

impl EntryStore {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    pub fn ensure_dir(&self) -> Result<()> {
        std::fs::create_dir_all(&self.base_dir)?;
        Ok(())
    }

    /// title/type に禁止文字が含まれていないか検証する。
    fn validate_name(name: &str) -> Result<()> {
        if name.is_empty() {
            return Err(Error::Memory("名前が空です".to_string()));
        }
        let forbidden = ['/', '\0', '\\'];
        for ch in forbidden {
            if name.contains(ch) {
                return Err(Error::Memory(format!(
                    "名前に禁止文字 '{ch}' が含まれています: {name}"
                )));
            }
        }
        Ok(())
    }

    /// エントリのファイルパスを返す。
    fn file_path(&self, title: &str, entry_type: Option<&str>) -> PathBuf {
        match entry_type {
            Some(t) => self.base_dir.join(t).join(format!("{title}.md")),
            None => self.base_dir.join(format!("{title}.md")),
        }
    }

    /// key からファイルパスを解決する。
    fn file_path_from_key(&self, key: &str) -> PathBuf {
        self.base_dir.join(format!("{key}.md"))
    }

    /// key から title と type を分解する。
    fn parse_key(key: &str) -> (Option<String>, String) {
        match key.rsplit_once('/') {
            Some((t, title)) => (Some(t.to_string()), title.to_string()),
            None => (None, key.to_string()),
        }
    }

    /// エントリを新規保存する。同一キーのファイルが既に存在する場合はエラー。
    pub fn save(&self, entry: &MemoryEntry) -> Result<()> {
        Self::validate_name(&entry.title)?;
        if let Some(ref t) = entry.frontmatter.entry_type {
            Self::validate_name(t)?;
        }

        let path = self.file_path(&entry.title, entry.frontmatter.entry_type.as_deref());

        if path.exists() {
            return Err(Error::Memory(format!(
                "エントリ '{}' は既に存在します",
                entry.key()
            )));
        }

        // type ディレクトリを作成
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let yaml = serde_yaml::to_string(&entry.frontmatter)
            .map_err(|e| Error::Serialization(e.to_string()))?;
        let content = frontmatter::write(&yaml, &entry.body);
        std::fs::write(&path, content)?;
        Ok(())
    }

    /// エントリを上書き保存する（edit 用）。
    pub fn overwrite(&self, entry: &MemoryEntry) -> Result<()> {
        Self::validate_name(&entry.title)?;
        if let Some(ref t) = entry.frontmatter.entry_type {
            Self::validate_name(t)?;
        }

        let path = self.file_path(&entry.title, entry.frontmatter.entry_type.as_deref());

        // type ディレクトリを作成
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let yaml = serde_yaml::to_string(&entry.frontmatter)
            .map_err(|e| Error::Serialization(e.to_string()))?;
        let content = frontmatter::write(&yaml, &entry.body);
        std::fs::write(&path, content)?;
        Ok(())
    }

    /// key でエントリを読み込む。
    pub fn load(&self, key: &str) -> Result<MemoryEntry> {
        let path = self.file_path_from_key(key);
        let content = std::fs::read_to_string(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::Memory(format!("エントリ '{key}' が見つかりません"))
            } else {
                Error::Io(e)
            }
        })?;
        let (yaml, body) = frontmatter::parse(&content)?;
        let fm: MemoryFrontmatter =
            serde_yaml::from_str(&yaml).map_err(|e| Error::Serialization(e.to_string()))?;

        let (_, title) = Self::parse_key(key);

        Ok(MemoryEntry {
            title,
            frontmatter: fm,
            body,
        })
    }

    /// 全エントリを走査して返す。created_at 降順ソート。
    pub fn list_all(&self) -> Result<Vec<MemoryEntry>> {
        let mut entries = Vec::new();

        if !self.base_dir.exists() {
            return Ok(entries);
        }

        // ルート直下の .md ファイル
        for dir_entry in std::fs::read_dir(&self.base_dir)? {
            let dir_entry = dir_entry?;
            let file_type = dir_entry.file_type()?;
            let name = dir_entry.file_name();
            let name = name.to_string_lossy();

            if file_type.is_file() && name.ends_with(".md") {
                let title = name.trim_end_matches(".md");
                match self.load(title) {
                    Ok(entry) => entries.push(entry),
                    Err(e) => {
                        tracing::warn!("メモリエントリ読み込みエラー: {name}: {e}");
                    }
                }
            } else if file_type.is_dir() {
                // 1階層サブディレクトリ内の .md ファイル
                let type_name = name.to_string();
                let sub_dir = dir_entry.path();
                if let Ok(sub_entries) = std::fs::read_dir(&sub_dir) {
                    for sub_entry in sub_entries {
                        let sub_entry = match sub_entry {
                            Ok(e) => e,
                            Err(_) => continue,
                        };
                        let sub_name = sub_entry.file_name();
                        let sub_name = sub_name.to_string_lossy();
                        if sub_name.ends_with(".md") {
                            let title = sub_name.trim_end_matches(".md");
                            let key = format!("{type_name}/{title}");
                            match self.load(&key) {
                                Ok(entry) => entries.push(entry),
                                Err(e) => {
                                    tracing::warn!(
                                        "メモリエントリ読み込みエラー: {key}: {e}"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        // created_at 降順ソート
        entries.sort_by(|a, b| b.frontmatter.created_at.cmp(&a.frontmatter.created_at));
        Ok(entries)
    }

    /// key でエントリを削除する。空になった type ディレクトリは自動削除。
    pub fn delete(&self, key: &str) -> Result<()> {
        let path = self.file_path_from_key(key);
        std::fs::remove_file(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::Memory(format!("エントリ '{key}' が見つかりません"))
            } else {
                Error::Io(e)
            }
        })?;

        // 空ディレクトリの自動削除
        if let Some(parent) = path.parent() {
            if parent != self.base_dir {
                if let Ok(mut dir_entries) = std::fs::read_dir(parent) {
                    if dir_entries.next().is_none() {
                        let _ = std::fs::remove_dir(parent);
                    }
                }
            }
        }

        Ok(())
    }

    /// title/body の部分文字列マッチ + type フィルタで検索する。
    pub fn search(&self, query: &str, entry_type: Option<&str>) -> Result<Vec<MemoryEntry>> {
        let all = self.list_all()?;
        let query_lower = query.to_lowercase();

        let results = all
            .into_iter()
            .filter(|entry| {
                // type フィルタ
                if let Some(t) = entry_type {
                    match &entry.frontmatter.entry_type {
                        Some(et) if et == t => {}
                        _ => return false,
                    }
                }
                // 部分文字列マッチ（title or body）
                entry.title.to_lowercase().contains(&query_lower)
                    || entry.body.to_lowercase().contains(&query_lower)
            })
            .collect();

        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn temp_store(dir: &Path) -> EntryStore {
        let store = EntryStore::new(dir.to_path_buf());
        store.ensure_dir().unwrap();
        store
    }

    fn make_entry(title: &str, entry_type: Option<&str>, body: &str) -> MemoryEntry {
        let now = Utc::now();
        MemoryEntry {
            title: title.to_string(),
            frontmatter: MemoryFrontmatter {
                entry_type: entry_type.map(|s| s.to_string()),
                created_at: now,
                updated_at: now,
            },
            body: body.to_string(),
        }
    }

    fn make_entry_with_time(
        title: &str,
        entry_type: Option<&str>,
        body: &str,
        created_at: DateTime<Utc>,
    ) -> MemoryEntry {
        MemoryEntry {
            title: title.to_string(),
            frontmatter: MemoryFrontmatter {
                entry_type: entry_type.map(|s| s.to_string()),
                created_at,
                updated_at: created_at,
            },
            body: body.to_string(),
        }
    }

    #[test]
    fn test_save_and_load_without_type() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let entry = make_entry("認証方式", None, "JWTを採用した。");
        store.save(&entry).unwrap();

        let loaded = store.load("認証方式").unwrap();
        assert_eq!(loaded.title, "認証方式");
        assert!(loaded.frontmatter.entry_type.is_none());
        assert!(loaded.body.contains("JWTを採用した"));
    }

    #[test]
    fn test_save_and_load_with_type() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let entry = make_entry("JWT採用理由", Some("decision"), "JWTを採用した。");
        store.save(&entry).unwrap();

        let loaded = store.load("decision/JWT採用理由").unwrap();
        assert_eq!(loaded.title, "JWT採用理由");
        assert_eq!(loaded.frontmatter.entry_type.as_deref(), Some("decision"));
        assert!(loaded.body.contains("JWTを採用した"));
    }

    #[test]
    fn test_key() {
        let entry = make_entry("認証方式", None, "");
        assert_eq!(entry.key(), "認証方式");

        let entry = make_entry("JWT採用理由", Some("decision"), "");
        assert_eq!(entry.key(), "decision/JWT採用理由");
    }

    #[test]
    fn test_duplicate_title_error() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let entry = make_entry("認証方式", None, "body1");
        store.save(&entry).unwrap();

        let entry2 = make_entry("認証方式", None, "body2");
        let result = store.save(&entry2);
        assert!(result.is_err());
    }

    #[test]
    fn test_forbidden_characters_in_title() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let entry = make_entry("bad/name", None, "body");
        assert!(store.save(&entry).is_err());

        let entry = make_entry("bad\0name", None, "body");
        assert!(store.save(&entry).is_err());
    }

    #[test]
    fn test_forbidden_characters_in_type() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let entry = make_entry("title", Some("bad/type"), "body");
        assert!(store.save(&entry).is_err());
    }

    #[test]
    fn test_empty_title_error() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let entry = make_entry("", None, "body");
        assert!(store.save(&entry).is_err());
    }

    #[test]
    fn test_empty_body() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let entry = make_entry("タイトルのみ", None, "");
        store.save(&entry).unwrap();

        let loaded = store.load("タイトルのみ").unwrap();
        assert_eq!(loaded.title, "タイトルのみ");
        assert!(loaded.body.is_empty());
    }

    #[test]
    fn test_list_all_created_at_desc() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());

        use chrono::Duration;
        let now = Utc::now();
        let old = now - Duration::hours(2);
        let mid = now - Duration::hours(1);

        store
            .save(&make_entry_with_time("古い", None, "old", old))
            .unwrap();
        store
            .save(&make_entry_with_time("中間", Some("note"), "mid", mid))
            .unwrap();
        store
            .save(&make_entry_with_time("新しい", Some("decision"), "new", now))
            .unwrap();

        let entries = store.list_all().unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].title, "新しい");
        assert_eq!(entries[1].title, "中間");
        assert_eq!(entries[2].title, "古い");
    }

    #[test]
    fn test_delete_and_empty_dir_cleanup() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let entry = make_entry("唯一のエントリ", Some("decision"), "body");
        store.save(&entry).unwrap();

        assert!(tmp.path().join("decision").exists());

        store.delete("decision/唯一のエントリ").unwrap();

        // ファイルが削除されている
        assert!(!tmp.path().join("decision/唯一のエントリ.md").exists());
        // 空ディレクトリも削除されている
        assert!(!tmp.path().join("decision").exists());
    }

    #[test]
    fn test_delete_preserves_nonempty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        store
            .save(&make_entry("エントリ1", Some("decision"), "body1"))
            .unwrap();
        store
            .save(&make_entry("エントリ2", Some("decision"), "body2"))
            .unwrap();

        store.delete("decision/エントリ1").unwrap();

        // ディレクトリはまだ存在（エントリ2 が残っている）
        assert!(tmp.path().join("decision").exists());
    }

    #[test]
    fn test_delete_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let result = store.delete("存在しない");
        assert!(result.is_err());
    }

    #[test]
    fn test_search_title_match() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        store
            .save(&make_entry("認証方式", None, "詳細"))
            .unwrap();
        store
            .save(&make_entry("DB設計", None, "テーブル定義"))
            .unwrap();

        let results = store.search("認証", None).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "認証方式");
    }

    #[test]
    fn test_search_body_match() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        store
            .save(&make_entry("設計メモ", None, "JWTトークンを使う"))
            .unwrap();
        store
            .save(&make_entry("別のメモ", None, "セッション管理"))
            .unwrap();

        let results = store.search("JWT", None).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "設計メモ");
    }

    #[test]
    fn test_search_type_filter() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        store
            .save(&make_entry("認証", Some("decision"), "JWT"))
            .unwrap();
        store
            .save(&make_entry("認証メモ", Some("note"), "JWT関連"))
            .unwrap();

        let results = store.search("JWT", Some("decision")).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].frontmatter.entry_type.as_deref(), Some("decision"));
    }

    #[test]
    fn test_search_no_match() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        store
            .save(&make_entry("認証方式", None, "JWT"))
            .unwrap();

        let results = store.search("GraphQL", None).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_overwrite_updates_body() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let entry = make_entry("認証方式", None, "旧本文");
        store.save(&entry).unwrap();

        let mut updated = entry;
        updated.body = "新本文".to_string();
        store.overwrite(&updated).unwrap();

        let loaded = store.load("認証方式").unwrap();
        assert!(loaded.body.contains("新本文"));
        assert!(!loaded.body.contains("旧本文"));
    }

    #[test]
    fn test_overwrite_with_type() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let entry = make_entry("メモ", Some("note"), "旧");
        store.save(&entry).unwrap();

        let mut updated = entry;
        updated.body = "新".to_string();
        store.overwrite(&updated).unwrap();

        let loaded = store.load("note/メモ").unwrap();
        assert!(loaded.body.contains("新"));
    }

    #[test]
    fn test_search_case_insensitive() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        store
            .save(&make_entry("Auth Design", None, "Use JWT tokens"))
            .unwrap();

        let results = store.search("jwt", None).unwrap();
        assert_eq!(results.len(), 1);
    }
}
