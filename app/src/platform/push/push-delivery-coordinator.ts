import {
  cancelPresentationDeadline,
  type PushPresentationState,
  schedulePushPresentation,
  showOnce,
} from "./push-delivery-state";

export type PreparedPushDelivery<Presentation, Commit> =
  | {
      readonly kind: "visible";
      readonly presentation: Presentation;
      readonly commit: Commit;
    }
  | { readonly kind: "silent"; readonly commit: Commit };

interface PushDeliveryDependencies<Input, Presentation, Commit> {
  readonly deadlineMs: number;
  readonly generic: () => Presentation;
  readonly present: (presentation: Presentation) => Promise<void>;
  readonly prepare: (
    input: Input,
    state: PushPresentationState<Presentation>,
  ) => Promise<PreparedPushDelivery<Presentation, Commit>>;
  readonly commit: (commit: Commit) => Promise<void>;
}

export class PushDeliveryCoordinator<Input, Presentation, Commit> {
  readonly #dependencies: PushDeliveryDependencies<Input, Presentation, Commit>;
  #commitTail = Promise.resolve();

  constructor(
    dependencies: PushDeliveryDependencies<Input, Presentation, Commit>,
  ) {
    this.#dependencies = dependencies;
  }

  enqueue(input: Input): Promise<void> {
    const predecessor = this.#commitTail;
    let releaseCommitTurn: () => void = () => {};
    this.#commitTail = new Promise<void>((resolve) => {
      releaseCommitTurn = resolve;
    });
    const state = schedulePushPresentation(
      this.#dependencies.generic(),
      this.#dependencies.present,
      this.#dependencies.deadlineMs,
    );
    return this.#deliver(input, state, predecessor).finally(releaseCommitTurn);
  }

  async #deliver(
    input: Input,
    state: PushPresentationState<Presentation>,
    predecessor: Promise<void>,
  ): Promise<void> {
    const detailed = this.#preparePresentAndCommit(
      input,
      state,
      predecessor,
    ).catch(async () => {
      await showGenericOrWaitForFallback(state);
    });
    await Promise.race([detailed, state.fallback]);
    cancelPresentationDeadline(state);
    await detailed;
  }

  async #preparePresentAndCommit(
    input: Input,
    state: PushPresentationState<Presentation>,
    predecessor: Promise<void>,
  ): Promise<void> {
    const prepared = await this.#dependencies.prepare(input, state);
    if (prepared.kind === "silent") {
      cancelPresentationDeadline(state);
    } else if (!state.expired) {
      await showOnce(state, prepared.presentation);
    }
    await predecessor;
    await this.#dependencies.commit(prepared.commit);
  }
}

async function showGenericOrWaitForFallback<T>(
  state: PushPresentationState<T>,
): Promise<void> {
  try {
    await showOnce(state, state.generic);
  } catch {
    await state.fallback;
  }
}
