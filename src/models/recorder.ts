import type { ModelProvider, ModelRequest, ModelResponse } from "./types.js";

/** One recorded model call, keyed by the caller and its call number. */
export interface RecordedCall {
  key: string;
  response: ModelResponse;
}

/**
 * Wraps a provider and records every response under `${callerId}#${n}`.
 * Replaying a run uses these recordings instead of calling the model, so a
 * replay matches exactly even when a local model is non-deterministic.
 */
export class RecordingProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly calls: RecordedCall[] = [];
  private counter = 0;

  constructor(
    private readonly inner: ModelProvider,
    private readonly callerId: string,
  ) {
    this.name = `recording:${inner.name}`;
    this.model = inner.model;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const key = `${this.callerId}#${this.counter++}`;
    const response = await this.inner.complete(request);
    this.calls.push({ key, response });
    return response;
  }
}

/** Serves recorded responses for one caller, in order. */
export class ReplayProvider implements ModelProvider {
  readonly name = "replay";
  private counter = 0;
  private readonly byKey: Map<string, ModelResponse>;

  constructor(
    recordings: RecordedCall[],
    private readonly callerId: string,
    readonly model = "replay",
  ) {
    this.byKey = new Map(recordings.map((r) => [r.key, r.response]));
  }

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    const key = `${this.callerId}#${this.counter++}`;
    const response = this.byKey.get(key);
    if (!response) {
      throw new Error(`No recorded response for ${key}; the replay has diverged from the recording`);
    }
    return response;
  }
}
