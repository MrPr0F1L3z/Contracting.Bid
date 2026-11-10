import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/models/anthropic.js";
import { OpenAiCompatibleProvider } from "../src/models/openaiCompatible.js";
import { SamGovClient } from "../src/samgov/client.js";

// These build the real SDK clients without making any network call.
describe("default clients", () => {
  it("AnthropicProvider builds a real client when none is injected", () => {
    process.env.ANTHROPIC_API_KEY ??= "test-key";
    const p = new AnthropicProvider();
    expect(p.name).toBe("anthropic");
    expect(p.model).toBe("claude-opus-5-5");
  });

  it("OpenAiCompatibleProvider builds a real client when none is injected", () => {
    const p = new OpenAiCompatibleProvider("qwen", { baseURL: "http://localhost:8000/v1" });
    expect(p.name).toBe("vllm");
  });

  it("SamGovClient defaults to global fetch", () => {
    expect(new SamGovClient("k")).toBeInstanceOf(SamGovClient);
  });
});
