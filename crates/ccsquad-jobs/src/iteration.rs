use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use ccsquad_core::Result;

#[derive(Debug, Default, Serialize, Deserialize)]
struct IterationData {
    #[serde(flatten)]
    entries: HashMap<String, u32>,
}

pub struct IterationStore {
    path: PathBuf,
}

impl IterationStore {
    pub fn new(squad_dir: &std::path::Path) -> Self {
        Self {
            path: squad_dir.join("iteration.json"),
        }
    }

    fn load(&self) -> Result<IterationData> {
        if !self.path.exists() {
            return Ok(IterationData::default());
        }
        let content = std::fs::read_to_string(&self.path)?;
        let data: IterationData =
            serde_json::from_str(&content).map_err(|e| ccsquad_core::Error::Serialization(e.to_string()))?;
        Ok(data)
    }

    fn save(&self, data: &IterationData) -> Result<()> {
        let content =
            serde_json::to_string_pretty(data).map_err(|e| ccsquad_core::Error::Serialization(e.to_string()))?;
        std::fs::write(&self.path, content)?;
        Ok(())
    }

    /// 現在のイテレーション数を返す。未登録なら 0。
    pub fn get(&self, job_id: &str) -> Result<u32> {
        let data = self.load()?;
        Ok(data.entries.get(job_id).copied().unwrap_or(0))
    }

    /// イテレーション数をインクリメントし、新しい値を返す。
    pub fn increment(&self, job_id: &str) -> Result<u32> {
        let mut data = self.load()?;
        let count = data.entries.entry(job_id.to_string()).or_insert(0);
        *count += 1;
        let new_count = *count;
        self.save(&data)?;
        Ok(new_count)
    }

    /// イテレーション数を 0 にリセットする。
    pub fn reset(&self, job_id: &str) -> Result<()> {
        let mut data = self.load()?;
        data.entries.insert(job_id.to_string(), 0);
        self.save(&data)?;
        Ok(())
    }

    /// ジョブのエントリを削除する。
    pub fn remove(&self, job_id: &str) -> Result<()> {
        let mut data = self.load()?;
        data.entries.remove(job_id);
        self.save(&data)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_returns_zero_for_unknown() {
        let tmp = tempfile::tempdir().unwrap();
        let store = IterationStore::new(tmp.path());
        assert_eq!(store.get("J000001").unwrap(), 0);
    }

    #[test]
    fn test_increment() {
        let tmp = tempfile::tempdir().unwrap();
        let store = IterationStore::new(tmp.path());
        assert_eq!(store.increment("J000001").unwrap(), 1);
        assert_eq!(store.increment("J000001").unwrap(), 2);
        assert_eq!(store.increment("J000001").unwrap(), 3);
        assert_eq!(store.get("J000001").unwrap(), 3);
    }

    #[test]
    fn test_reset() {
        let tmp = tempfile::tempdir().unwrap();
        let store = IterationStore::new(tmp.path());
        store.increment("J000001").unwrap();
        store.increment("J000001").unwrap();
        store.reset("J000001").unwrap();
        assert_eq!(store.get("J000001").unwrap(), 0);
    }

    #[test]
    fn test_remove() {
        let tmp = tempfile::tempdir().unwrap();
        let store = IterationStore::new(tmp.path());
        store.increment("J000001").unwrap();
        store.remove("J000001").unwrap();
        assert_eq!(store.get("J000001").unwrap(), 0);
    }

    #[test]
    fn test_multiple_jobs() {
        let tmp = tempfile::tempdir().unwrap();
        let store = IterationStore::new(tmp.path());
        store.increment("J000001").unwrap();
        store.increment("J000001").unwrap();
        store.increment("J000002").unwrap();
        assert_eq!(store.get("J000001").unwrap(), 2);
        assert_eq!(store.get("J000002").unwrap(), 1);
    }
}
