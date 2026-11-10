/**
 * Simulated clock. Time is measured in ticks (one tick = one simulated work
 * hour by default). Agents wake on clock events, never on wall-clock time,
 * which lets a six-week job run in minutes and replay identically.
 */
export interface ScheduledEvent<T> {
  id: number;
  at: number;
  payload: T;
}

export class SimClock<T = unknown> {
  private current = 0;
  private nextId = 1;
  private queue: ScheduledEvent<T>[] = [];
  private pauseReasons = new Set<string>();

  constructor(readonly ticksPerDay = 8) {
    if (!Number.isInteger(ticksPerDay) || ticksPerDay <= 0) {
      throw new Error(`ticksPerDay must be a positive integer, got ${ticksPerDay}`);
    }
  }

  now(): number {
    return this.current;
  }

  /** Converts a tick count to a whole simulated day number (day 0 first). */
  dayOf(tick: number = this.current): number {
    return Math.floor(tick / this.ticksPerDay);
  }

  /** Schedules a payload at an absolute tick. Returns the event id. */
  scheduleAt(at: number, payload: T): number {
    if (!Number.isInteger(at) || at < this.current) {
      throw new Error(`Cannot schedule at tick ${at}; now is ${this.current}`);
    }
    const event = { id: this.nextId++, at, payload };
    this.queue.push(event);
    // Stable order: by time, then by insertion id.
    this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
    return event.id;
  }

  /** Schedules a payload `delay` ticks from now. */
  scheduleIn(delay: number, payload: T): number {
    return this.scheduleAt(this.current + delay, payload);
  }

  cancel(id: number): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => e.id !== id);
    return this.queue.length < before;
  }

  pending(): readonly ScheduledEvent<T>[] {
    return this.queue;
  }

  /** Removes and returns every event due at or before now. */
  takeDue(): ScheduledEvent<T>[] {
    const due = this.queue.filter((e) => e.at <= this.current);
    this.queue = this.queue.filter((e) => e.at > this.current);
    return due;
  }

  /** Pauses the clock for a named reason, such as a pending approval. */
  pause(reason: string): void {
    this.pauseReasons.add(reason);
  }

  resume(reason: string): void {
    this.pauseReasons.delete(reason);
  }

  isPaused(): boolean {
    return this.pauseReasons.size > 0;
  }

  /** Moves time forward. Throws while paused. */
  advance(ticks = 1): number {
    if (this.isPaused()) {
      throw new Error(`Clock is paused: ${[...this.pauseReasons].join(", ")}`);
    }
    if (!Number.isInteger(ticks) || ticks < 0) {
      throw new Error(`Cannot advance by ${ticks}`);
    }
    this.current += ticks;
    return this.current;
  }

  /**
   * Jumps straight to the next scheduled event when everyone is idle.
   * Returns false when nothing is scheduled.
   */
  jumpToNext(): boolean {
    const next = this.queue[0];
    if (!next) return false;
    if (next.at > this.current) this.advance(next.at - this.current);
    return true;
  }
}
