use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use ccsquad_core::{Error, Result, frontmatter};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Aborted,
}

impl std::fmt::Display for JobStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Running => write!(f, "running"),
            Self::Completed => write!(f, "completed"),
            Self::Failed => write!(f, "failed"),
            Self::Aborted => write!(f, "aborted"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobFrontmatter {
    pub id: String,
    pub title: String,
    pub workflow: String,
    pub status: JobStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_phase: Option<String>,
    #[serde(default)]
    pub priority: i32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct Job {
    pub frontmatter: JobFrontmatter,
    pub body: String,
}

impl Job {
    /// body の「## フェーズログ」セクションにエントリを追記する。
    pub fn append_phase_log(&mut self, phase: &str, result: &str, next: &str, message: &str) {
        let timestamp = Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
        let entry = if message.is_empty() {
            format!("### {phase} ({result} → {next}) - {timestamp}\n\n")
        } else {
            format!("### {phase} ({result} → {next}) - {timestamp}\n{message}\n\n")
        };

        if self.body.contains("## フェーズログ") {
            self.body.push_str(&entry);
        } else {
            if !self.body.is_empty() && !self.body.ends_with('\n') {
                self.body.push('\n');
            }
            self.body.push_str("\n## フェーズログ\n");
            self.body.push_str(&entry);
        }
    }
}

pub struct JobStore {
    base_dir: PathBuf,
}

impl JobStore {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    pub fn ensure_dir(&self) -> Result<()> {
        std::fs::create_dir_all(&self.base_dir)?;
        Ok(())
    }

    fn file_path(&self, id: &str) -> PathBuf {
        self.base_dir.join(format!("{id}.md"))
    }

    pub fn next_id(&self) -> Result<String> {
        let mut max_num: u32 = 0;
        if self.base_dir.exists() {
            for entry in std::fs::read_dir(&self.base_dir)? {
                let entry = entry?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if let Some(num_str) = name.strip_prefix('J').and_then(|s| s.strip_suffix(".md")) {
                    if let Ok(num) = num_str.parse::<u32>() {
                        max_num = max_num.max(num);
                    }
                }
            }
        }
        Ok(format!("J{:06}", max_num + 1))
    }

    pub fn save(&self, job: &Job) -> Result<()> {
        let yaml =
            serde_yaml::to_string(&job.frontmatter).map_err(|e| Error::Serialization(e.to_string()))?;
        let content = frontmatter::write(&yaml, &job.body);
        std::fs::write(self.file_path(&job.frontmatter.id), content)?;
        Ok(())
    }

    pub fn load(&self, id: &str) -> Result<Job> {
        let path = self.file_path(id);
        let content = std::fs::read_to_string(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::Job(format!("ジョブ '{id}' が見つかりません"))
            } else {
                Error::Io(e)
            }
        })?;
        let (yaml, body) = frontmatter::parse(&content)?;
        let fm: JobFrontmatter =
            serde_yaml::from_str(&yaml).map_err(|e| Error::Serialization(e.to_string()))?;
        Ok(Job {
            frontmatter: fm,
            body,
        })
    }

    pub fn list_all(&self) -> Result<Vec<Job>> {
        let mut jobs = Vec::new();
        if !self.base_dir.exists() {
            return Ok(jobs);
        }
        for entry in std::fs::read_dir(&self.base_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('J') && name.ends_with(".md") {
                let id = name.trim_end_matches(".md");
                match self.load(id) {
                    Ok(job) => jobs.push(job),
                    Err(e) => {
                        tracing::warn!("ジョブファイル読み込みエラー: {name}: {e}");
                    }
                }
            }
        }
        jobs.sort_by(|a, b| a.frontmatter.id.cmp(&b.frontmatter.id));
        Ok(jobs)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let path = self.file_path(id);
        std::fs::remove_file(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::Job(format!("ジョブ '{id}' が見つかりません"))
            } else {
                Error::Io(e)
            }
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn temp_store(dir: &Path) -> JobStore {
        let store = JobStore::new(dir.to_path_buf());
        store.ensure_dir().unwrap();
        store
    }

    fn make_job(id: &str, title: &str) -> Job {
        let now = Utc::now();
        Job {
            frontmatter: JobFrontmatter {
                id: id.to_string(),
                title: title.to_string(),
                workflow: "dev".to_string(),
                status: JobStatus::Pending,
                current_phase: None,
                priority: 0,
                depends_on: vec![],
                created_at: now,
                updated_at: now,
            },
            body: "## 説明\nテストジョブです。\n".to_string(),
        }
    }

    #[test]
    fn test_save_and_load() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let job = make_job("J000001", "テスト");
        store.save(&job).unwrap();
        let loaded = store.load("J000001").unwrap();
        assert_eq!(loaded.frontmatter.id, "J000001");
        assert_eq!(loaded.frontmatter.title, "テスト");
        assert_eq!(loaded.frontmatter.status, JobStatus::Pending);
        assert!(loaded.body.contains("テストジョブです"));
    }

    #[test]
    fn test_next_id_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        assert_eq!(store.next_id().unwrap(), "J000001");
    }

    #[test]
    fn test_next_id_increments() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        store.save(&make_job("J000001", "a")).unwrap();
        store.save(&make_job("J000003", "b")).unwrap();
        assert_eq!(store.next_id().unwrap(), "J000004");
    }

    #[test]
    fn test_list_all() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        store.save(&make_job("J000001", "a")).unwrap();
        store.save(&make_job("J000002", "b")).unwrap();
        let jobs = store.list_all().unwrap();
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].frontmatter.id, "J000001");
        assert_eq!(jobs[1].frontmatter.id, "J000002");
    }

    #[test]
    fn test_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        store.save(&make_job("J000001", "a")).unwrap();
        store.delete("J000001").unwrap();
        assert!(store.load("J000001").is_err());
    }

    #[test]
    fn test_load_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let result = store.load("J999999");
        assert!(result.is_err());
    }

    #[test]
    fn test_append_phase_log_creates_section() {
        let mut job = make_job("J000001", "test");
        job.append_phase_log("plan", "completed", "code", "計画完了");
        assert!(job.body.contains("## フェーズログ"));
        assert!(job.body.contains("### plan (completed → code)"));
        assert!(job.body.contains("計画完了"));
    }

    #[test]
    fn test_append_phase_log_appends() {
        let mut job = make_job("J000001", "test");
        job.append_phase_log("plan", "completed", "code", "計画完了");
        job.append_phase_log("code", "completed", "review", "実装完了");
        let log_count = job.body.matches("###").count();
        assert_eq!(log_count, 2);
    }

    #[test]
    fn test_append_phase_log_empty_message() {
        let mut job = make_job("J000001", "test");
        job.append_phase_log("plan", "completed", "code", "");
        assert!(job.body.contains("### plan (completed → code)"));
    }
}
