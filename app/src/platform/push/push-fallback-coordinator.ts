export class PushFallbackCoordinator<Notification> {
  readonly #find: (id: string) => Promise<readonly Notification[]>;
  readonly #tracked = new Set<string>();

  constructor(
    notifications: () => Promise<readonly Notification[]>,
    matches: (notification: Notification, id: string) => boolean,
    pause: () => Promise<void>,
  ) {
    this.#find = async (id) => {
      while (true) {
        const matching = (await notifications()).filter((notification) =>
          matches(notification, id),
        );
        if (matching.length > 0) return matching;
        await pause();
      }
    };
  }

  track(id: string): void {
    this.#tracked.add(id);
  }

  async take(id: string): Promise<readonly Notification[]> {
    if (!this.#tracked.has(id)) return [];
    try {
      return await this.#find(id);
    } finally {
      this.#tracked.delete(id);
    }
  }
}
