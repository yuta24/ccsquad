use crate::Result;
use crate::error::Error;

const DELIMITER: &str = "---";

/// YAML frontmatter と body を分離する。
/// frontmatter が見つからない場合はエラーを返す。
pub fn parse(content: &str) -> Result<(String, String)> {
    let trimmed = content.trim_start_matches('\n');

    if !trimmed.starts_with(DELIMITER) {
        return Err(Error::Serialization(
            "frontmatter が見つかりません".to_string(),
        ));
    }

    let after_first = &trimmed[DELIMITER.len()..];
    let after_first = after_first.strip_prefix('\n').unwrap_or(after_first);

    let Some(end_pos) = after_first.find(&format!("\n{DELIMITER}")) else {
        return Err(Error::Serialization(
            "frontmatter の終端が見つかりません".to_string(),
        ));
    };

    let yaml = after_first[..end_pos].trim().to_string();
    let rest = &after_first[end_pos + 1 + DELIMITER.len()..];
    let body = rest.strip_prefix('\n').unwrap_or(rest).to_string();

    Ok((yaml, body))
}

/// YAML frontmatter と body を結合する。
pub fn write(yaml: &str, body: &str) -> String {
    let yaml = yaml.trim_end_matches('\n');
    if body.is_empty() {
        format!("{DELIMITER}\n{yaml}\n{DELIMITER}\n")
    } else {
        format!("{DELIMITER}\n{yaml}\n{DELIMITER}\n{body}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_normal() {
        let content = "---\ntitle: test\nstatus: pending\n---\n## 説明\nこれはテストです。\n";
        let (yaml, body) = parse(content).unwrap();
        assert_eq!(yaml, "title: test\nstatus: pending");
        assert_eq!(body, "## 説明\nこれはテストです。\n");
    }

    #[test]
    fn test_parse_no_body() {
        let content = "---\ntitle: test\n---\n";
        let (yaml, body) = parse(content).unwrap();
        assert_eq!(yaml, "title: test");
        assert_eq!(body, "");
    }

    #[test]
    fn test_parse_no_frontmatter() {
        let content = "just some text";
        let result = parse(content);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_missing_end_delimiter() {
        let content = "---\ntitle: test\n";
        let result = parse(content);
        assert!(result.is_err());
    }

    #[test]
    fn test_write_with_body() {
        let result = write("title: test", "## 説明\nこれはテストです。\n");
        assert_eq!(result, "---\ntitle: test\n---\n## 説明\nこれはテストです。\n");
    }

    #[test]
    fn test_write_no_body() {
        let result = write("title: test", "");
        assert_eq!(result, "---\ntitle: test\n---\n");
    }

    #[test]
    fn test_roundtrip() {
        let yaml = "title: test\nstatus: pending";
        let body = "## 説明\nこれはテストです。\n";
        let written = write(yaml, body);
        let (parsed_yaml, parsed_body) = parse(&written).unwrap();
        assert_eq!(parsed_yaml, yaml);
        assert_eq!(parsed_body, body);
    }
}
