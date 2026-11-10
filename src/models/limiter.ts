import type { ModelProvider, ModelRequest, ModelResponse } from "./types.js";

/** Lets at most `max` tasks run at once; the rest wait in order. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`Semaphore size must be a positive integer, got ${max}`);
  }

  inUse(): number {
    return this.active;
  }

  queued(): number {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // hand the slot straight to the next waiter
      else this.active--;
    }
  }
}

/**
 * Wraps a provider so calls share a semaphore. Used for the local vLLM model,
 * whose `big` profile serves only 2 requests at once: extra calls wait here
 * instead of queueing inside vLLM and slowing every request.
 */
export class LimitedProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly semaphore: Semaphore,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get model(): string {
    return this.inner.model;
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    return this.semaphore.run(() => this.inner.complete(request));
  }
}
