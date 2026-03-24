use std::path::Path;

use chrono::Utc;
use clap::Subcommand;
use serde::Serialize;

use ccsquad_core::Result;
use ccsquad_jobs::config::{SquadConfig, TransitionCondition};
use ccsquad_jobs::engine::{WorkflowEngine, check_circular_dependency};
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
}

pub fn run(action: JobAction, config: &SquadConfig, jobs_dir: &Path) -> Result<()> {
    let store = JobStore::new(jobs_dir.to_path_buf());

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
