import { describe, expect, it } from "vitest";
import { InMemoryEventLog, sameEvents } from "../src/events/eventLog.js";

describe("InMemoryEventLog", () => {
  it("assigns sequence numbers, defaults payloads and freezes events", () => {
    const log = new InMemoryEventLog();
    const a = log.append({ runId: "r1", type: "hire", actor: "president", simTime: 0 });
    const b = log.append({ runId: "r1", type: "message", actor: "hr", simTime: 1, payload: { to: "pm" } });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.payload).toEqual({});
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("copies payloads so later mutation doesn't change history", () => {
    const log = new InMemoryEventLog();
    const payload = { amount: 1 };
    log.append({ runId: "r", type: "t", actor: "a", simTime: 0, payload });
    payload.amount = 2;
    expect(log.list()[0]?.payload).toEqual({ amount: 1 });
  });

  it("filters by run, type and actor", () => {
    const log = new InMemoryEventLog();
    log.append({ runId: "r1", type: "hire", actor: "president", simTime: 0 });
    log.append({ runId: "r2", type: "hire", actor: "hr", simTime: 0 });
    expect(log.list({ runId: "r1" })).toHaveLength(1);
    expect(log.list({ type: "hire" })).toHaveLength(2);
    expect(log.list({ actor: "hr" })).toHaveLength(1);
  });
});

describe("sameEvents", () => {
  it("compares logs exactly", () => {
    const a = new InMemoryEventLog();
    const b = new InMemoryEventLog();
    a.append({ runId: "r", type: "t", actor: "x", simTime: 0 });
    b.append({ runId: "r", type: "t", actor: "x", simTime: 0 });
    expect(sameEvents(a.list(), b.list())).toBe(true);
    b.append({ runId: "r", type: "t", actor: "x", simTime: 1 });
    expect(sameEvents(a.list(), b.list())).toBe(false);
  });
});
