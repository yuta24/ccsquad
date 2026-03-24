use std::path::PathBuf;

use clap::{Parser, Subcommand};

mod cmd_hook;
mod cmd_job;
mod cmd_memory;

#[derive(Parser)]
#[command(name = "ccsquad", about = "ジョブ管理 + ワークフローエンジン + メモリ管理 CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// ジョブ管理
    Job {
        #[command(subcommand)]
        action: cmd_job::JobAction,
    },
    /// メモリ管理
    Memory {
        #[command(subcommand)]
        action: cmd_memory::MemoryAction,
    },
    /// フック処理
    Hook {
        #[command(subcommand)]
        action: cmd_hook::HookAction,
    },
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    if let Err(e) = run() {
        eprintln!("エラー: {e}");
        std::process::exit(1);
    }
}

fn run() -> ccsquad_core::Result<()> {
    let cli = Cli::parse();

    let config_path = find_config()?;
    let config = ccsquad_jobs::config::SquadConfig::load(&config_path)?;
    let project_root = config_path.parent().unwrap();
    let squad_dir = project_root.join(".ccsquad");
    let jobs_dir = squad_dir.join("jobs");
    let memory_dir = squad_dir.join("memory").join("entries");
    std::fs::create_dir_all(&jobs_dir)?;
    std::fs::create_dir_all(&memory_dir)?;

    match cli.command {
        Commands::Job { action } => cmd_job::run(action, &config, &jobs_dir, &squad_dir)?,
        Commands::Memory { action } => cmd_memory::run(action, &memory_dir)?,
        Commands::Hook { action } => cmd_hook::run(action, &config, &jobs_dir, &squad_dir)?,
    }

    Ok(())
}

fn find_config() -> ccsquad_core::Result<PathBuf> {
    let mut dir = std::env::current_dir()?;
    loop {
        let candidate = dir.join("ccsquad.yaml");
        if candidate.exists() {
            return Ok(candidate);
        }
        if !dir.pop() {
            return Err(ccsquad_core::Error::Config(
                "ccsquad.yaml が見つかりません".to_string(),
            ));
        }
    }
}
