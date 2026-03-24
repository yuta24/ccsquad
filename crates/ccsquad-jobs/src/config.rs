use std::collections::HashSet;
use std::path::Path;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use ccsquad_core::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SquadConfig {
    pub workflows: IndexMap<String, WorkflowConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowConfig {
    #[serde(default)]
    pub description: Option<String>,
    pub phases: IndexMap<String, PhaseConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhaseConfig {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub reviewer: Option<String>,
    #[serde(default)]
    pub on: IndexMap<TransitionCondition, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitionCondition {
    Completed,
    Failed,
    Rejected,
    Approved,
}

impl std::fmt::Display for TransitionCondition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Completed => write!(f, "completed"),
            Self::Failed => write!(f, "failed"),
            Self::Rejected => write!(f, "rejected"),
            Self::Approved => write!(f, "approved"),
        }
    }
}

impl std::str::FromStr for TransitionCondition {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self> {
        match s {
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "rejected" => Ok(Self::Rejected),
            "approved" => Ok(Self::Approved),
            _ => Err(Error::Workflow(format!("不明な遷移条件です: {s}"))),
        }
    }
}

impl SquadConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let config: Self =
            serde_yaml::from_str(&content).map_err(|e| Error::Serialization(e.to_string()))?;
        Ok(config)
    }

    pub fn get_workflow(&self, name: &str) -> Option<&WorkflowConfig> {
        self.workflows.get(name)
    }

    /// すべてのワークフローをバリデーションする。警告メッセージのリストを返す。
    pub fn validate(&self) -> Result<Vec<String>> {
        let mut warnings = Vec::new();
        for (name, workflow) in &self.workflows {
            let w = workflow.validate(name)?;
            warnings.extend(w);
        }
        Ok(warnings)
    }
}

impl WorkflowConfig {
    /// 開始フェーズ名を返す（phases の最初のキー）。
    pub fn initial_phase(&self) -> Result<&str> {
        self.phases
            .keys()
            .next()
            .map(|s| s.as_str())
            .ok_or_else(|| Error::Config("ワークフローにフェーズが定義されていません".to_string()))
    }

    /// 遷移先を解決する。on に定義がなければエラー。
    pub fn resolve_transition(
        &self,
        phase_name: &str,
        condition: &TransitionCondition,
    ) -> Result<String> {
        let phase = self.phases.get(phase_name).ok_or_else(|| {
            Error::Workflow(format!(
                "フェーズ '{phase_name}' がワークフローに定義されていません"
            ))
        })?;

        phase.on.get(condition).cloned().ok_or_else(|| {
            Error::Workflow(format!(
                "フェーズ '{phase_name}' に条件 '{condition}' に一致するルールがありません"
            ))
        })
    }

    /// ワークフローをバリデーションする。警告メッセージのリストを返す。
    pub fn validate(&self, name: &str) -> Result<Vec<String>> {
        let mut warnings = Vec::new();

        if self.phases.is_empty() {
            return Err(Error::Config(format!(
                "ワークフロー '{name}': フェーズが定義されていません"
            )));
        }

        for (phase_name, phase) in &self.phases {
            // 遷移先の存在チェック
            for (_, next) in &phase.on {
                if next != "COMPLETE" && next != "ABORT" && !self.phases.contains_key(next) {
                    return Err(Error::Config(format!(
                        "ワークフロー '{name}': フェーズ '{phase_name}' の遷移先 '{next}' が存在しません"
                    )));
                }
            }

            if phase.reviewer.is_some() {
                // reviewer フェーズ: approved と rejected が必須
                if !phase.on.contains_key(&TransitionCondition::Approved) {
                    return Err(Error::Config(format!(
                        "ワークフロー '{name}': レビューフェーズ '{phase_name}' に 'approved' ルールがありません"
                    )));
                }
                if !phase.on.contains_key(&TransitionCondition::Rejected) {
                    return Err(Error::Config(format!(
                        "ワークフロー '{name}': レビューフェーズ '{phase_name}' に 'rejected' ルールがありません"
                    )));
                }
            } else {
                // 通常フェーズ: completed が必須
                if !phase.on.contains_key(&TransitionCondition::Completed) {
                    return Err(Error::Config(format!(
                        "ワークフロー '{name}': フェーズ '{phase_name}' に 'completed' ルールがありません"
                    )));
                }
            }
        }

        // 到達不能フェーズの検出
        let initial = self.initial_phase()?;
        let mut reachable = HashSet::new();
        let mut stack = vec![initial];
        while let Some(phase) = stack.pop() {
            if !reachable.insert(phase) {
                continue;
            }
            if let Some(config) = self.phases.get(phase) {
                for next in config.on.values() {
                    if next != "COMPLETE" && next != "ABORT" {
                        stack.push(next.as_str());
                    }
                }
            }
        }
        for phase_name in self.phases.keys() {
            if !reachable.contains(phase_name.as_str()) {
                warnings.push(format!(
                    "ワークフロー '{name}': フェーズ '{phase_name}' は到達不能です"
                ));
            }
        }

        Ok(warnings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev_workflow_yaml() -> &'static str {
        r#"
workflows:
  dev:
    description: 開発ワークフロー
    phases:
      plan:
        description: 実装計画を策定する
        agent: planner
        on:
          completed: code
          failed: ABORT
      code:
        description: コードを実装する
        agent: coder
        on:
          completed: review
          failed: plan
      review:
        description: コードレビューを行う
        agent: reviewer
        reviewer: human
        on:
          approved: COMPLETE
          rejected: code
"#
    }

    #[test]
    fn test_parse_config() {
        let config: SquadConfig = serde_yaml::from_str(dev_workflow_yaml()).unwrap();
        assert_eq!(config.workflows.len(), 1);
        let dev = config.get_workflow("dev").unwrap();
        assert_eq!(dev.initial_phase().unwrap(), "plan");
        assert_eq!(dev.phases.len(), 3);
        assert_eq!(dev.phases["review"].reviewer, Some("human".to_string()));
    }

    #[test]
    fn test_validate_valid_config() {
        let config: SquadConfig = serde_yaml::from_str(dev_workflow_yaml()).unwrap();
        let warnings = config.validate().unwrap();
        assert!(warnings.is_empty());
    }

    #[test]
    fn test_validate_empty_phases() {
        let yaml = r#"
workflows:
  test:
    phases: {}
"#;
        let config: SquadConfig = serde_yaml::from_str(yaml).unwrap();
        let result = config.validate();
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_invalid_transition_target() {
        let yaml = r#"
workflows:
  test:
    phases:
      plan:
        on:
          completed: nonexistent
"#;
        let config: SquadConfig = serde_yaml::from_str(yaml).unwrap();
        let result = config.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("存在しません"));
    }

    #[test]
    fn test_validate_missing_completed() {
        let yaml = r#"
workflows:
  test:
    phases:
      plan:
        agent: planner
"#;
        let config: SquadConfig = serde_yaml::from_str(yaml).unwrap();
        let result = config.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("completed"));
    }

    #[test]
    fn test_validate_reviewer_missing_approved() {
        let yaml = r#"
workflows:
  test:
    phases:
      review:
        reviewer: human
        on:
          rejected: ABORT
"#;
        let config: SquadConfig = serde_yaml::from_str(yaml).unwrap();
        let result = config.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("approved"));
    }

    #[test]
    fn test_validate_reviewer_missing_rejected() {
        let yaml = r#"
workflows:
  test:
    phases:
      review:
        reviewer: human
        on:
          approved: COMPLETE
"#;
        let config: SquadConfig = serde_yaml::from_str(yaml).unwrap();
        let result = config.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("rejected"));
    }

    #[test]
    fn test_validate_unreachable_phase() {
        let yaml = r#"
workflows:
  test:
    phases:
      plan:
        on:
          completed: COMPLETE
      orphan:
        on:
          completed: COMPLETE
"#;
        let config: SquadConfig = serde_yaml::from_str(yaml).unwrap();
        let warnings = config.validate().unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("orphan"));
        assert!(warnings[0].contains("到達不能"));
    }

    #[test]
    fn test_resolve_transition() {
        let config: SquadConfig = serde_yaml::from_str(dev_workflow_yaml()).unwrap();
        let dev = config.get_workflow("dev").unwrap();

        assert_eq!(dev.resolve_transition("plan", &TransitionCondition::Completed).unwrap(), "code");
        assert_eq!(dev.resolve_transition("plan", &TransitionCondition::Failed).unwrap(), "ABORT");
        assert_eq!(dev.resolve_transition("code", &TransitionCondition::Failed).unwrap(), "plan");
        assert_eq!(dev.resolve_transition("review", &TransitionCondition::Approved).unwrap(), "COMPLETE");
        assert_eq!(dev.resolve_transition("review", &TransitionCondition::Rejected).unwrap(), "code");
    }

    #[test]
    fn test_resolve_no_matching_rule() {
        let config: SquadConfig = serde_yaml::from_str(dev_workflow_yaml()).unwrap();
        let dev = config.get_workflow("dev").unwrap();
        let result = dev.resolve_transition("code", &TransitionCondition::Rejected);
        assert!(result.is_err());
    }

    #[test]
    fn test_transition_condition_display_and_parse() {
        assert_eq!(TransitionCondition::Completed.to_string(), "completed");
        assert_eq!(
            "completed".parse::<TransitionCondition>().unwrap(),
            TransitionCondition::Completed
        );
        assert!("invalid".parse::<TransitionCondition>().is_err());
    }
}
