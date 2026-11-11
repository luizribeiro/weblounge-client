import type { Person } from "../../../engine/generated/Person";

export type SystemLineAction = "collapse" | "expand" | "join" | "rejoin";

export type SystemLineIcon =
  | "ban"
  | "chat"
  | "flag"
  | "info"
  | "invite"
  | "join"
  | "kick"
  | "loader"
  | "mode"
  | "nick"
  | "op"
  | "part"
  | "people"
  | "quit"
  | "warning";

export type SystemLineSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "nick"; readonly person: Person; readonly text: string }
  | { readonly kind: "mono"; readonly text: string }
  | {
      readonly kind: "button";
      readonly action: SystemLineAction;
      readonly accessibleName: string;
      readonly text: string;
    };

export interface SystemLineWords {
  readonly details: readonly (readonly SystemLineSegment[])[];
  readonly icon: SystemLineIcon;
  readonly segments: readonly SystemLineSegment[];
  readonly warning: boolean;
}

export interface SystemLineWordOptions {
  readonly canRejoin?: boolean;
  readonly expanded?: boolean;
  readonly includeRawModes?: boolean;
}
