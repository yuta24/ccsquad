import type { NodeOutput } from "../domain/types.js";
import type { AgentExitInfo } from "../infra/agent-runner.js";
import type { ProjectContext } from "./project-context.js";

export class OutputService {
  constructor(private ctx: ProjectContext) {}

  saveAgentOutput(
    jobId: string,
    phase: string,
    exitInfo: AgentExitInfo,
    executor: string,
    iteration: number,
    resultCondition: string,
  ): void {
    this.ctx.outputStore.save(jobId, {
      phase,
      executor,
      result: resultCondition,
      sessionId: exitInfo.sessionId,
      iteration,
      timestamp: new Date().toISOString(),
      content: exitInfo.content,
    });
  }

  saveHumanFeedback(
    jobId: string,
    phase: string,
    feedback: string,
    iteration: number,
  ): void {
    this.ctx.outputStore.save(jobId, {
      phase,
      executor: "human",
      result: "rejected",
      iteration,
      timestamp: new Date().toISOString(),
      content: feedback,
    });
  }

  getOutputsForJob(jobId: string): NodeOutput[] {
    return this.ctx.outputStore.loadForJob(jobId);
  }

  getOutputFileRefs(jobId: string) {
    return this.ctx.outputStore.listFilesForJob(jobId);
  }

  findLastByPhase(jobId: string, phase: string) {
    return this.ctx.outputStore.findLastByPhase(jobId, phase);
  }

  latest(jobId: string) {
    return this.ctx.outputStore.latest(jobId);
  }
}
