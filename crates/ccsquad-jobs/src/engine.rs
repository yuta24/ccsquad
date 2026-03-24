use std::collections::HashSet;

use ccsquad_core::{Error, Result};

use crate::config::{TransitionCondition, WorkflowConfig};
use crate::job::{Job, JobStatus, JobStore};

pub struct WorkflowEngine<'a> {
    config: &'a WorkflowConfig,
    store: &'a JobStore,
}

impl<'a> WorkflowEngine<'a> {
    pub fn new(config: &'a WorkflowConfig, store: &'a JobStore) -> Self {
        Self { config, store }
    }

    /// ジョブを開始し、最初のフェーズにセットする。
    pub fn start_job(&self, job_id: &str) -> Result<Job> {
        let mut job = self.store.load(job_id)?;

        if job.frontmatter.status != JobStatus::Pending {
            return Err(Error::Job(format!(
                "ジョブ '{job_id}' は既に開始されているか完了しています (status: {})",
                job.frontmatter.status
            )));
        }

        for dep_id in &job.frontmatter.depends_on {
            let dep = self.store.load(dep_id)?;
            if dep.frontmatter.status != JobStatus::Completed {
                return Err(Error::Job(format!(
                    "依存ジョブ '{dep_id}' が未完了です (status: {})",
                    dep.frontmatter.status
                )));
            }
        }

        let initial = self.config.initial_phase()?;
        job.frontmatter.status = JobStatus::Running;
        job.frontmatter.current_phase = Some(initial.to_string());
        job.frontmatter.updated_at = chrono::Utc::now();
        self.store.save(&job)?;
        Ok(job)
    }

    /// フェーズ遷移を実行する。reviewer 付きフェーズではエラー。
    pub fn transition(
        &self,
        job_id: &str,
        result: TransitionCondition,
        message: &str,
    ) -> Result<Job> {
        let mut job = self.store.load(job_id)?;
        self.verify_running(&job)?;

        let phase_name = self.current_phase_name(&job)?;
        let phase_config = self.get_phase_config(&phase_name)?;

        if phase_config.reviewer.is_some() {
            return Err(Error::Workflow(
                "レビューフェーズでは approve/reject を使用してください".to_string(),
            ));
        }

        let next = self.config.resolve_transition(&phase_name, &result)?;
        self.execute_transition(&mut job, &phase_name, &result.to_string(), &next, message)?;
        Ok(job)
    }

    /// reviewer 付きフェーズで承認する。
    pub fn approve(&self, job_id: &str, message: &str) -> Result<Job> {
        let mut job = self.store.load(job_id)?;
        self.verify_running(&job)?;

        let phase_name = self.current_phase_name(&job)?;
        let phase_config = self.get_phase_config(&phase_name)?;

        if phase_config.reviewer.is_none() {
            return Err(Error::Workflow(
                "このフェーズにはレビュアーが設定されていません".to_string(),
            ));
        }

        let next = self.config.resolve_transition(&phase_name, &TransitionCondition::Approved)?;
        self.execute_transition(&mut job, &phase_name, "approved", &next, message)?;
        Ok(job)
    }

    /// reviewer 付きフェーズで却下する。
    pub fn reject(&self, job_id: &str, message: &str) -> Result<Job> {
        let mut job = self.store.load(job_id)?;
        self.verify_running(&job)?;

        let phase_name = self.current_phase_name(&job)?;
        let phase_config = self.get_phase_config(&phase_name)?;

        if phase_config.reviewer.is_none() {
            return Err(Error::Workflow(
                "このフェーズにはレビュアーが設定されていません".to_string(),
            ));
        }

        let next = self.config.resolve_transition(&phase_name, &TransitionCondition::Rejected)?;
        self.execute_transition(&mut job, &phase_name, "rejected", &next, message)?;
        Ok(job)
    }

    /// ジョブを手動中断する。
    pub fn abort_job(&self, job_id: &str) -> Result<Job> {
        let mut job = self.store.load(job_id)?;

        match job.frontmatter.status {
            JobStatus::Pending | JobStatus::Running => {}
            _ => {
                return Err(Error::Job(format!(
                    "ジョブ '{job_id}' は中断できません (status: {})",
                    job.frontmatter.status
                )));
            }
        }

        if job.frontmatter.status == JobStatus::Running {
            if let Some(phase) = &job.frontmatter.current_phase {
                let phase = phase.clone();
                job.append_phase_log(&phase, "aborted", "ABORT", "手動中断");
            }
        }

        job.frontmatter.status = JobStatus::Aborted;
        job.frontmatter.current_phase = None;
        job.frontmatter.updated_at = chrono::Utc::now();
        self.store.save(&job)?;
        Ok(job)
    }

    /// 現在のフェーズとステータスを取得する。
    pub fn get_status(&self, job_id: &str) -> Result<(JobStatus, Option<String>)> {
        let job = self.store.load(job_id)?;
        Ok((job.frontmatter.status, job.frontmatter.current_phase))
    }

    fn verify_running(&self, job: &Job) -> Result<()> {
        if job.frontmatter.status != JobStatus::Running {
            return Err(Error::Job(format!(
                "ジョブ '{}' は実行中ではありません (status: {})",
                job.frontmatter.id, job.frontmatter.status
            )));
        }
        Ok(())
    }

    fn current_phase_name(&self, job: &Job) -> Result<String> {
        job.frontmatter
            .current_phase
            .clone()
            .ok_or_else(|| Error::Workflow("現在のフェーズが設定されていません".to_string()))
    }

    fn get_phase_config(&self, phase_name: &str) -> Result<&crate::config::PhaseConfig> {
        self.config.phases.get(phase_name).ok_or_else(|| {
            Error::Workflow(format!(
                "フェーズ '{phase_name}' がワークフローに定義されていません"
            ))
        })
    }

    fn execute_transition(
        &self,
        job: &mut Job,
        phase_name: &str,
        result: &str,
        next: &str,
        message: &str,
    ) -> Result<()> {
        job.append_phase_log(phase_name, result, next, message);

        match next {
            "COMPLETE" => {
                job.frontmatter.status = JobStatus::Completed;
                job.frontmatter.current_phase = None;
            }
            "ABORT" => {
                job.frontmatter.status = JobStatus::Failed;
                job.frontmatter.current_phase = None;
            }
            _ => {
                job.frontmatter.current_phase = Some(next.to_string());
            }
        }

        job.frontmatter.updated_at = chrono::Utc::now();
        self.store.save(job)?;
        Ok(())
    }
}

/// depends_on の循環依存を検出する。
pub fn check_circular_dependency(
    store: &JobStore,
    job_id: &str,
    depends_on: &[String],
) -> Result<()> {
    let mut visited = HashSet::new();
    let mut stack: Vec<String> = depends_on.to_vec();

    while let Some(dep_id) = stack.pop() {
        if dep_id == job_id {
            return Err(Error::Job("循環依存が検出されました".to_string()));
        }
        if !visited.insert(dep_id.clone()) {
            continue;
        }
        if let Ok(dep_job) = store.load(&dep_id) {
            stack.extend(dep_job.frontmatter.depends_on);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SquadConfig;
    use crate::job::{Job, JobFrontmatter, JobStatus};
    use chrono::Utc;

    fn dev_config() -> SquadConfig {
        let yaml = r#"
workflows:
  dev:
    description: 開発ワークフロー
    phases:
      plan:
        description: 計画
        agent: planner
        on:
          completed: code
          failed: ABORT
      code:
        description: 実装
        agent: coder
        on:
          completed: review
          failed: plan
      review:
        description: レビュー
        agent: reviewer
        reviewer: human
        on:
          approved: COMPLETE
          rejected: code
"#;
        serde_yaml::from_str(yaml).unwrap()
    }

    fn make_job(id: &str, status: JobStatus) -> Job {
        let now = Utc::now();
        Job {
            frontmatter: JobFrontmatter {
                id: id.to_string(),
                title: "テスト".to_string(),
                workflow: "dev".to_string(),
                status,
                current_phase: None,
                priority: 0,
                depends_on: vec![],
                created_at: now,
                updated_at: now,
            },
            body: String::new(),
        }
    }

    fn setup() -> (tempfile::TempDir, SquadConfig, JobStore) {
        let tmp = tempfile::tempdir().unwrap();
        let store = JobStore::new(tmp.path().to_path_buf());
        store.ensure_dir().unwrap();
        let config = dev_config();
        (tmp, config, store)
    }

    #[test]
    fn test_linear_workflow() {
        let (_tmp, config, store) = setup();
        let wf = config.get_workflow("dev").unwrap();
        let engine = WorkflowEngine::new(wf, &store);

        store.save(&make_job("J000001", JobStatus::Pending)).unwrap();

        let job = engine.start_job("J000001").unwrap();
        assert_eq!(job.frontmatter.status, JobStatus::Running);
        assert_eq!(job.frontmatter.current_phase.as_deref(), Some("plan"));

        // plan -> completed -> code
        let job = engine.transition("J000001", TransitionCondition::Completed, "計画完了").unwrap();
        assert_eq!(job.frontmatter.current_phase.as_deref(), Some("code"));

        // code -> completed -> review
        let job = engine.transition("J000001", TransitionCondition::Completed, "実装完了").unwrap();
        assert_eq!(job.frontmatter.current_phase.as_deref(), Some("review"));

        // review -> approved -> COMPLETE
        let job = engine.approve("J000001", "LGTM").unwrap();
        assert_eq!(job.frontmatter.status, JobStatus::Completed);
        assert_eq!(job.frontmatter.current_phase, None);
    }

    #[test]
    fn test_loop_workflow() {
        let (_tmp, config, store) = setup();
        let wf = config.get_workflow("dev").unwrap();
        let engine = WorkflowEngine::new(wf, &store);

        store.save(&make_job("J000001", JobStatus::Pending)).unwrap();
        engine.start_job("J000001").unwrap();
        engine.transition("J000001", TransitionCondition::Completed, "").unwrap();
        engine.transition("J000001", TransitionCondition::Completed, "").unwrap();

        // review -> rejected -> code
        let job = engine.reject("J000001", "テスト不足").unwrap();
        assert_eq!(job.frontmatter.current_phase.as_deref(), Some("code"));

        // code -> completed -> review
        let job = engine.transition("J000001", TransitionCondition::Completed, "修正完了").unwrap();
        assert_eq!(job.frontmatter.current_phase.as_deref(), Some("review"));

        let job = engine.approve("J000001", "OK").unwrap();
        assert_eq!(job.frontmatter.status, JobStatus::Completed);
    }

    #[test]
    fn test_failure_fallback() {
        let (_tmp, config, store) = setup();
        let wf = config.get_workflow("dev").unwrap();
        let engine = WorkflowEngine::new(wf, &store);

        store.save(&make_job("J000001", JobStatus::Pending)).unwrap();
        engine.start_job("J000001").unwrap();
        engine.transition("J000001", TransitionCondition::Completed, "").unwrap();

        // code -> failed -> plan
        let job = engine.transition("J000001", TransitionCondition::Failed, "ビルドエラー").unwrap();
        assert_eq!(job.frontmatter.current_phase.as_deref(), Some("plan"));
    }

    #[test]
    fn test_abort_to_failed() {
        let (_tmp, config, store) = setup();
        let wf = config.get_workflow("dev").unwrap();
        let engine = WorkflowEngine::new(wf, &store);

        store.save(&make_job("J000001", JobStatus::Pending)).unwrap();
        engine.start_job("J000001").unwrap();

        // plan -> failed -> ABORT
        let job = engine.transition("J000001", TransitionCondition::Failed, "").unwrap();
        assert_eq!(job.frontmatter.status, JobStatus::Failed);
        assert_eq!(job.frontmatter.current_phase, None);
    }

    #[test]
    fn test_reviewer_phase_rejects_transition() {
        let (_tmp, config, store) = setup();
        let wf = config.get_workflow("dev").unwrap();
        let engine = WorkflowEngine::new(wf, &store);

        store.save(&make_job("J000001", JobStatus::Pending)).unwrap();
        engine.start_job("J000001").unwrap();
        engine.transition("J000001", TransitionCondition::Completed, "").unwrap();
        engine.transition("J000001", TransitionCondition::Completed, "").unwrap();

        let result = engine.transition("J000001", TransitionCondition::Completed, "");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("approve/reject"));
    }

    #[test]
    fn test_non_reviewer_phase_rejects_approve() {
        let (_tmp, config, store) = setup();
        let wf = config.get_workflow("dev").unwrap();
        let engine = WorkflowEngine::new(wf, &store);

        store.save(&make_job("J000001", JobStatus::Pending)).unwrap();
        engine.start_job("J000001").unwrap();

        let result = engine.approve("J000001", "");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("レビュアー"));
    }

    #[test]
    fn test_non_reviewer_phase_rejects_reject() {
        let (_tmp, config, store) = setup();
        let wf = config.get_workflow("dev").unwrap();
        let engine = WorkflowEngine::new(wf, &store);

        store.save(&make_job("J000001", JobStatus::Pending)).unwrap();
        engine.start_job("J000001").unwrap();

        let result = engine.reject("J000001", "ダメ");
        assert!(result.is_err());
    }

    #[test]
    fn test_no_matching_rule() {
        let (_tmp, config, store) = setup();
        let wf = config.get_workflow("dev").unwrap();
        let engine = WorkflowEngine::new(wf, &store);

        store.save(&make_job("J000001", JobStatus::Pending)).unwrap();
        engine.start_job("J000001").unwrap();
        engine.transition("J000001", TransitionCondition::Completed, "").unwrap();

        let result = engine.transition("J000001", TransitionCondition::Rejected, "");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("ルールがありません"));
    }

    #[test]
    fn test_completed_job_cannot_restart() {
        let (_tmp, config, store) = setup();
        let wf = config.get_workflow("dev").unwrap();
        let engine = WorkflowEngine::new(wf, &store);

        store.save(&make_job("J000001", JobStatus::Completed)).unwrap();

        let result = engine.start_job("J000001");
        assert!(result.is_err());
    }

    #[test]
    fn test_depends_on_blocks_start() {
        let (_tmp, config, store) = setup();
        let wf = config.get_workflow("dev").unwrap();
        let engine = WorkflowEngine::new(wf, &store);

        store.save(&make_job("J000001", JobStatus::Running)).unwrap();

        let mut job2 = make_job("J000002", JobStatus::Pending);
        job2.frontmatter.depends_on = vec!["J000001".to_string()];
        store.save(&job2).unwrap();

        let result = engine.start_job("J000002");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("未完了"));
    }

    #[test]
    fn test_depends_on_allows_start_when_completed() {
        let (_tmp, config, store) = setup();
        let wf = config.get_workflow("dev").unwrap();
        let engine = WorkflowEngine::new(wf, &store);

        store.save(&make_job("J000001", JobStatus::Completed)).unwrap();

        let mut job2 = make_job("J000002", JobStatus::Pending);
        job2.frontmatter.depends_on = vec!["J000001".to_string()];
        store.save(&job2).unwrap();

        let job = engine.start_job("J000002").unwrap();
        assert_eq!(job.frontmatter.status, JobStatus::Running);
    }

    #[test]
    fn test_abort_running_job() {
        let (_tmp, config, store) = setup();
        let wf = config.get_workflow("dev").unwrap();
        let engine = WorkflowEngine::new(wf, &store);

        store.save(&make_job("J000001", JobStatus::Pending)).unwrap();
        engine.start_job("J000001").unwrap();

        let job = engine.abort_job("J000001").unwrap();
        assert_eq!(job.frontmatter.status, JobStatus::Aborted);
        assert_eq!(job.frontmatter.current_phase, None);
        assert!(job.body.contains("手動中断"));
    }

    #[test]
    fn test_abort_pending_job() {
        let (_tmp, config, store) = setup();
        let wf = config.get_workflow("dev").unwrap();
        let engine = WorkflowEngine::new(wf, &store);

        store.save(&make_job("J000001", JobStatus::Pending)).unwrap();

        let job = engine.abort_job("J000001").unwrap();
        assert_eq!(job.frontmatter.status, JobStatus::Aborted);
    }

    #[test]
    fn test_circular_dependency_detection() {
        let tmp = tempfile::tempdir().unwrap();
        let store = JobStore::new(tmp.path().to_path_buf());
        store.ensure_dir().unwrap();

        let mut job1 = make_job("J000001", JobStatus::Pending);
        job1.frontmatter.depends_on = vec!["J000002".to_string()];
        store.save(&job1).unwrap();

        let mut job2 = make_job("J000002", JobStatus::Pending);
        job2.frontmatter.depends_on = vec!["J000001".to_string()];
        store.save(&job2).unwrap();

        let result = check_circular_dependency(&store, "J000001", &["J000002".to_string()]);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("循環依存"));
    }

    #[test]
    fn test_no_circular_dependency() {
        let tmp = tempfile::tempdir().unwrap();
        let store = JobStore::new(tmp.path().to_path_buf());
        store.ensure_dir().unwrap();

        store.save(&make_job("J000001", JobStatus::Completed)).unwrap();
        store.save(&make_job("J000002", JobStatus::Completed)).unwrap();

        let result = check_circular_dependency(&store, "J000003", &["J000001".to_string(), "J000002".to_string()]);
        assert!(result.is_ok());
    }
}
