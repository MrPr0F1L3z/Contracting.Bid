/**
 * Append-only event log. Every model call, tool call, message and approval
 * is an event; the dashboard, run reports and replays all read from it.
 * This in-memory version backs tests; a Postgres version comes next.
 */
export interface EventInput {
  runId: string;
  type: string;
  actor: string;
  simTime: number;
  payload?: Record<string, unknown>;
}

export interface LoggedEvent extends EventInput {
  seq: number;
  payload: Record<string, unknown>;
}

export interface EventLog {
  append(event: EventInput): LoggedEvent;
  list(filter?: { runId?: string; type?: string; actor?: string }): LoggedEvent[];
}

export class InMemoryEventLog implements EventLog {
  private readonly events: LoggedEvent[] = [];

  append(event: EventInput): LoggedEvent {
    const logged: LoggedEvent = Object.freeze({
      ...event,
      payload: structuredClone(event.payload ?? {}),
      seq: this.events.length + 1,
    });
    this.events.push(logged);
    return logged;
  }

  list(filter: { runId?: string; type?: string; actor?: string } = {}): LoggedEvent[] {
    return this.events.filter(
      (e) =>
        (filter.runId === undefined || e.runId === filter.runId) &&
        (filter.type === undefined || e.type === filter.type) &&
        (filter.actor === undefined || e.actor === filter.actor),
    );
  }
}

/** Compares two event logs ignoring nothing; used by replay tests. */
export function sameEvents(a: LoggedEvent[], b: LoggedEvent[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
