import { describe, expect, it } from "vitest";
import { SimClock } from "../src/sim/clock.js";

describe("SimClock", () => {
  it("starts at tick 0 and rejects bad ticksPerDay", () => {
    expect(new SimClock().now()).toBe(0);
    expect(() => new SimClock(0)).toThrow();
  });

  it("dayOf() converts ticks to days", () => {
    const clock = new SimClock(8);
    expect(clock.dayOf(0)).toBe(0);
    expect(clock.dayOf(7)).toBe(0);
    expect(clock.dayOf(8)).toBe(1);
    expect(clock.dayOf()).toBe(0);
  });

  it("scheduleAt/scheduleIn order events by time then insertion", () => {
    const clock = new SimClock<string>();
    clock.scheduleAt(5, "b");
    clock.scheduleIn(2, "a");
    clock.scheduleAt(5, "c");
    expect(clock.pending().map((e) => e.payload)).toEqual(["a", "b", "c"]);
  });

  it("rejects scheduling in the past", () => {
    const clock = new SimClock();
    clock.advance(3);
    expect(() => clock.scheduleAt(2, "x")).toThrow();
  });

  it("takeDue() returns only due events and removes them", () => {
    const clock = new SimClock<string>();
    clock.scheduleAt(1, "a");
    clock.scheduleAt(3, "b");
    clock.advance(2);
    expect(clock.takeDue().map((e) => e.payload)).toEqual(["a"]);
    expect(clock.pending()).toHaveLength(1);
  });

  it("cancel() removes an event", () => {
    const clock = new SimClock<string>();
    const id = clock.scheduleAt(1, "a");
    expect(clock.cancel(id)).toBe(true);
    expect(clock.cancel(id)).toBe(false);
  });

  it("pause/resume blocks advancing until every reason clears", () => {
    const clock = new SimClock();
    clock.pause("approval:1");
    clock.pause("approval:2");
    expect(clock.isPaused()).toBe(true);
    expect(() => clock.advance()).toThrow(/paused/);
    clock.resume("approval:1");
    expect(clock.isPaused()).toBe(true);
    clock.resume("approval:2");
    expect(clock.advance()).toBe(1);
  });

  it("advance() rejects negative or fractional ticks", () => {
    const clock = new SimClock();
    expect(() => clock.advance(-1)).toThrow();
    expect(() => clock.advance(0.5)).toThrow();
  });

  it("jumpToNext() skips idle time to the next event", () => {
    const clock = new SimClock<string>();
    expect(clock.jumpToNext()).toBe(false);
    clock.scheduleAt(40, "delivery");
    expect(clock.jumpToNext()).toBe(true);
    expect(clock.now()).toBe(40);
  });
});
