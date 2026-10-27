import type { CommandEnvelope } from "./generated/CommandEnvelope";
import type { EngineToUi } from "./generated/EngineToUi";
import type { Hello } from "./generated/Hello";
import type { UiToEngine } from "./generated/UiToEngine";

export type { CommandEnvelope, EngineToUi, Hello, UiToEngine };

export type CommandResult = Extract<EngineToUi, { type: "command_result" }>;
export type IncompatibleBuild = Extract<
  EngineToUi,
  { type: "incompatible_build" }
>;

export interface WorkerHostError {
  type: "fatal";
  message_key: string;
}

export type EngineClientMessage = EngineToUi | WorkerHostError;
export type ResyncReason = "revision_gap" | "engine_changed";
export type VisibilityState = "visible" | "hidden";
export type Unsubscribe = () => void;
