// Skills
import SKILL_JOB from "../../skills/job/SKILL.md" with { type: "text" };
import SKILL_JOB_RUN from "../../skills/job-run/SKILL.md" with { type: "text" };
import SKILL_JOB_APPROVE from "../../skills/job-approve/SKILL.md" with { type: "text" };
import SKILL_JOB_REJECT from "../../skills/job-reject/SKILL.md" with { type: "text" };
import SKILL_MEMORY from "../../skills/memory/SKILL.md" with { type: "text" };

// Agents
import AGENT_CODER from "../../.claude/agents/coder.md" with { type: "text" };
import AGENT_REVIEWER from "../../.claude/agents/reviewer.md" with { type: "text" };

// Default config
import DEFAULT_CONFIG from "../../ccsquad.yaml" with { type: "text" };

export {
  SKILL_JOB,
  SKILL_JOB_RUN,
  SKILL_JOB_APPROVE,
  SKILL_JOB_REJECT,
  SKILL_MEMORY,
  AGENT_CODER,
  AGENT_REVIEWER,
  DEFAULT_CONFIG,
};
