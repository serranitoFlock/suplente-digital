/** Minimal in-process FIFO queue that runs at most `concurrency` async tasks at once. */
export class JobQueue {
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  readonly #idleWaiters: (() => void)[] = [];

  constructor(readonly concurrency = 1) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`Queue concurrency must be a positive integer, got ${concurrency}.`);
    }
  }

  /** Tasks currently running. */
  get active(): number {
    return this.#active;
  }

  /** Tasks waiting for a free slot. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /** Schedules a task. It always starts asynchronously, so callers return before any work begins. */
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.#active++;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.#active--;
            this.#next();
          });
      };
      if (this.#active < this.concurrency && this.#waiting.length === 0) start();
      else this.#waiting.push(start);
    });
  }

  /** Resolves once nothing is running or waiting. */
  onIdle(): Promise<void> {
    if (this.#active === 0 && this.#waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #next(): void {
    const start = this.#waiting.shift();
    if (start) {
      start();
      return;
    }
    if (this.#active === 0) for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
}
