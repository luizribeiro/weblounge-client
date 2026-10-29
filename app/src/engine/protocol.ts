import type { BufferProjection } from "./generated/BufferProjection";
import type { CommandSpec } from "./generated/CommandSpec";
import type { CompletionCandidate } from "./generated/CompletionCandidate";
import type { CompletionTrigger } from "./generated/CompletionTrigger";
import type { EngineRequestEnvelope } from "./generated/EngineRequestEnvelope";
import type { EngineToUi } from "./generated/EngineToUi";
import type { Hello } from "./generated/Hello";
import type { MembershipProjection } from "./generated/MembershipProjection";
import type { MessageProjection } from "./generated/MessageProjection";
import type { NetworkProjection } from "./generated/NetworkProjection";
import type { UiToEngine } from "./generated/UiToEngine";

export type {
  BufferProjection,
  CommandSpec,
  CompletionCandidate,
  CompletionTrigger,
  EngineRequestEnvelope,
  EngineToUi,
  Hello,
  MembershipProjection,
  MessageProjection,
  NetworkProjection,
  UiToEngine,
};

export type CommandResult = Extract<EngineToUi, { type: "command_result" }>;
export type CommandRejected = Extract<EngineToUi, { type: "command_rejected" }>;
export type CompletionResult = Extract<
  EngineToUi,
  { type: "completion_result" }
>;
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
