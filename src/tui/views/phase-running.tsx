import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { SquadConfig, WorkflowConfig, PhaseType } from "../../config.js";
import { parseTransitionCondition } from "../../config.js";
import type { Job } from "../../job.js";
import type { JobStore } from "../../job.js";
import type { IterationStore } from "../../iteration.js";
import { resolveAndExecuteTransition } from "../../service/transition.js";
import { parsePrintOutput } from "../../result.js";
import type { OutputStore } from "../../output.js";
import { buildTaskPrompt, buildReviewPrompt, buildResumePrompt } from "../../service/prompt-builder.js";
import { PhaseHeader } from "../components/phase-header.js";
import { StatusBar } from "../components/status-bar.js";
import type { TransitionInfo } from "../constants.js";
import {
  ATTR_BOLD, COLOR_CYAN, COLOR_GRAY, COLOR_DARK_BG,
} from "../constants.js";

interface PhaseRunningViewProps {
  jobId: string;
  phase: string;
  store: JobStore;
  config: SquadConfig;
  iterationStore: IterationStore;
  projectRoot: string;
  outputStore: OutputStore;
  onTransition: (info: TransitionInfo) => void;
  onDone: () => void;
  onQuit: () => void;
}

export function PhaseRunningView({
  jobId, phase, store, config, iterationStore,
  projectRoot, outputStore,
  onTransition, onDone, onQuit,
}: PhaseRunningViewProps) {
  const [statusMsg, setStatusMsg] = useState<string>("エージェントを起動中...");
  const isProcessingRef = useRef(false);
  const currentPhaseRef = useRef(phase);

  const processTransition = useCallback((result: string, message: string) => {
    try {
      const jobData = store.load(jobId);
      const wf = config.getWorkflow(jobData.frontmatter.workflow);
      if (!wf) {
        setStatusMsg(`ワークフロー '${jobData.frontmatter.workflow}' が見つかりません`);
        isProcessingRef.current = false;
        return;
      }

      const condition = parseTransitionCondition(result);
      const txResult = resolveAndExecuteTransition(wf, store, iterationStore, jobId, condition, message);

      switch (txResult.type) {
        case "done":
          isProcessingRef.current = false;
          onDone();
          break;
        case "pause":
          isProcessingRef.current = false;
          onTransition({
            prevPhase: currentPhaseRef.current,
            result: condition,
            message,
            nextPhase: txResult.nextPhase,
            description: txResult.phaseConfig.description,
            agent: txResult.phaseConfig.agent,
            reviewer: txResult.phaseConfig.reviewer,
            phaseType: txResult.phaseConfig.type,
            reason: txResult.reason === "human_review" ? undefined : txResult.reason,
            sessionId: outputStore.findLastByPhase(jobId, currentPhaseRef.current)?.sessionId,
          });
          break;
        case "continue": {
          currentPhaseRef.current = txResult.nextPhase;
          setStatusMsg(`フェーズ ${txResult.nextPhase} を実行中...`);
          isProcessingRef.current = false;
          spawnAgentForPhase(txResult.nextPhase);
          break;
        }
      }
    } catch (e) {
      setStatusMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
      isProcessingRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, store, config, iterationStore, onTransition, onDone, outputStore]);

  const spawnAgentForPhase = useCallback((phaseName: string) => {
    let jobData: Job;
    try {
      jobData = store.load(jobId);
    } catch {
      setStatusMsg("ジョブの読み込みに失敗しました");
      return;
    }

    const wf = config.getWorkflow(jobData.frontmatter.workflow);
    const phaseConfig = wf?.getPhase(phaseName);
    if (!phaseConfig) {
      setStatusMsg(`フェーズ '${phaseName}' の設定が見つかりません`);
      return;
    }

    const phaseType: PhaseType = phaseConfig.type;
    const agentName = phaseConfig.agent ?? "claude";
    const iteration = iterationStore.get(jobId);

    // Determine if this is a resume
    const lastOutput = outputStore.findLastByPhase(jobId, phaseName);
    const sessionId = lastOutput?.sessionId;

    let prompt: string;
    let args: string[];

    if (sessionId) {
      // Resume: determine feedback based on phase type
      let feedback: string;
      if (phaseType === "task") {
        // For task resume: feedback is the last review output's content (reject reason)
        const allOutputs = outputStore.loadForJob(jobId);
        const reviewOutputs = allOutputs.filter((o) => o.phase !== phaseName);
        const lastReviewOutput = reviewOutputs.length > 0 ? reviewOutputs[reviewOutputs.length - 1] : null;
        feedback = lastReviewOutput?.content ?? "";
      } else {
        // For review resume: feedback is the last task output's content (updated work)
        const allOutputs = outputStore.loadForJob(jobId);
        const taskOutputs = allOutputs.filter((o) => o.phase !== phaseName);
        const lastTaskOutput = taskOutputs.length > 0 ? taskOutputs[taskOutputs.length - 1] : null;
        feedback = lastTaskOutput?.content ?? "";
      }

      prompt = buildResumePrompt({ phase: phaseName, phaseType, iteration, feedback });
      args = ["-p", "--resume", sessionId, "--output-format", "json", prompt];
    } else {
      const previousOutputs = outputStore.loadForJob(jobId);

      if (phaseType === "review") {
        // Review phase: find most recent task output
        const taskOutputs = previousOutputs.filter((o) => {
          const pc = wf?.getPhase(o.phase);
          return pc?.type === "task";
        });
        const lastTaskOutput = taskOutputs.length > 0 ? taskOutputs[taskOutputs.length - 1] : null;
        const taskOutput = lastTaskOutput?.content ?? "";

        prompt = buildReviewPrompt({
          jobId,
          title: jobData.frontmatter.title,
          phase: phaseName,
          phaseDescription: phaseConfig.description,
          iteration,
          jobBody: jobData.body,
          taskOutput,
        });
        args = ["-p", "--agent", agentName, "--output-format", "json", prompt];
      } else {
        // Task phase
        prompt = buildTaskPrompt({
          jobId,
          title: jobData.frontmatter.title,
          phase: phaseName,
          phaseDescription: phaseConfig.description,
          iteration,
          jobBody: jobData.body,
          previousOutputs,
        });
        args = ["-p", "--agent", agentName, "--output-format", "json", prompt];
      }
    }

    setStatusMsg(`エージェント実行中: ${phaseName}...`);

    const proc = Bun.spawn(["claude", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CCSQUAD_ROOT: projectRoot, JOB_ID: jobId },
      cwd: process.cwd(),
    });

    const chunks: Uint8Array[] = [];

    // Collect stdout asynchronously
    (async () => {
      try {
        for await (const chunk of proc.stdout) {
          chunks.push(chunk);
        }
      } catch {
        // ignore read errors
      }
    })();

    proc.exited.then((exitCode) => {
      const rawOutput = Buffer.concat(chunks).toString("utf-8").trim();

      let parsedSessionId: string | undefined;
      let content = rawOutput;

      try {
        const printResult = parsePrintOutput(rawOutput);
        parsedSessionId = printResult.sessionId || undefined;
        content = printResult.content || rawOutput;
      } catch {
        // If parsing fails, use raw output as content
        content = rawOutput;
      }

      // Save to output store
      const result = phaseType === "task"
        ? (exitCode === 0 ? "completed" : "failed")
        : (exitCode === 0 ? "approved" : "rejected");

      try {
        outputStore.save(jobId, {
          phase: phaseName,
          executor: agentName,
          result,
          sessionId: parsedSessionId,
          iteration,
          timestamp: new Date().toISOString(),
          content,
        });
      } catch (e) {
        setStatusMsg(`出力の保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
        isProcessingRef.current = false;
        return;
      }

      processTransition(result, content);
    }).catch((e) => {
      setStatusMsg(`エージェント実行エラー: ${e instanceof Error ? e.message : String(e)}`);
      isProcessingRef.current = false;
    });
  }, [jobId, store, config, iterationStore, projectRoot, outputStore, processTransition]);

  useEffect(() => {
    currentPhaseRef.current = phase;
    spawnAgentForPhase(phase);
  }, []);

  useKeyboard((event: KeyEvent) => {
    if (event.ctrl && event.name === "q") { onQuit(); event.preventDefault(); return; }
    event.preventDefault();
  });

  const { job, wfConfig, iteration } = useMemo(() => {
    let job: Job | null = null;
    let wfConfig: WorkflowConfig | undefined;
    let iteration = 0;
    try {
      job = store.load(jobId);
      wfConfig = config.getWorkflow(job.frontmatter.workflow);
      iteration = iterationStore.get(jobId);
    } catch {
      // ignore
    }
    return { job, wfConfig, iteration };
  }, [jobId, store, config, iterationStore, statusMsg]);

  return (
    <box width="100%" height="100%" flexDirection="column">
      {job && <PhaseHeader job={job} workflowConfig={wfConfig} iteration={iteration} />}
      <box
        flexGrow={1} flexDirection="column" borderStyle="single" borderColor={COLOR_CYAN}
        alignItems="center" justifyContent="center"
      >
        <text fg={COLOR_CYAN} attributes={ATTR_BOLD}>{statusMsg}</text>
      </box>
      <box height={1} paddingLeft={1} backgroundColor={COLOR_DARK_BG} flexDirection="row">
        <text fg={COLOR_GRAY}>{currentPhaseRef.current}</text>
      </box>
      <StatusBar items={[
        { key: "Ctrl+Q", label: "終了" },
      ]} />
    </box>
  );
}
