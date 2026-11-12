import type { BufferProjection } from "./generated/BufferProjection";
import type { CommandSpec } from "./generated/CommandSpec";
import type { CompletionCandidate } from "./generated/CompletionCandidate";
import type { CompletionTrigger } from "./generated/CompletionTrigger";
import type { EngineMessageKey } from "./generated/EngineMessageKey";
import type { EngineRequestEnvelope } from "./generated/EngineRequestEnvelope";
import type { EngineToUi } from "./generated/EngineToUi";
import type { Hello } from "./generated/Hello";
import type { HistoryDirection } from "./generated/HistoryDirection";
import type { MessageProjection } from "./generated/MessageProjection";
import type { NetworkProjection } from "./generated/NetworkProjection";
import type { NoticeKind } from "./generated/NoticeKind";
import type { NoticeSource } from "./generated/NoticeSource";
import type { PushState } from "./generated/PushState";
import type { TypingProjection } from "./generated/TypingProjection";
import type { UiToEngine } from "./generated/UiToEngine";

export type {
  BufferProjection,
  CommandSpec,
  CompletionCandidate,
  CompletionTrigger,
  EngineMessageKey,
  EngineRequestEnvelope,
  EngineToUi,
  Hello,
  HistoryDirection,
  MessageProjection,
  NetworkProjection,
  NoticeKind,
  NoticeSource,
  PushState,
  TypingProjection,
  UiToEngine,
};

// Batch 3 removes this compatibility shape when MessageList renders system rows directly.
export type MembershipProjection =
  | {
      readonly type: "change";
      readonly id: number;
      readonly kind: "joined" | "parted" | "quit";
      readonly nicks: readonly string[];
      readonly server_time_ms: number | null;
      readonly received_at_ms: number;
    }
  | {
      readonly type: "kicked";
      readonly id: number;
      readonly actor: string;
      readonly reason: string | null;
      readonly server_time_ms: number | null;
      readonly received_at_ms: number;
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
export type HistoryState = Pick<
  Extract<EngineToUi, { type: "history_state_changed" }>,
  "at_start" | "loading"
>;

export interface WorkerHostError {
  type: "fatal";
  message_key: string;
}

export type EngineClientMessage = EngineToUi | WorkerHostError;
export type ResyncReason = "revision_gap" | "engine_changed";
export type VisibilityState = "visible" | "hidden";
export type Unsubscribe = () => void;
