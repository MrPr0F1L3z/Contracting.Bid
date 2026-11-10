import { describe, expect, it } from "vitest";
import { loadConfig, parseGpuHooks } from "../src/config/config.js";
import { DEFAULT_ROLE_MODELS, REPORTS_TO, ROLES, isRole } from "../src/config/roles.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig({});
    expect(c.claudeModel).toBe("claude-opus-5-5");
    expect(c.runBudgetUsd).toBe(5);
    expect(c.gpuHooks).toEqual([]);
  });

  it("reads values from the environment", () => {
    const c = loadConfig({
      RUN_BUDGET_USD: "2.5",
      VLLM_MODEL: "ornith-9b",
      GPU_PAUSE_HOOKS: '[{"pause":"p","resume":"r"}]',
    });
    expect(c.runBudgetUsd).toBe(2.5);
    expect(c.vllmModel).toBe("ornith-9b");
    expect(c.gpuHooks).toEqual([{ pause: "p", resume: "r" }]);
  });

  it("rejects a bad budget", () => {
    expect(() => loadConfig({ RUN_BUDGET_USD: "0" })).toThrow();
    expect(() => loadConfig({ RUN_BUDGET_USD: "abc" })).toThrow();
  });
});

describe("parseGpuHooks", () => {
  it("handles empty, invalid JSON, non-lists and bad items", () => {
    expect(parseGpuHooks(undefined)).toEqual([]);
    expect(parseGpuHooks("  ")).toEqual([]);
    expect(() => parseGpuHooks("{")).toThrow(/valid JSON/);
    expect(() => parseGpuHooks("{}")).toThrow(/list/);
    expect(() => parseGpuHooks('[{"pause":"p"}]')).toThrow(/\[0\]/);
  });
});

describe("roles", () => {
  it("Claude runs exactly the President and PM", () => {
    const claudeRoles = ROLES.filter((r) => DEFAULT_ROLE_MODELS[r] === "claude");
    expect(claudeRoles).toEqual(["president", "project_manager"]);
  });

  it("every role but the President reports to another role", () => {
    for (const r of ROLES) {
      if (r === "president") expect(REPORTS_TO[r]).toBe("owner");
      else expect(ROLES).toContain(REPORTS_TO[r]);
    }
  });

  it("isRole() recognizes roles", () => {
    expect(isRole("hr")).toBe(true);
    expect(isRole("janitor")).toBe(false);
  });
});

describe("vllm config", async () => {
  const { positive } = await import("../src/config/config.js");
  it("defaults to 4 lanes, 60s, 5 tokens/s, vllm stop / vllm start big", () => {
    expect(loadConfig({}).vllm).toEqual({
      maxLanes: 4, maxResponseSec: 60, minTokensPerSec: 5, stopCommand: "vllm stop", startCommand: "vllm start big",
    });
  });

  it("positive() parses, defaults and rejects", () => {
    expect(positive("X", undefined, 3)).toBe(3);
    expect(positive("X", " ", 3)).toBe(3);
    expect(positive("X", "8", 3)).toBe(8);
    expect(() => positive("X", "0", 3)).toThrow(/X must be/);
  });
});
