export class PushFallbackCoordinator<Notification> {
  readonly #find: (id: string) => Promise<readonly Notification[]>;
  readonly #lookups = new Map<string, Promise<readonly Notification[]>>();

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
    this.#lookups.set(id, this.#find(id));
  }

  async take(id: string): Promise<readonly Notification[]> {
    const lookup = this.#lookups.get(id) ?? this.#find(id);
    try {
      return await lookup;
    } finally {
      this.#lookups.delete(id);
    }
  }
}
