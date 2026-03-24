use std::path::PathBuf;

use ccsquad_core::Result;

pub struct CurrentJobsStore {
    path: PathBuf,
}

impl CurrentJobsStore {
    pub fn new(squad_dir: &std::path::Path) -> Self {
        Self {
            path: squad_dir.join("current-jobs.json"),
        }
    }

    fn load(&self) -> Result<Vec<String>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let content = std::fs::read_to_string(&self.path)?;
        let jobs: Vec<String> =
            serde_json::from_str(&content).map_err(|e| ccsquad_core::Error::Serialization(e.to_string()))?;
        Ok(jobs)
    }

    fn save(&self, jobs: &[String]) -> Result<()> {
        if jobs.is_empty() {
            if self.path.exists() {
                std::fs::remove_file(&self.path)?;
            }
            return Ok(());
        }
        let content =
            serde_json::to_string_pretty(jobs).map_err(|e| ccsquad_core::Error::Serialization(e.to_string()))?;
        std::fs::write(&self.path, content)?;
        Ok(())
    }

    /// ジョブIDを追加する。重複は無視。
    pub fn add(&self, job_id: &str) -> Result<()> {
        let mut jobs = self.load()?;
        if !jobs.iter().any(|id| id == job_id) {
            jobs.push(job_id.to_string());
            self.save(&jobs)?;
        }
        Ok(())
    }

    /// ジョブIDを削除する。空になったらファイル自体を削除。
    pub fn remove(&self, job_id: &str) -> Result<()> {
        let mut jobs = self.load()?;
        jobs.retain(|id| id != job_id);
        self.save(&jobs)?;
        Ok(())
    }

    /// ジョブIDが含まれるか確認する。
    pub fn contains(&self, job_id: &str) -> Result<bool> {
        let jobs = self.load()?;
        Ok(jobs.iter().any(|id| id == job_id))
    }

    /// 全アクティブジョブIDを返す。
    pub fn list(&self) -> Result<Vec<String>> {
        self.load()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_and_contains() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CurrentJobsStore::new(tmp.path());
        assert!(!store.contains("J000001").unwrap());
        store.add("J000001").unwrap();
        assert!(store.contains("J000001").unwrap());
    }

    #[test]
    fn test_add_duplicate_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CurrentJobsStore::new(tmp.path());
        store.add("J000001").unwrap();
        store.add("J000001").unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn test_remove() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CurrentJobsStore::new(tmp.path());
        store.add("J000001").unwrap();
        store.remove("J000001").unwrap();
        assert!(!store.contains("J000001").unwrap());
        // ファイルも削除される
        assert!(!tmp.path().join("current-jobs.json").exists());
    }

    #[test]
    fn test_remove_nonexistent() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CurrentJobsStore::new(tmp.path());
        store.remove("J999999").unwrap();
    }

    #[test]
    fn test_multiple_jobs() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CurrentJobsStore::new(tmp.path());
        store.add("J000001").unwrap();
        store.add("J000002").unwrap();
        store.add("J000003").unwrap();
        assert_eq!(store.list().unwrap().len(), 3);
        store.remove("J000002").unwrap();
        let remaining = store.list().unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(remaining.contains(&"J000001".to_string()));
        assert!(remaining.contains(&"J000003".to_string()));
    }

    #[test]
    fn test_list_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CurrentJobsStore::new(tmp.path());
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn test_corrupted_json_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("current-jobs.json");
        std::fs::write(&path, "not valid json").unwrap();
        let store = CurrentJobsStore::new(tmp.path());
        assert!(store.list().is_err());
        assert!(store.add("J000001").is_err());
        assert!(store.contains("J000001").is_err());
        assert!(store.remove("J000001").is_err());
    }

    #[test]
    fn test_non_array_json_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("current-jobs.json");
        std::fs::write(&path, r#"{"key": "value"}"#).unwrap();
        let store = CurrentJobsStore::new(tmp.path());
        assert!(store.list().is_err());
    }
}
