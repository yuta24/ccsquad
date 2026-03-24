use std::io::Read;
use std::path::Path;

use clap::Subcommand;
use serde::Deserialize;

use ccsquad_core::Result;
use ccsquad_jobs::config::SquadConfig;
use ccsquad_jobs::current_jobs::CurrentJobsStore;
use ccsquad_jobs::iteration::IterationStore;
use ccsquad_jobs::job::JobStore;

#[derive(Subcommand)]
pub enum HookAction {
    /// SubagentStop hook: サブエージェント完了時の処理
    OnAgentComplete,
}

#[derive(Deserialize)]
struct SubagentStopInput {
    #[serde(default)]
    last_assistant_message: Option<String>,
}

#[derive(Deserialize)]
struct AgentResult {
    job_id: String,
    result: String,
    #[serde(default)]
    message: String,
}

pub fn run(action: HookAction, config: &SquadConfig, jobs_dir: &Path, squad_dir: &Path) -> Result<()> {
    match action {
        HookAction::OnAgentComplete => cmd_on_agent_complete(config, jobs_dir, squad_dir),
    }
}

fn cmd_on_agent_complete(config: &SquadConfig, jobs_dir: &Path, squad_dir: &Path) -> Result<()> {
    let current_jobs = CurrentJobsStore::new(squad_dir);

    // アクティブジョブが存在しなければ何もしない
    if current_jobs.list()?.is_empty() {
        return Ok(());
    }

    // stdin から SubagentStop の JSON を読み取る
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;

    let hook_input: SubagentStopInput = serde_json::from_str(&input)
        .unwrap_or(SubagentStopInput { last_assistant_message: None });

    let last_msg = match hook_input.last_assistant_message {
        Some(msg) if !msg.is_empty() => msg,
        _ => {
            println!("[CCSQUAD] エージェント出力を取得できませんでした。");
            println!("手動で ccsquad job transition <ID> <result> --message '<msg>' を実行してください。");
            return Ok(());
        }
    };

    // last_assistant_message から結果 JSON 行を抽出（job_id を含む）
    let agent_result = extract_result(&last_msg);
    let (job_id, result, message) = match agent_result {
        Some(r) => (r.job_id, r.result, r.message),
        None => {
            println!("[CCSQUAD] エージェント出力から結果を取得できませんでした。");
            println!("手動で ccsquad job transition <ID> <result> --message '<msg>' を実行してください。");
            return Ok(());
        }
    };

    // アクティブジョブに含まれているか検証
    if !current_jobs.contains(&job_id)? {
        println!("[CCSQUAD] ジョブ {job_id} はアクティブジョブに登録されていません。スキップします。");
        return Ok(());
    }

    // next-action の内部ロジックを直接呼び出す
    let store = JobStore::new(jobs_dir.to_path_buf());
    let iteration_store = IterationStore::new(squad_dir);

    let job = store.load(&job_id)?;
    let wf = config
        .get_workflow(&job.frontmatter.workflow)
        .ok_or_else(|| {
            ccsquad_core::Error::Config(format!(
                "ワークフロー '{}' が ccsquad.yaml に定義されていません",
                job.frontmatter.workflow
            ))
        })?;

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

    // 遷移先を解決
    let condition: ccsquad_jobs::config::TransitionCondition = result.parse()?;
    let next = wf.resolve_transition(phase_name, &condition)?;

    match next.as_str() {
        "COMPLETE" | "ABORT" => {
            // 遷移実行
            let engine = ccsquad_jobs::engine::WorkflowEngine::new(wf, &store);
            if phase_config.reviewer.is_some() {
                if condition == ccsquad_jobs::config::TransitionCondition::Approved {
                    engine.approve(&job_id, &message)?;
                } else {
                    engine.reject(&job_id, &message)?;
                }
            } else {
                engine.transition(&job_id, condition, &message)?;
            }
            let job = store.load(&job_id)?;
            iteration_store.remove(&job_id)?;
            current_jobs.remove(&job_id)?;
            println!("[CCSQUAD] ジョブ {job_id} が{}しました。", job.frontmatter.status);
        }
        _ => {
            let next_phase = wf.phases.get(&next).ok_or_else(|| {
                ccsquad_core::Error::Workflow(format!(
                    "遷移先フェーズ '{next}' がワークフローに定義されていません"
                ))
            })?;

            if next_phase.pause {
                // 遷移しない。フェーズログだけ記録
                let mut job = store.load(&job_id)?;
                job.append_phase_log(phase_name, &condition.to_string(), &next, &message);
                job.frontmatter.updated_at = chrono::Utc::now();
                store.save(&job)?;
                current_jobs.remove(&job_id)?;
                let desc = next_phase.description.as_deref().unwrap_or("");
                println!("[CCSQUAD] フェーズ遷移完了。一時停止しました。");
                println!("ジョブ ID: {job_id} | 次フェーズ: {next} | 説明: {desc}");
                println!("確認後 /job-approve {job_id} で続行、/job-reject {job_id} で却下できます。");
            } else {
                let current_iteration = iteration_store.get(&job_id)?;
                if current_iteration >= wf.max_iterations() {
                    // 遷移しない。フェーズログだけ記録
                    let mut job = store.load(&job_id)?;
                    job.append_phase_log(phase_name, &condition.to_string(), &next, &message);
                    job.frontmatter.updated_at = chrono::Utc::now();
                    store.save(&job)?;
                    current_jobs.remove(&job_id)?;
                    println!("[CCSQUAD] フェーズ遷移完了。イテレーション上限に達しました。");
                    println!("ジョブ ID: {job_id} | 次フェーズ: {next}");
                    println!("確認後 /job-approve {job_id} で続行できます。");
                } else {
                    // 遷移実行（アクティブ登録は維持）
                    let engine = ccsquad_jobs::engine::WorkflowEngine::new(wf, &store);
                    if phase_config.reviewer.is_some() {
                        if condition == ccsquad_jobs::config::TransitionCondition::Approved {
                            engine.approve(&job_id, &message)?;
                        } else {
                            engine.reject(&job_id, &message)?;
                        }
                    } else {
                        engine.transition(&job_id, condition, &message)?;
                    }
                    iteration_store.increment(&job_id)?;
                    let agent = next_phase.agent.as_deref().unwrap_or("unknown");
                    let desc = next_phase.description.as_deref().unwrap_or("");
                    println!("[CCSQUAD] フェーズ遷移完了。次のフェーズを自動実行します。");
                    println!("Agent ツールで subagent_type=\"{agent}\" のサブエージェントを起動してください。");
                    println!("ジョブ ID: {job_id} | フェーズ: {next} | 説明: {desc}");
                    println!("プロンプトは ccsquad job show {job_id} --format json で取得し、job-run スキルと同じ形式で注入してください。");
                }
            }
        }
    }

    Ok(())
}

/// last_assistant_message から {"job_id": "...", "result": "...", "message": "..."} 形式の JSON 行を抽出
fn extract_result(message: &str) -> Option<AgentResult> {
    // 末尾から探す（最後の JSON 行を優先）
    for line in message.lines().rev() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') && trimmed.contains("\"result\"") {
            if let Ok(result) = serde_json::from_str::<AgentResult>(trimmed) {
                return Some(result);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_result_completed() {
        let msg = r#"実装が完了しました。テストも通過しています。
{"job_id": "J000001", "result": "completed", "message": "認証機能を実装しました"}"#;
        let result = extract_result(msg).unwrap();
        assert_eq!(result.job_id, "J000001");
        assert_eq!(result.result, "completed");
        assert_eq!(result.message, "認証機能を実装しました");
    }

    #[test]
    fn test_extract_result_approved() {
        let msg = r#"コードレビューを完了しました。問題ありません。
{"job_id": "J000002", "result": "approved", "message": "LGTM"}"#;
        let result = extract_result(msg).unwrap();
        assert_eq!(result.job_id, "J000002");
        assert_eq!(result.result, "approved");
        assert_eq!(result.message, "LGTM");
    }

    #[test]
    fn test_extract_result_rejected() {
        let msg = r#"いくつかの問題が見つかりました。
{"job_id": "J000001", "result": "rejected", "message": "テストカバレッジが不足しています"}"#;
        let result = extract_result(msg).unwrap();
        assert_eq!(result.job_id, "J000001");
        assert_eq!(result.result, "rejected");
    }

    #[test]
    fn test_extract_result_no_json() {
        let msg = "テキストのみのメッセージです。";
        assert!(extract_result(msg).is_none());
    }

    #[test]
    fn test_extract_result_last_json_wins() {
        let msg = r#"途中経過:
{"job_id": "J000001", "result": "failed", "message": "ビルドエラー"}
修正しました:
{"job_id": "J000001", "result": "completed", "message": "修正完了"}"#;
        let result = extract_result(msg).unwrap();
        assert_eq!(result.result, "completed");
    }

    #[test]
    fn test_extract_result_missing_job_id_returns_none() {
        let msg = r#"旧フォーマット:
{"result": "completed", "message": "完了しました"}"#;
        assert!(extract_result(msg).is_none());
    }
}
