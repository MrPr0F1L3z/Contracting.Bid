import { describe, expect, it } from "vitest";
import { REFUSED_ON_STACK, SIM_RUN_COMMANDS, STACKS, allowsSimRuns, isStack, simRefusal, stackFromEnv } from "../src/config/stack.js";

describe("stacks", () => {
  it("names the three stacks", () => {
    expect(STACKS).toEqual(["dev", "staging", "prod"]);
    expect(isStack("staging")).toBe(true);
    expect(isStack("production")).toBe(false);
  });

  it("reads APP_STACK, defaulting to dev", () => {
    expect(stackFromEnv({})).toBe("dev");
    expect(stackFromEnv({ APP_STACK: "" })).toBe("dev");
    expect(stackFromEnv({ APP_STACK: " Prod " })).toBe("prod");
    expect(stackFromEnv({ APP_STACK: "staging" })).toBe("staging");
    expect(() => stackFromEnv({ APP_STACK: "production" })).toThrow('APP_STACK must be one of dev, staging, prod, not "production"');
  });

  it("lets only dev and staging run simulations", () => {
    expect(allowsSimRuns("dev")).toBe(true);
    expect(allowsSimRuns("staging")).toBe(true);
    expect(allowsSimRuns("prod")).toBe(false);
  });

  it("refuses every sim run command on prod, and nothing else", () => {
    for (const c of SIM_RUN_COMMANDS) {
      expect(simRefusal("prod", c)).toMatch(/^The prod stack never runs simulations/);
      expect(simRefusal("staging", c)).toBeNull();
      expect(simRefusal("dev", c)).toBeNull();
    }
    for (const c of ["serve", "dashboard", "user", "help", undefined]) expect(simRefusal("prod", c)).toBeNull();
    expect(REFUSED_ON_STACK).toBe(3);
  });
});
