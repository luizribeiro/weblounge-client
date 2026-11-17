import type { ImageRejection } from "./attachable-image";

/** Whether a composer can take a dropped image: `closed` is a composer that cannot send. */
export type DropAvailability = "ready" | "unavailable" | "closed";

export interface ImageDropTarget {
  availability(): DropAvailability;
  attach(file: File): Promise<ImageRejection | undefined>;
  focus(): void;
}

export type DropRejection =
  | ImageRejection
  | Exclude<DropAvailability, "ready">
  | "several"
  | "no_conversation";

export interface DropRefusal {
  readonly reason: DropRejection;
  /** The dropped file's name; absent when several files were dropped. */
  readonly name?: string;
}

export interface DropTargetRegistration {
  /** Makes this target the one drops go to, as when its composer gains focus. */
  raise(): void;
  unregister(): void;
}

export type DropTargets = ReturnType<typeof createDropTargets>;

/** The mounted composers, the open conversation's at the front. */
export function createDropTargets() {
  let targets: readonly ImageDropTarget[] = [];
  const without = (target: ImageDropTarget) =>
    targets.filter((entry) => entry !== target);
  return {
    register(target: ImageDropTarget): DropTargetRegistration {
      targets = [...without(target), target];
      return {
        raise: () => {
          if (targets.includes(target)) targets = [...without(target), target];
        },
        unregister: () => {
          targets = without(target);
        },
      };
    },
    front(): ImageDropTarget | undefined {
      return targets.at(-1);
    },
  };
}

export const imageDropTargets = createDropTargets();

/** Attaches a single dropped image to the target, or says why it was refused. */
export async function dropFiles(
  files: readonly File[],
  target: ImageDropTarget | undefined,
): Promise<DropRefusal | undefined> {
  const [file, ...others] = files;
  if (file === undefined) return undefined;
  if (others.length > 0) return { reason: "several" };
  const refuse = (reason: DropRejection): DropRefusal => ({
    reason,
    name: file.name,
  });
  if (target === undefined) return refuse("no_conversation");
  const availability = target.availability();
  if (availability !== "ready") return refuse(availability);
  const rejection = await target.attach(file);
  return rejection === undefined ? undefined : refuse(rejection);
}

const longestName = 40;

/** Shortens a long file name in the middle, keeping its extension readable. */
export function shortFileName(name: string): string {
  const characters = Array.from(name);
  if (characters.length <= longestName) return name;
  const dot = characters.lastIndexOf(".");
  const extensionLength =
    dot > 0 && characters.length - dot <= 8 ? characters.length - dot : 0;
  const stem = characters.slice(0, characters.length - extensionLength);
  const extension = characters.slice(stem.length).join("");
  const keep = longestName - 1 - extensionLength;
  const head = Math.ceil(keep / 2);
  return `${stem.slice(0, head).join("")}…${stem.slice(stem.length - (keep - head)).join("")}${extension}`;
}
