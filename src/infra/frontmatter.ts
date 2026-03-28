import { CcsquadError } from "../error.js";

const DELIMITER = "---";

export function parse(content: string): { yaml: string; body: string } {
  const trimmed = content.replace(/^\n+/, "");

  if (!trimmed.startsWith(DELIMITER)) {
    throw new CcsquadError("serialization", "frontmatter が見つかりません");
  }

  const afterFirst = trimmed.slice(DELIMITER.length).replace(/^\n/, "");
  const endPos = afterFirst.indexOf(`\n${DELIMITER}`);

  if (endPos === -1) {
    throw new CcsquadError("serialization", "frontmatter の終端が見つかりません");
  }

  const yaml = afterFirst.slice(0, endPos).trim();
  const rest = afterFirst.slice(endPos + 1 + DELIMITER.length);
  const body = rest.startsWith("\n") ? rest.slice(1) : rest;

  return { yaml, body };
}

export function write(yaml: string, body: string): string {
  const trimmedYaml = yaml.replace(/\n+$/, "");
  if (body === "") {
    return `${DELIMITER}\n${trimmedYaml}\n${DELIMITER}\n`;
  }
  return `${DELIMITER}\n${trimmedYaml}\n${DELIMITER}\n${body}`;
}
