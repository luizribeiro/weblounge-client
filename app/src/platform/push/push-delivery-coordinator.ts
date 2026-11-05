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
  readonly fallbackDeadlineMs: number;
  readonly presentationBudgetMs: number;
  readonly generic: () => Presentation;
  readonly finalFallback: (generic: Presentation) => Presentation;
  readonly fallbackCommit: (fallback: Presentation) => Commit;
  readonly present: (presentation: Presentation) => Promise<void>;
  readonly replace: (
    fallback: Presentation,
    presentation: Presentation,
  ) => Promise<boolean>;
  readonly retryPrepare: (error: unknown) => boolean;
  readonly reportError: (error: unknown) => void;
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
      this.#dependencies.fallbackDeadlineMs,
      this.#dependencies.presentationBudgetMs,
      this.#dependencies.reportError,
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
    let prepared: PreparedPushDelivery<Presentation, Commit>;
    try {
      prepared = await this.#prepareUntilKnown(input, state);
    } catch (error: unknown) {
      this.#dependencies.reportError(error);
      if (!state.shown) {
        state.generic = this.#dependencies.finalFallback(state.generic);
      }
      const shown = await showUntilPresented(state, () => state.generic);
      cancelPresentationDeadline(state);
      if (shown) {
        await this.#commit(
          predecessor,
          this.#dependencies.fallbackCommit(state.generic),
        );
      }
      return;
    }
    if (prepared.kind === "silent") {
      cancelPresentationDeadline(state);
      await this.#commit(predecessor, prepared.commit);
      return;
    }
    const shown = await showUntilPresented(state, () => prepared.presentation);
    cancelPresentationDeadline(state);
    if (!shown) return;
    if (
      state.presented !== undefined &&
      state.presented !== prepared.presentation
    ) {
      try {
        const replaced = await this.#dependencies.replace(
          state.presented,
          prepared.presentation,
        );
        if (replaced) state.presented = prepared.presentation;
      } catch (error: unknown) {
        this.#dependencies.reportError(error);
      }
    }
    await this.#commit(predecessor, prepared.commit);
  }

  async #commit(predecessor: Promise<void>, commit: Commit): Promise<void> {
    await predecessor;
    try {
      await this.#dependencies.commit(commit);
    } catch (error: unknown) {
      this.#dependencies.reportError(error);
    }
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
