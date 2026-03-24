use std::path::Path;

use clap::Args;
use serde_json::Value;

use crate::embedded;

#[derive(Args)]
pub struct SetupArgs {
    /// 既存ファイルを上書き
    #[arg(long)]
    pub force: bool,

    /// スキルのインストールをスキップ
    #[arg(long)]
    pub skip_skills: bool,

    /// フックの設定をスキップ
    #[arg(long)]
    pub skip_hooks: bool,

    /// エージェント定義のコピーをスキップ
    #[arg(long)]
    pub skip_agents: bool,

    /// ccsquad.yaml の作成をスキップ
    #[arg(long)]
    pub skip_config: bool,
}

pub fn run(args: SetupArgs) -> ccsquad_core::Result<()> {
    println!("ccsquad setup を実行中...");

    let project_root = std::env::current_dir()?;

    if !args.skip_config {
        setup_config(&project_root, args.force)?;
    }

    if !args.skip_skills {
        setup_skills(&project_root, args.force)?;
    }

    if !args.skip_agents {
        setup_agents(&project_root, args.force)?;
    }

    if !args.skip_hooks {
        setup_hooks(&project_root)?;
    }

    println!("セットアップが完了しました。");

    Ok(())
}

fn setup_config(project_root: &Path, force: bool) -> ccsquad_core::Result<()> {
    let config_path = project_root.join("ccsquad.yaml");

    if config_path.exists() && !force {
        println!("  設定ファイル: ccsquad.yaml (既に存在、スキップ)");
        return Ok(());
    }

    std::fs::write(&config_path, embedded::DEFAULT_CONFIG)?;
    println!("  設定ファイル: ccsquad.yaml を作成しました");

    Ok(())
}

fn setup_skills(project_root: &Path, force: bool) -> ccsquad_core::Result<()> {
    let skills = [
        ("job", embedded::SKILL_JOB),
        ("job-run", embedded::SKILL_JOB_RUN),
        ("job-approve", embedded::SKILL_JOB_APPROVE),
        ("job-reject", embedded::SKILL_JOB_REJECT),
        ("memory", embedded::SKILL_MEMORY),
    ];

    for (name, content) in &skills {
        let skill_dir = project_root.join(".claude").join("skills").join(name);
        let skill_path = skill_dir.join("SKILL.md");

        if skill_path.exists() && !force {
            println!("  スキル: {name} (既に存在、スキップ)");
            continue;
        }

        std::fs::create_dir_all(&skill_dir)?;
        std::fs::write(&skill_path, content)?;
        println!("  スキル: {name} を作成しました");
    }

    Ok(())
}

fn setup_agents(project_root: &Path, force: bool) -> ccsquad_core::Result<()> {
    let agents = [
        ("coder", embedded::AGENT_CODER),
        ("reviewer", embedded::AGENT_REVIEWER),
    ];

    let agents_dir = project_root.join(".claude").join("agents");
    std::fs::create_dir_all(&agents_dir)?;

    for (name, content) in &agents {
        let agent_path = agents_dir.join(format!("{name}.md"));

        if agent_path.exists() && !force {
            println!("  エージェント: {name} (既に存在、スキップ)");
            continue;
        }

        std::fs::write(&agent_path, content)?;
        println!("  エージェント: {name} を作成しました");
    }

    Ok(())
}

fn setup_hooks(project_root: &Path) -> ccsquad_core::Result<()> {
    let settings_path = project_root.join(".claude").join("settings.local.json");

    let mut json: Value = if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path)?;
        serde_json::from_str(&content).unwrap_or(Value::Object(serde_json::Map::new()))
    } else {
        Value::Object(serde_json::Map::new())
    };

    // hooks.SubagentStop 配列内に既存のエントリがあるか確認
    let hook_command = "ccsquad hook on-agent-complete";
    let already_set = json
        .get("hooks")
        .and_then(|h| h.get("SubagentStop"))
        .and_then(|s| s.as_array())
        .map(|entries| {
            entries.iter().any(|entry| {
                entry
                    .get("hooks")
                    .and_then(|hooks| hooks.as_array())
                    .map(|hooks| {
                        hooks.iter().any(|h| {
                            h.get("command")
                                .and_then(|c| c.as_str())
                                .map(|c| c.contains(hook_command))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);

    if already_set {
        println!("  フック: SubagentStop フック (既に存在、スキップ)");
        return Ok(());
    }

    let hook_entry = serde_json::json!({
        "matcher": "coder|reviewer",
        "hooks": [{
            "type": "command",
            "command": hook_command,
            "timeout": 30000
        }]
    });

    let hooks = json
        .as_object_mut()
        .ok_or_else(|| ccsquad_core::Error::Config("settings.local.json が不正です".to_string()))?
        .entry("hooks")
        .or_insert(Value::Object(serde_json::Map::new()));

    let subagent_stop = hooks
        .as_object_mut()
        .ok_or_else(|| ccsquad_core::Error::Config("hooks が不正です".to_string()))?
        .entry("SubagentStop")
        .or_insert(Value::Array(Vec::new()));

    if let Some(arr) = subagent_stop.as_array_mut() {
        arr.push(hook_entry);
    }

    let claude_dir = project_root.join(".claude");
    std::fs::create_dir_all(&claude_dir)?;

    let mut output = serde_json::to_string_pretty(&json)
        .map_err(|e| ccsquad_core::Error::Config(e.to_string()))?;
    output.push('\n');

    std::fs::write(&settings_path, output)?;
    println!("  フック: SubagentStop フックを追加しました");

    Ok(())
}
