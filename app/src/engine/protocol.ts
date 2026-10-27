export type BuildId = string;
export type UiClientId = string;
export type Revision = number;
export type CommandId = string;

export interface Hello {
  build_id: BuildId;
  client_id: UiClientId;
  last_revision: Revision | null;
  shell: "web";
}

export interface DiagnosticCommand {
  type: "diagnostic";
  message: string;
}

export interface CommandEnvelope {
  id: CommandId;
  command: DiagnosticCommand;
}

export interface Ready {
  type: "ready";
  engine_instance: string;
  revision: Revision;
}

export interface IncompatibleBuild {
  type: "incompatible_build";
  engine: BuildId;
  ui: BuildId;
}

export interface DiagnosticEvent {
  type: "diagnostic";
  command_id: CommandId;
  message: string;
}

export interface Notice {
  type: "notice";
  message_key: "engine.dedicated_worker_fallback";
}

export interface CommandResult {
  type: "command_result";
  id: CommandId;
}

export interface FatalError {
  type: "fatal";
  message_key: string;
}

export type EngineToUi =
  | Ready
  | IncompatibleBuild
  | DiagnosticEvent
  | Notice
  | CommandResult
  | FatalError;

export type UiToEngine =
  | { type: "hello"; payload: Hello }
  | { type: "command"; payload: CommandEnvelope };

export type ResyncReason = "revision_gap" | "engine_changed";
export type VisibilityState = "visible" | "hidden";
export type Unsubscribe = () => void;
