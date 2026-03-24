use std::path::Path;

use chrono::Utc;
use clap::Subcommand;
use serde::Serialize;

use ccsquad_core::Result;
use ccsquad_jobs::config::{SquadConfig, TransitionCondition};
use ccsquad_jobs::current_jobs::CurrentJobsStore;
use ccsquad_jobs::engine::{WorkflowEngine, check_circular_dependency};
use ccsquad_jobs::iteration::IterationStore;
use ccsquad_jobs::job::{Job, JobFrontmatter, JobStatus, JobStore};

#[derive(Clone, clap::ValueEnum)]
pub enum OutputFormat {
    Text,
    Json,
}

#[derive(Subcommand)]
pub enum JobAction {
    /// ジョブ一覧を表示
    List,
    /// ジョブ詳細を表示
    Show {
        id: String,
        #[arg(long, value_enum, default_value = "text")]
        format: OutputFormat,
    },
    /// ジョブを追加
    Add {
        title: String,
        #[arg(long)]
        workflow: String,
        #[arg(long)]
        description: Option<String>,
        #[arg(long, default_value = "0")]
        priority: i32,
        #[arg(long, value_delimiter = ',')]
        depends_on: Vec<String>,
    },
    /// ジョブを編集
    Edit {
        id: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        description: Option<String>,
        #[arg(long)]
        priority: Option<i32>,
        #[arg(long, value_delimiter = ',')]
        depends_on: Option<Vec<String>>,
    },
    /// ジョブを開始
    Run {
        id: String,
    },
    /// フェーズ遷移
    Transition {
        id: String,
        result: String,
        #[arg(long, default_value = "")]
        message: String,
    },
    /// レビュー承認
    Approve {
        id: String,
        #[arg(long, default_value = "")]
        message: String,
    },
    /// レビュー却下
    Reject {
        id: String,
        #[arg(long)]
        message: String,
    },
    /// ジョブを中断
    Abort {
        id: String,
    },
    /// ジョブをクローズ
    Close {
        id: String,
    },
    /// 実行中ジョブをアクティブとして登録
    Activate {
        id: String,
    },
    /// アクティブジョブの登録を解除
    Deactivate {
        id: String,
    },
    /// サブエージェント完了後の次アクション判定
    NextAction {
        id: String,
        #[arg(long)]
        result: String,
        #[arg(long, default_value = "")]
        message: String,
        #[arg(long)]
        reset_iteration: bool,
    },
}

pub fn run(action: JobAction, config: &SquadConfig, jobs_dir: &Path, squad_dir: &Path) -> Result<()> {
    let store = JobStore::new(jobs_dir.to_path_buf());
    let iteration_store = IterationStore::new(squad_dir);

    match action {
        JobAction::List => cmd_list(&store),
        JobAction::Show { id, format } => cmd_show(&store, config, &id, &format),
        JobAction::Add {
            title,
            workflow,
            description,
            priority,
            depends_on,
        } => cmd_add(&store, config, &title, &workflow, description.as_deref(), priority, &depends_on),
        JobAction::Edit {
            id,
            title,
            description,
            priority,
            depends_on,
        } => cmd_edit(&store, &id, title.as_deref(), description.as_deref(), priority, depends_on),
        JobAction::Run { id } => cmd_run(&store, config, &id),
        JobAction::Transition {
            id,
            result,
            message,
        } => cmd_transition(&store, config, &id, &result, &message),
        JobAction::Approve { id, message } => cmd_approve(&store, config, &id, &message),
        JobAction::Reject { id, message } => cmd_reject(&store, config, &id, &message),
        JobAction::Abort { id } => cmd_abort(&store, config, &id),
        JobAction::Close { id } => cmd_close(&store, config, &iteration_store, &id),
        JobAction::Activate { id } => cmd_activate(squad_dir, &id),
        JobAction::Deactivate { id } => cmd_deactivate(squad_dir, &id),
        JobAction::NextAction {
            id,
            result,
            message,
            reset_iteration,
        } => cmd_next_action(&store, config, &iteration_store, &id, &result, &message, reset_iteration),
    }
}

fn cmd_list(store: &JobStore) -> Result<()> {
    let jobs = store.list_all()?;
    if jobs.is_empty() {
        println!("ジョブはありません。");
        return Ok(());
    }
    println!(
        "{:<10} {:<30} {:<10} {:<12} {:<12} {:<4}",
        "ID", "タイトル", "ワークフロー", "ステータス", "フェーズ", "優先度"
    );
    println!("{}", "-".repeat(80));
    for job in &jobs {
        let fm = &job.frontmatter;
        println!(
            "{:<10} {:<30} {:<10} {:<12} {:<12} {:<4}",
            fm.id,
            truncate(&fm.title, 28),
            fm.workflow,
            fm.status.to_string(),
            fm.current_phase.as_deref().unwrap_or("-"),
            fm.priority,
        );
    }
    Ok(())
}

fn cmd_show(store: &JobStore, config: &SquadConfig, id: &str, format: &OutputFormat) -> Result<()> {
    let job = store.load(id)?;

    match format {
        OutputFormat::Json => {
            let phase_info = get_phase_info(config, &job);
            let output = JobShowJson {
                id: &job.frontmatter.id,
                title: &job.frontmatter.title,
                workflow: &job.frontmatter.workflow,
                status: &job.frontmatter.status.to_string(),
                current_phase: job.frontmatter.current_phase.as_deref(),
                priority: job.frontmatter.priority,
                depends_on: &job.frontmatter.depends_on,
                created_at: &job.frontmatter.created_at.to_rfc3339(),
                updated_at: &job.frontmatter.updated_at.to_rfc3339(),
                phase_config: phase_info.as_ref(),
                body: &job.body,
            };
            let json = serde_json::to_string_pretty(&output)
                .map_err(|e| ccsquad_core::Error::Serialization(e.to_string()))?;
            println!("{json}");
        }
        OutputFormat::Text => {
            let fm = &job.frontmatter;
            println!("{}: {}", fm.id, fm.title);
            println!("ワークフロー: {}", fm.workflow);
            println!("ステータス: {}", fm.status);
            if let Some(phase) = &fm.current_phase {
                println!("現在のフェーズ: {phase}");
                if let Some(info) = get_phase_info(config, &job) {
                    if let Some(desc) = &info.description {
                        println!("  説明: {desc}");
                    }
                    if let Some(agent) = &info.agent {
                        println!("  エージェント: {agent}");
                    }
                    if let Some(reviewer) = &info.reviewer {
                        println!("  レビュアー: {reviewer}");
                    }
                }
            }
            println!("優先度: {}", fm.priority);
            if !fm.depends_on.is_empty() {
                println!("依存: {}", fm.depends_on.join(", "));
            }
            println!("作成日時: {}", fm.created_at);
            println!("更新日時: {}", fm.updated_at);
            if !job.body.is_empty() {
                println!();
                print!("{}", job.body);
            }
        }
    }
    Ok(())
}

fn cmd_add(
    store: &JobStore,
    config: &SquadConfig,
    title: &str,
    workflow: &str,
    description: Option<&str>,
    priority: i32,
    depends_on: &[String],
) -> Result<()> {
    // ワークフローの存在チェック
    if config.get_workflow(workflow).is_none() {
        return Err(ccsquad_core::Error::Config(format!(
            "ワークフロー '{workflow}' が ccsquad.yaml に定義されていません"
        )));
    }

    let id = store.next_id()?;

    // 循環依存チェック
    if !depends_on.is_empty() {
        // depends_on のジョブが存在するか確認
        for dep_id in depends_on {
            store.load(dep_id)?;
        }
        check_circular_dependency(store, &id, depends_on)?;
    }

    let now = Utc::now();
    let body = match description {
        Some(desc) => format!("## 説明\n{desc}\n"),
        None => String::new(),
    };

    let job = Job {
        frontmatter: JobFrontmatter {
            id: id.clone(),
            title: title.to_string(),
            workflow: workflow.to_string(),
            status: JobStatus::Pending,
            current_phase: None,
            priority,
            depends_on: depends_on.to_vec(),
            created_at: now,
            updated_at: now,
        },
        body,
    };

    store.save(&job)?;
    println!("ジョブを作成しました: {id}");
    Ok(())
}

fn cmd_edit(
    store: &JobStore,
    id: &str,
    title: Option<&str>,
    description: Option<&str>,
    priority: Option<i32>,
    depends_on: Option<Vec<String>>,
) -> Result<()> {
    let mut job = store.load(id)?;

    if let Some(title) = title {
        job.frontmatter.title = title.to_string();
    }
    if let Some(priority) = priority {
        job.frontmatter.priority = priority;
    }
    if let Some(depends_on) = &depends_on {
        for dep_id in depends_on {
            store.load(dep_id)?;
        }
        check_circular_dependency(store, id, depends_on)?;
        job.frontmatter.depends_on = depends_on.clone();
    }
    if let Some(desc) = description {
        // body の「## 説明」セクションを置換、なければ先頭に追加
        if let Some(start) = job.body.find("## 説明\n") {
            let section_end = job.body[start + "## 説明\n".len()..]
                .find("\n## ")
                .map(|pos| start + "## 説明\n".len() + pos)
                .unwrap_or(job.body.len());
            let before = &job.body[..start];
            let after = &job.body[section_end..];
            job.body = format!("{before}## 説明\n{desc}\n{after}");
        } else {
            let old_body = std::mem::take(&mut job.body);
            job.body = format!("## 説明\n{desc}\n{old_body}");
        }
    }

    job.frontmatter.updated_at = Utc::now();
    store.save(&job)?;
    println!("ジョブを更新しました: {id}");
    Ok(())
}

fn cmd_run(store: &JobStore, config: &SquadConfig, id: &str) -> Result<()> {
    let job = store.load(id)?;
    let wf = config
        .get_workflow(&job.frontmatter.workflow)
        .ok_or_else(|| {
            ccsquad_core::Error::Config(format!(
                "ワークフロー '{}' が ccsquad.yaml に定義されていません",
                job.frontmatter.workflow
            ))
        })?;

    let engine = WorkflowEngine::new(wf, store);
    let job = engine.start_job(id)?;
    let phase = job.frontmatter.current_phase.as_deref().unwrap_or("?");
    println!("ジョブを開始しました: {id} (フェーズ: {phase})");
    Ok(())
}

fn cmd_transition(
    store: &JobStore,
    config: &SquadConfig,
    id: &str,
    result: &str,
    message: &str,
) -> Result<()> {
    let condition: TransitionCondition = result.parse()?;
    let job = store.load(id)?;
    let wf = get_workflow(config, &job)?;
    let engine = WorkflowEngine::new(wf, store);

    let job = engine.transition(id, condition, message)?;
    print_transition_result(&job);
    Ok(())
}

fn cmd_approve(store: &JobStore, config: &SquadConfig, id: &str, message: &str) -> Result<()> {
    let job = store.load(id)?;
    let wf = get_workflow(config, &job)?;
    let engine = WorkflowEngine::new(wf, store);

    let job = engine.approve(id, message)?;
    print_transition_result(&job);
    Ok(())
}

fn cmd_reject(store: &JobStore, config: &SquadConfig, id: &str, message: &str) -> Result<()> {
    let job = store.load(id)?;
    let wf = get_workflow(config, &job)?;
    let engine = WorkflowEngine::new(wf, store);

    let job = engine.reject(id, message)?;
    print_transition_result(&job);
    Ok(())
}

fn cmd_abort(store: &JobStore, config: &SquadConfig, id: &str) -> Result<()> {
    let job = store.load(id)?;
    let wf = get_workflow(config, &job)?;
    let engine = WorkflowEngine::new(wf, store);

    engine.abort_job(id)?;
    println!("ジョブを中断しました: {id}");
    Ok(())
}

fn cmd_close(store: &JobStore, config: &SquadConfig, iteration_store: &IterationStore, id: &str) -> Result<()> {
    let job = store.load(id)?;
    let wf = get_workflow(config, &job)?;
    let engine = WorkflowEngine::new(wf, store);

    engine.close_job(id)?;
    iteration_store.remove(id)?;
    println!("ジョブをクローズしました: {id}");
    Ok(())
}

fn cmd_activate(squad_dir: &Path, id: &str) -> Result<()> {
    let current_jobs = CurrentJobsStore::new(squad_dir);
    current_jobs.add(id)?;
    println!("ジョブをアクティブに登録しました: {id}");
    Ok(())
}

fn cmd_deactivate(squad_dir: &Path, id: &str) -> Result<()> {
    let current_jobs = CurrentJobsStore::new(squad_dir);
    current_jobs.remove(id)?;
    println!("ジョブのアクティブ登録を解除しました: {id}");
    Ok(())
}

// --- helpers ---

fn get_workflow<'a>(
    config: &'a SquadConfig,
    job: &Job,
) -> Result<&'a ccsquad_jobs::config::WorkflowConfig> {
    config
        .get_workflow(&job.frontmatter.workflow)
        .ok_or_else(|| {
            ccsquad_core::Error::Config(format!(
                "ワークフロー '{}' が ccsquad.yaml に定義されていません",
                job.frontmatter.workflow
            ))
        })
}

fn print_transition_result(job: &Job) {
    let fm = &job.frontmatter;
    match fm.status {
        JobStatus::Completed => {
            println!("ジョブが完了しました: {}", fm.id);
        }
        JobStatus::Failed => {
            println!("ジョブが失敗しました: {}", fm.id);
        }
        JobStatus::Running => {
            let phase = fm.current_phase.as_deref().unwrap_or("?");
            println!(
                "フェーズを遷移しました: {} → {phase}",
                fm.id
            );
        }
        JobStatus::Closed => {
            println!("ジョブがクローズされました: {}", fm.id);
        }
        _ => {}
    }
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_len - 2).collect();
        format!("{truncated}..")
    }
}

#[derive(Serialize)]
struct PhaseInfo {
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reviewer: Option<String>,
}

fn get_phase_info(config: &SquadConfig, job: &Job) -> Option<PhaseInfo> {
    let phase_name = job.frontmatter.current_phase.as_deref()?;
    let wf = config.get_workflow(&job.frontmatter.workflow)?;
    let phase = wf.phases.get(phase_name)?;
    Some(PhaseInfo {
        description: phase.description.clone(),
        agent: phase.agent.clone(),
        reviewer: phase.reviewer.clone(),
    })
}

#[derive(Serialize)]
struct JobShowJson<'a> {
    id: &'a str,
    title: &'a str,
    workflow: &'a str,
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_phase: Option<&'a str>,
    priority: i32,
    depends_on: &'a [String],
    created_at: &'a str,
    updated_at: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase_config: Option<&'a PhaseInfo>,
    body: &'a str,
}

#[derive(Debug, Serialize)]
pub struct NextActionOutput {
    pub action: String,
    pub job_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn cmd_next_action(
    store: &JobStore,
    config: &SquadConfig,
    iteration_store: &IterationStore,
    id: &str,
    result: &str,
    message: &str,
    reset_iteration: bool,
) -> Result<()> {
    if reset_iteration {
        iteration_store.reset(id)?;
    }

    let job = store.load(id)?;
    let wf = get_workflow(config, &job)?;
    let phase_name = job
        .frontmatter
        .current_phase
        .as_deref()
        .ok_or_else(|| ccsquad_core::Error::Workflow("現在のフェーズが設定されていません".to_string()))?;
    let phase_config = wf.phases.get(phase_name).ok_or_else(|| {
        ccsquad_core::Error::Workflow(format!(
            "フェーズ '{phase_name}' がワークフローに定義されていません"
        ))
    })?;

    // result をパースして遷移先を解決
    let condition: TransitionCondition = result.parse()?;

    // reviewer フェーズのバリデーション
    if phase_config.reviewer.is_some() {
        if condition != TransitionCondition::Approved && condition != TransitionCondition::Rejected {
            return Err(ccsquad_core::Error::Workflow(
                "レビューフェーズでは approved/rejected を使用してください".to_string(),
            ));
        }
    } else if condition == TransitionCondition::Approved || condition == TransitionCondition::Rejected {
        return Err(ccsquad_core::Error::Workflow(
            "通常フェーズでは completed/failed を使用してください".to_string(),
        ));
    }

    let next = wf.resolve_transition(phase_name, &condition)?;

    let output = match next.as_str() {
        "COMPLETE" | "ABORT" => {
            // 終了: 遷移を実行
            let engine = WorkflowEngine::new(wf, store);
            if phase_config.reviewer.is_some() {
                if condition == TransitionCondition::Approved {
                    engine.approve(id, message)?;
                } else {
                    engine.reject(id, message)?;
                }
            } else {
                engine.transition(id, condition, message)?;
            }
            let job = store.load(id)?;
            iteration_store.remove(id)?;
            NextActionOutput {
                action: "done".to_string(),
                job_id: id.to_string(),
                status: Some(job.frontmatter.status.to_string()),
                phase: None,
                phase_description: None,
                agent: None,
                reviewer: None,
                reason: None,
            }
        }
        _ => {
            let next_phase = wf.phases.get(&next).ok_or_else(|| {
                ccsquad_core::Error::Workflow(format!(
                    "遷移先フェーズ '{next}' がワークフローに定義されていません"
                ))
            })?;

            // pause チェック
            if next_phase.pause {
                // 遷移しない。フェーズログだけ記録
                let mut job = store.load(id)?;
                job.append_phase_log(phase_name, &condition.to_string(), &next, message);
                job.frontmatter.updated_at = Utc::now();
                store.save(&job)?;
                NextActionOutput {
                    action: "pause".to_string(),
                    job_id: id.to_string(),
                    status: None,
                    phase: Some(next.clone()),
                    phase_description: next_phase.description.clone(),
                    agent: next_phase.agent.clone(),
                    reviewer: next_phase.reviewer.clone(),
                    reason: Some("pause".to_string()),
                }
            } else {
                // iteration チェック
                let current_iteration = iteration_store.get(id)?;
                if current_iteration >= wf.max_iterations() {
                    // 遷移しない。フェーズログだけ記録
                    let mut job = store.load(id)?;
                    job.append_phase_log(phase_name, &condition.to_string(), &next, message);
                    job.frontmatter.updated_at = Utc::now();
                    store.save(&job)?;
                    NextActionOutput {
                        action: "pause".to_string(),
                        job_id: id.to_string(),
                        status: None,
                        phase: Some(next.clone()),
                        phase_description: next_phase.description.clone(),
                        agent: next_phase.agent.clone(),
                        reviewer: next_phase.reviewer.clone(),
                        reason: Some("max_iterations".to_string()),
                    }
                } else {
                    // 遷移実行
                    let engine = WorkflowEngine::new(wf, store);
                    if phase_config.reviewer.is_some() {
                        if condition == TransitionCondition::Approved {
                            engine.approve(id, message)?;
                        } else {
                            engine.reject(id, message)?;
                        }
                    } else {
                        engine.transition(id, condition, message)?;
                    }
                    iteration_store.increment(id)?;
                    NextActionOutput {
                        action: "continue".to_string(),
                        job_id: id.to_string(),
                        status: None,
                        phase: Some(next.clone()),
                        phase_description: next_phase.description.clone(),
                        agent: next_phase.agent.clone(),
                        reviewer: next_phase.reviewer.clone(),
                        reason: None,
                    }
                }
            }
        }
    };

    let json = serde_json::to_string_pretty(&output)
        .map_err(|e| ccsquad_core::Error::Serialization(e.to_string()))?;
    println!("{json}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_activate_adds_to_store() {
        let tmp = tempfile::tempdir().unwrap();
        cmd_activate(tmp.path(), "J000001").unwrap();
        let store = CurrentJobsStore::new(tmp.path());
        assert!(store.contains("J000001").unwrap());
    }

    #[test]
    fn test_activate_duplicate_is_ok() {
        let tmp = tempfile::tempdir().unwrap();
        cmd_activate(tmp.path(), "J000001").unwrap();
        cmd_activate(tmp.path(), "J000001").unwrap();
        let store = CurrentJobsStore::new(tmp.path());
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn test_deactivate_removes_from_store() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CurrentJobsStore::new(tmp.path());
        store.add("J000001").unwrap();
        cmd_deactivate(tmp.path(), "J000001").unwrap();
        assert!(!store.contains("J000001").unwrap());
    }

    #[test]
    fn test_deactivate_nonexistent_is_ok() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(cmd_deactivate(tmp.path(), "J999999").is_ok());
    }
}
