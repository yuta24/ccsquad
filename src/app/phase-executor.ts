import type { PhaseType } from "../domain/types.js";
import { isTaskLikeType, getOutputFormat, parseTransitionCondition, getPhase } from "../domain/workflow.js";
import { spawnAgent } from "../infra/agent-runner.js";
import type { AgentProcess, AgentExitInfo } from "../infra/agent-runner.js";
import type { DisplayLine } from "../infra/stream-parser.js";
import { buildTaskPrompt, buildReviewPrompt, buildResumePrompt } from "./prompt-builder.js";
import type { JobService, TransitionResult } from "./job-service.js";
import type { OutputService } from "./output-service.js";
import type { ProjectContext } from "./project-context.js";

export interface PhaseExecution {
  onDisplayLines(handler: (lines: DisplayLine[]) => void): void;
  onExit(handler: (result: TransitionResult) => void): void;
  onError(handler: (message: string) => void): void;
  kill(): void;
  readonly exited: boolean;
}

export class PhaseExecutor {
  constructor(
    private ctx: ProjectContext,
    private jobService: JobService,
    private outputService: OutputService,
  ) {}

  start(jobId: string, phaseName: string, cols: number): PhaseExecution {
    let exitHandler: ((result: TransitionResult) => void) | null = null;
    let errorHandler: ((message: string) => void) | null = null;
    let displayHandler: ((lines: DisplayLine[]) => void) | null = null;
    let agent: AgentProcess | null = null;

    const execution: PhaseExecution = {
      onDisplayLines(handler) { displayHandler = handler; },
      onExit(handler) { exitHandler = handler; },
      onError(handler) { errorHandler = handler; },
      kill() { agent?.kill(); },
      get exited() { return agent?.exited ?? true; },
    };

    // Build args and spawn asynchronously
    try {
      const jobData = this.ctx.jobStore.load(jobId);
      const wf = this.ctx.workflows[jobData.frontmatter.workflow];
      if (!wf) {
        setTimeout(() => errorHandler?.("ワークフローが見つかりません"), 0);
        return execution;
      }

      const phaseConfig = getPhase(wf, phaseName);
      if (!phaseConfig) {
        setTimeout(() => errorHandler?.(`フェーズ '${phaseName}' が見つかりません`), 0);
        return execution;
      }

      const phaseType: PhaseType = phaseConfig.type;
      const agentName = phaseConfig.agent ?? "claude";
      const iteration = this.ctx.iterationStore.get(jobId);
      const lastOutput = this.ctx.outputStore.findLastByPhase(jobId, phaseName);
      const sessionId = lastOutput?.sessionId;
      const outputFiles = this.ctx.outputStore.listFilesForJob(jobId);

      let prompt: string;
      let args: string[];

      if (sessionId) {
        const feedbackFiles = outputFiles.filter((f) => f.phase !== phaseName);
        const lastFeedbackFile = feedbackFiles.length > 0 ? feedbackFiles[feedbackFiles.length - 1] : null;
        const feedbackRef = lastFeedbackFile ? `以下のファイルを参照してください: \`${lastFeedbackFile.filePath}\`` : "";

        prompt = buildResumePrompt({ phase: phaseName, phaseType, phasePrompt: phaseConfig.prompt, iteration, feedback: feedbackRef });
        args = ["claude", "-p", "--verbose", "--permission-mode", "auto", "--resume", sessionId, "--output-format", "stream-json", prompt];
      } else if (phaseType === "review") {
        const taskOutputFiles = outputFiles.filter((f) => {
          const pc = getPhase(wf, f.phase);
          return pc ? isTaskLikeType(pc.type) : false;
        });
        const lastTaskOutputFile = taskOutputFiles.length > 0 ? taskOutputFiles[taskOutputFiles.length - 1] : null;

        if (!lastTaskOutputFile) {
          setTimeout(() => errorHandler?.("レビュー対象の出力が見つかりません"), 0);
          return execution;
        }

        prompt = buildReviewPrompt({
          jobId,
          title: jobData.frontmatter.title,
          phase: phaseName,
          phaseDescription: phaseConfig.description,
          phasePrompt: phaseConfig.prompt,
          iteration,
          jobBody: jobData.body,
          taskOutputFile: lastTaskOutputFile,
          outputFiles,
          outputFormat: getOutputFormat(phaseConfig),
        });
        args = ["claude", "-p", "--verbose", "--permission-mode", "auto", "--agent", agentName, "--output-format", "stream-json", prompt];
      } else {
        prompt = buildTaskPrompt({
          jobId,
          title: jobData.frontmatter.title,
          phase: phaseName,
          phaseDescription: phaseConfig.description,
          phasePrompt: phaseConfig.prompt,
          iteration,
          jobBody: jobData.body,
          outputFiles,
          outputFormat: getOutputFormat(phaseConfig),
        });
        args = ["claude", "-p", "--verbose", "--permission-mode", "auto", "--agent", agentName, "--output-format", "stream-json", prompt];
      }

      agent = spawnAgent({
        args,
        cols,
        env: { CCSQUAD_ROOT: this.ctx.projectRoot, JOB_ID: jobId },
        cwd: process.cwd(),
      });

      agent.onDisplayLines((lines) => {
        displayHandler?.(lines);
      });

      agent.onExit((exitInfo: AgentExitInfo) => {
        const resultCondition = isTaskLikeType(phaseType)
          ? (exitInfo.exitCode === 0 ? "completed" : "failed")
          : (exitInfo.exitCode === 0 ? "approved" : "rejected");

        try {
          this.outputService.saveAgentOutput(jobId, phaseName, exitInfo, agentName, iteration, resultCondition);
        } catch {
          errorHandler?.("出力の保存に失敗しました");
          return;
        }

        try {
          const condition = parseTransitionCondition(resultCondition);
          const txResult = this.jobService.transition(jobId, condition, exitInfo.content);
          exitHandler?.(txResult);
        } catch (e) {
          errorHandler?.(e instanceof Error ? e.message : String(e));
        }
      });
    } catch (e) {
      setTimeout(() => errorHandler?.(e instanceof Error ? e.message : String(e)), 0);
    }

    return execution;
  }
}
