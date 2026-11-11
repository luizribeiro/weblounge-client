import type { Actor } from "../../../engine/generated/Actor";
import type { Person } from "../../../engine/generated/Person";
import type {
  SystemLineAction,
  SystemLineSegment,
} from "./system-line-word-types";

export function actorWords(actor: Actor): SystemLineSegment[] {
  if (actor.type === "server") return [text(actor.name)];
  return actor.me ? [text("You")] : [nick(actor)];
}

export function naturalList(
  items: readonly (readonly SystemLineSegment[])[],
): SystemLineSegment[] {
  if (items.length < 2) return [...(items[0] ?? [])];
  if (items.length === 2) return joinSegments(items, " and ");
  return items.flatMap((item, index) => [
    ...(index === 0
      ? []
      : [text(index === items.length - 1 ? ", and " : ", ")]),
    ...item,
  ]);
}

export function nameList(
  items: readonly (readonly SystemLineSegment[])[],
): SystemLineSegment[] {
  if (items.length < 2) return [...(items[0] ?? [])];
  return items.flatMap((item, index) => [
    ...(index === 0 ? [] : [text(index === items.length - 1 ? " and " : ", ")]),
    ...item,
  ]);
}

export function joinSegments(
  groups: readonly (readonly SystemLineSegment[])[],
  separator: string,
): SystemLineSegment[] {
  return groups.flatMap((group, index) => [
    ...(index === 0 ? [] : [text(separator)]),
    ...group,
  ]);
}

export function button(
  action: SystemLineAction,
  label: string,
  accessibleName: string,
): SystemLineSegment {
  return { kind: "button", action, accessibleName, text: label };
}

export function mono(value: string): SystemLineSegment {
  return { kind: "mono", text: value };
}

export function nick(person: Person): SystemLineSegment {
  return { kind: "nick", person, text: person.nick };
}

export function text(value: string): SystemLineSegment {
  return { kind: "text", text: value };
}
