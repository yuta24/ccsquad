// Skills
import SKILL_JOB from "../skills/job/SKILL.md" with { type: "text" };
import SKILL_MEMORY from "../skills/memory/SKILL.md" with { type: "text" };

// Agents
import AGENT_CODER from "../.claude/agents/coder.md" with { type: "text" };
import AGENT_REVIEWER from "../.claude/agents/reviewer.md" with { type: "text" };

// Default config
import DEFAULT_CONFIG from "../ccsquad.yaml" with { type: "text" };

export {
  SKILL_JOB,
  SKILL_MEMORY,
  AGENT_CODER,
  AGENT_REVIEWER,
  DEFAULT_CONFIG,
};
