use std::io::Read;
use std::path::{Path, PathBuf};

use chrono::Utc;
use clap::Subcommand;
use serde::Serialize;

use ccsquad_core::{Error, Result};
use ccsquad_memory::entry::{EntryStore, MemoryEntry, MemoryFrontmatter};

#[derive(Clone, clap::ValueEnum)]
pub enum OutputFormat {
    Text,
    Json,
}

#[derive(Subcommand)]
pub enum MemoryAction {
    /// メモリエントリを追加
    Add {
        title: String,
        body: Option<String>,
        #[arg(long = "type", value_name = "TYPE")]
        entry_type: Option<String>,
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// メモリエントリ一覧を表示
    List {
        #[arg(long = "type", value_name = "TYPE")]
        entry_type: Option<String>,
        #[arg(long, value_enum, default_value = "text")]
        format: OutputFormat,
    },
    /// メモリエントリ詳細を表示
    Show {
        key: String,
        #[arg(long, value_enum, default_value = "text")]
        format: OutputFormat,
    },
    /// メモリエントリを編集
    Edit {
        key: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long = "type", value_name = "TYPE")]
        entry_type: Option<String>,
        #[arg(long)]
        no_type: bool,
        body: Option<String>,
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// メモリエントリを削除
    Delete {
        key: String,
    },
    /// メモリエントリを検索
    Search {
        query: String,
        #[arg(long = "type", value_name = "TYPE")]
        entry_type: Option<String>,
        #[arg(long, value_enum, default_value = "text")]
        format: OutputFormat,
    },
}

pub fn run(action: MemoryAction, memory_dir: &Path) -> Result<()> {
    let store = EntryStore::new(memory_dir.to_path_buf());
    store.ensure_dir()?;

    match action {
        MemoryAction::Add {
            title,
            body,
            entry_type,
            file,
        } => cmd_add(&store, &title, entry_type.as_deref(), body.as_deref(), file.as_deref()),
        MemoryAction::List {
            entry_type,
            format,
        } => cmd_list(&store, entry_type.as_deref(), &format),
        MemoryAction::Show { key, format } => cmd_show(&store, &key, &format),
        MemoryAction::Edit {
            key,
            title,
            entry_type,
            no_type,
            body,
            file,
        } => cmd_edit(
            &store,
            &key,
            title.as_deref(),
            entry_type.as_deref(),
            no_type,
            body.as_deref(),
            file.as_deref(),
        ),
        MemoryAction::Delete { key } => cmd_delete(&store, &key),
        MemoryAction::Search {
            query,
            entry_type,
            format,
        } => cmd_search(&store, &query, entry_type.as_deref(), &format),
    }
}

/// body を位置引数、--file、stdin の優先順位で解決する。
fn resolve_body(body_arg: Option<&str>, file: Option<&Path>) -> Result<Option<String>> {
    // --file が最優先
    if let Some(path) = file {
        let content = std::fs::read_to_string(path).map_err(|e| {
            Error::Memory(format!("ファイル読み込みエラー: {}: {e}", path.display()))
        })?;
        return Ok(Some(content));
    }
    // 位置引数
    if let Some(body) = body_arg {
        return Ok(Some(body.to_string()));
    }
    // stdin（TTY でなければ読む）
    if !atty_is_stdin() {
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| Error::Memory(format!("stdin 読み込みエラー: {e}")))?;
        if !buf.is_empty() {
            return Ok(Some(buf));
        }
    }
    Ok(None)
}

fn atty_is_stdin() -> bool {
    use std::io::IsTerminal;
    std::io::stdin().is_terminal()
}

fn cmd_add(
    store: &EntryStore,
    title: &str,
    entry_type: Option<&str>,
    body_arg: Option<&str>,
    file: Option<&Path>,
) -> Result<()> {
    let body = resolve_body(body_arg, file)?.unwrap_or_default();
    let now = Utc::now();

    let entry = MemoryEntry {
        title: title.to_string(),
        frontmatter: MemoryFrontmatter {
            entry_type: entry_type.map(|s| s.to_string()),
            created_at: now,
            updated_at: now,
        },
        body,
    };

    store.save(&entry)?;
    println!("メモリエントリを作成しました: {}", entry.key());
    Ok(())
}

fn cmd_list(store: &EntryStore, entry_type: Option<&str>, format: &OutputFormat) -> Result<()> {
    let mut entries = store.list_all()?;

    if let Some(t) = entry_type {
        entries.retain(|e| e.frontmatter.entry_type.as_deref() == Some(t));
    }

    match format {
        OutputFormat::Json => {
            let output: Vec<MemoryShowJson> = entries.iter().map(|e| entry_to_json(e)).collect();
            let json = serde_json::to_string_pretty(&output)
                .map_err(|e| Error::Serialization(e.to_string()))?;
            println!("{json}");
        }
        OutputFormat::Text => {
            if entries.is_empty() {
                println!("メモリエントリはありません。");
                return Ok(());
            }
            println!(
                "{:<16} {:<30} {:<20} {:<20}",
                "タイプ", "タイトル", "作成日時", "更新日時"
            );
            println!("{}", "-".repeat(88));
            for entry in &entries {
                let fm = &entry.frontmatter;
                println!(
                    "{:<16} {:<30} {:<20} {:<20}",
                    fm.entry_type.as_deref().unwrap_or("-"),
                    truncate(&entry.title, 28),
                    fm.created_at.format("%Y-%m-%d %H:%M"),
                    fm.updated_at.format("%Y-%m-%d %H:%M"),
                );
            }
        }
    }
    Ok(())
}

fn cmd_show(store: &EntryStore, key: &str, format: &OutputFormat) -> Result<()> {
    let entry = store.load(key)?;

    match format {
        OutputFormat::Json => {
            let output = entry_to_json(&entry);
            let json = serde_json::to_string_pretty(&output)
                .map_err(|e| Error::Serialization(e.to_string()))?;
            println!("{json}");
        }
        OutputFormat::Text => {
            println!("タイトル: {}", entry.title);
            if let Some(t) = &entry.frontmatter.entry_type {
                println!("タイプ: {t}");
            }
            println!("キー: {}", entry.key());
            println!("作成日時: {}", entry.frontmatter.created_at);
            println!("更新日時: {}", entry.frontmatter.updated_at);
            if !entry.body.is_empty() {
                println!();
                print!("{}", entry.body);
            }
        }
    }
    Ok(())
}

fn cmd_edit(
    store: &EntryStore,
    key: &str,
    new_title: Option<&str>,
    new_type: Option<&str>,
    no_type: bool,
    body_arg: Option<&str>,
    file: Option<&Path>,
) -> Result<()> {
    let old_entry = store.load(key)?;

    let title = new_title
        .map(|s| s.to_string())
        .unwrap_or(old_entry.title.clone());

    let entry_type = if no_type {
        None
    } else if let Some(t) = new_type {
        Some(t.to_string())
    } else {
        old_entry.frontmatter.entry_type.clone()
    };

    let body = resolve_body(body_arg, file)?.unwrap_or(old_entry.body.clone());

    let new_entry = MemoryEntry {
        title: title.clone(),
        frontmatter: MemoryFrontmatter {
            entry_type,
            created_at: old_entry.frontmatter.created_at,
            updated_at: Utc::now(),
        },
        body,
    };

    let old_key = old_entry.key();
    let new_key = new_entry.key();

    if old_key != new_key {
        // キーが変わった場合: 新しい場所にファイルが存在しないことを確認
        // save は重複チェックするのでそのまま使える
        store.save(&new_entry)?;
        store.delete(&old_key)?;
    } else {
        store.overwrite(&new_entry)?;
    }

    println!("メモリエントリを更新しました: {new_key}");
    Ok(())
}

fn cmd_delete(store: &EntryStore, key: &str) -> Result<()> {
    store.delete(key)?;
    println!("メモリエントリを削除しました: {key}");
    Ok(())
}

fn cmd_search(
    store: &EntryStore,
    query: &str,
    entry_type: Option<&str>,
    format: &OutputFormat,
) -> Result<()> {
    let results = store.search(query, entry_type)?;

    match format {
        OutputFormat::Json => {
            let output: Vec<MemoryShowJson> = results.iter().map(|e| entry_to_json(e)).collect();
            let json = serde_json::to_string_pretty(&output)
                .map_err(|e| Error::Serialization(e.to_string()))?;
            println!("{json}");
        }
        OutputFormat::Text => {
            if results.is_empty() {
                println!("該当するエントリはありません。");
                return Ok(());
            }
            println!(
                "{:<16} {:<30} {:<20} {:<20}",
                "タイプ", "タイトル", "作成日時", "更新日時"
            );
            println!("{}", "-".repeat(88));
            for entry in &results {
                let fm = &entry.frontmatter;
                println!(
                    "{:<16} {:<30} {:<20} {:<20}",
                    fm.entry_type.as_deref().unwrap_or("-"),
                    truncate(&entry.title, 28),
                    fm.created_at.format("%Y-%m-%d %H:%M"),
                    fm.updated_at.format("%Y-%m-%d %H:%M"),
                );
            }
        }
    }
    Ok(())
}

// --- helpers ---

fn truncate(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_len - 2).collect();
        format!("{truncated}..")
    }
}

#[derive(Serialize)]
struct MemoryShowJson {
    key: String,
    title: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    entry_type: Option<String>,
    body: String,
    created_at: String,
    updated_at: String,
}

fn entry_to_json(entry: &MemoryEntry) -> MemoryShowJson {
    MemoryShowJson {
        key: entry.key(),
        title: entry.title.clone(),
        entry_type: entry.frontmatter.entry_type.clone(),
        body: entry.body.clone(),
        created_at: entry.frontmatter.created_at.to_rfc3339(),
        updated_at: entry.frontmatter.updated_at.to_rfc3339(),
    }
}
