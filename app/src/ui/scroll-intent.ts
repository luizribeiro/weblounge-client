interface FrameScheduler {
  readonly request: (callback: FrameRequestCallback) => number;
  readonly cancel: (handle: number) => void;
}

const stableFrameCount = 2;

export class ScrollIntentTracker {
  readonly #readOffset: () => number;
  readonly #frames: FrameScheduler;
  #active = false;
  #pending = false;
  #pointerDown = false;
  #frame: number | undefined;
  #lastOffset = 0;
  #stableFrames = 0;

  constructor(readOffset: () => number, frames: FrameScheduler) {
    this.#readOffset = readOffset;
    this.#frames = frames;
  }

  beginPointer(): void {
    this.#cancelFrame();
    this.#pointerDown = true;
    this.#pending = true;
  }

  endPointer(): void {
    this.#pointerDown = false;
    if (this.#active) this.#watchForSettle();
    else this.#pending = false;
  }

  beginDiscrete(): void {
    this.#pending = true;
    this.#watchForPendingScroll();
  }

  consumeScroll(): boolean {
    if (!this.#pending && !this.#active && !this.#pointerDown) return false;
    this.#active = true;
    this.#pending = false;
    if (!this.#pointerDown) this.#watchForSettle();
    return true;
  }

  settle(): void {
    if (this.#pointerDown) return;
    this.#cancelFrame();
    this.#active = false;
    this.#pending = false;
  }

  dispose(): void {
    this.#cancelFrame();
  }

  #watchForPendingScroll(): void {
    this.#cancelFrame();
    let remainingFrames = stableFrameCount;
    const expire = () => {
      this.#frame = undefined;
      if (this.#active || this.#pointerDown) return;
      remainingFrames -= 1;
      if (remainingFrames === 0) {
        this.#pending = false;
        return;
      }
      this.#frame = this.#frames.request(expire);
    };
    this.#frame = this.#frames.request(expire);
  }

  #watchForSettle(): void {
    this.#cancelFrame();
    this.#lastOffset = this.#readOffset();
    this.#stableFrames = 0;
    const sample = () => {
      this.#frame = undefined;
      if (this.#pointerDown) return;
      const offset = this.#readOffset();
      if (offset === this.#lastOffset) this.#stableFrames += 1;
      else this.#stableFrames = 0;
      this.#lastOffset = offset;
      if (this.#stableFrames >= stableFrameCount) {
        this.#active = false;
        return;
      }
      this.#frame = this.#frames.request(sample);
    };
    this.#frame = this.#frames.request(sample);
  }

  #cancelFrame(): void {
    if (this.#frame === undefined) return;
    this.#frames.cancel(this.#frame);
    this.#frame = undefined;
  }
}
