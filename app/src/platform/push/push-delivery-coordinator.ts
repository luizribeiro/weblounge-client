import {
  cancelPresentationDeadline,
  type PushPresentationState,
  schedulePushPresentation,
  showUntilPresented,
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
  readonly fallbackCommit: () => Commit;
  readonly present: (presentation: Presentation) => Promise<void>;
  readonly retryPrepare: (error: unknown) => boolean;
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
    return this.#deliver(input, state, predecessor).finally(async () => {
      await predecessor;
      releaseCommitTurn();
    });
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
      await showUntilPresented(state, () => state.generic);
      await predecessor;
      await this.#dependencies.commit(this.#dependencies.fallbackCommit());
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
    const prepared = await this.#prepareUntilKnown(input, state);
    if (prepared.kind === "silent") {
      cancelPresentationDeadline(state);
    } else {
      await showUntilPresented(state, () => prepared.presentation);
    }
    await predecessor;
    await this.#dependencies.commit(prepared.commit);
  }

  async #prepareUntilKnown(
    input: Input,
    state: PushPresentationState<Presentation>,
  ): Promise<PreparedPushDelivery<Presentation, Commit>> {
    while (true) {
      try {
        return await this.#dependencies.prepare(input, state);
      } catch (error: unknown) {
        if (state.expired || !this.#dependencies.retryPrepare(error)) {
          throw error;
        }
      }
    }
  }
}
