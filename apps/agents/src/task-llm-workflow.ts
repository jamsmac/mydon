import { embeddingGatewayFromEnv } from "./embedding";
import {
  OPENAI_COMPATIBLE_ADAPTER,
  OPENAI_COMPATIBLE_ADAPTER_VERSION,
  modelGatewayFromEnv,
  resolveModelChain,
} from "./model-gateway";

export const TASK_LLM_WORKFLOW_VERSION = 1 as const;

export type TaskLlmJobKind = "chat" | "embedding";

export interface TaskLlmWorkflowStep {
  stepKey: string;
  kind: TaskLlmJobKind;
  feature: string;
  adapter: string;
  adapterVersion: number;
  endpointProfile: string;
  provider: string;
  models: string[];
}

export interface TaskLlmWorkflowPlan {
  version: typeof TASK_LLM_WORKFLOW_VERSION;
  steps: TaskLlmWorkflowStep[];
}

function boundedModels(models: readonly string[]): string[] {
  return models.slice(0, 3);
}

function chatStep(
  feature: string,
  provider: string,
  endpointProfile: string,
  models: readonly string[],
): TaskLlmWorkflowStep {
  return {
    stepKey: feature,
    kind: "chat",
    feature,
    adapter: OPENAI_COMPATIBLE_ADAPTER,
    adapterVersion: OPENAI_COMPATIBLE_ADAPTER_VERSION,
    endpointProfile,
    provider: provider.trim().toLowerCase(),
    models: boundedModels(models),
  };
}

function embeddingStep(
  feature: string,
  provider: string,
  endpointProfile: string,
  model: string,
): TaskLlmWorkflowStep {
  return {
    stepKey: feature,
    kind: "embedding",
    feature,
    adapter: OPENAI_COMPATIBLE_ADAPTER,
    adapterVersion: OPENAI_COMPATIBLE_ADAPTER_VERSION,
    endpointProfile,
    provider: provider.trim().toLowerCase(),
    models: [model],
  };
}

/**
 * Immutable task-mode route allowlist. Only metered calls belong in the Core
 * provider-job state machine; local/subscription/cron keep their old path.
 */
export function buildTaskLlmWorkflowPlan(skill: string): TaskLlmWorkflowPlan {
  const steps: TaskLlmWorkflowStep[] = [];
  const chat =
    skill === "assess-ideas" || skill === "coach-review" || skill === "find-solution"
      ? modelGatewayFromEnv()
      : null;
  const models = boundedModels(resolveModelChain());

  if (skill === "assess-ideas") {
    const embedding = embeddingGatewayFromEnv();
    if (embedding?.billingMode === "metered") {
      if (!embedding.endpointProfile) {
        throw new Error("Metered embedding gateway has no durable endpoint profile");
      }
      steps.push(
        embeddingStep(
          "assess-ideas:recall",
          embedding.provider,
          embedding.endpointProfile,
          embedding.model,
        ),
      );
    }
    if (chat?.billingMode === "metered" && models.length > 0) {
      if (!chat.endpointProfile) {
        throw new Error("Metered chat gateway has no durable endpoint profile");
      }
      steps.push(chatStep("assess-ideas", chat.provider, chat.endpointProfile, models));
    }
  } else if (skill === "coach-review" && chat?.billingMode === "metered" && models.length > 0) {
    if (!chat.endpointProfile) {
      throw new Error("Metered chat gateway has no durable endpoint profile");
    }
    steps.push(chatStep("coach-review:eval", chat.provider, chat.endpointProfile, models));
    steps.push(chatStep("coach-review:propose", chat.provider, chat.endpointProfile, models));
  } else if (skill === "find-solution" && chat?.billingMode === "metered" && models.length > 0) {
    if (!chat.endpointProfile) {
      throw new Error("Metered chat gateway has no durable endpoint profile");
    }
    steps.push(chatStep("find-solution:rank", chat.provider, chat.endpointProfile, models));
  }

  return { version: TASK_LLM_WORKFLOW_VERSION, steps };
}
