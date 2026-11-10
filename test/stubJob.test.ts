import { describe, expect, it } from "vitest";
import { STUB_CHANGE_ORDER_USD, stubJobMove, stubJobProviders } from "../src/sim/stubJob.js";
import { ReactiveProvider, toolCallsResponse } from "../src/models/stub.js";
import type { ChatMessage, ModelRequest } from "../src/models/types.js";

const tool = (name: string, inputSchema: Record<string, unknown> = {}) => ({ name, description: "", inputSchema });
const ask = (text: string, tools: string[], turns: ChatMessage[] = []): ModelRequest => ({
  system: "s",
  tools: tools.map((t) => tool(t)),
  messages: [{ role: "user", content: [{ type: "text", text }] }, ...turns],
});
const assistant: ChatMessage = { role: "assistant", content: [{ type: "text", text: "x" }] };
const result = (content: string, isError = false): ChatMessage => ({ role: "user", content: [{ type: "tool_result", toolCallId: "t", content, isError }] });
const names = (r: ReturnType<typeof stubJobMove>) => r.toolCalls.map((c) => [c.name, c.input.role ?? c.input.trade ?? c.input.quote_id ?? null]);

describe("toolCallsResponse and ReactiveProvider", () => {
  it("builds a multi-call response", () => {
    expect(toolCallsResponse([{ name: "a", input: {}, id: "1" }, { name: "b", input: { x: 1 }, id: "2" }], "m")).toEqual({
      model: "m", text: "", stopReason: "tool_call", usage: { inputTokens: 0, outputTokens: 0 },
      toolCalls: [{ name: "a", input: {}, id: "1" }, { name: "b", input: { x: 1 }, id: "2" }],
    });
  });
  it("answers from the request and records a copy of each", async () => {
    const p = new ReactiveProvider((r) => toolCallsResponse([{ name: String(r.messages.length), input: {}, id: "i" }]), "m");
    const req = ask("hi", []);
    expect((await p.complete(req)).toolCalls[0]!.name).toBe("1");
    req.messages.push(assistant);
    expect(p.requests[0]!.messages).toHaveLength(1);
    expect(p.model).toBe("m");
  });
});

describe("stubJobMove", () => {
  it("hires the role each written request names, and HR for the President", () => {
    expect(names(stubJobMove(ask("Hire the company's HR representative now.", ["propose_hire"]), "m"))).toEqual([["propose_hire", "hr"]]);
    expect(names(stubJobMove(ask("Written request ... Hire a Project Manager now", ["propose_hire"]), "m"))).toEqual([["propose_hire", "project_manager"]]);
    expect(names(stubJobMove(ask("Written request ... Hire an Estimator and a Procurement agent", ["propose_hire"]), "m"))).toEqual([["propose_hire", "estimator"], ["propose_hire", "procurement"]]);
    expect(names(stubJobMove(ask("Written request ... Hire a Scheduler now", ["propose_hire"]), "m"))).toEqual([["propose_hire", "scheduler"]]);
    expect(stubJobMove(ask("Written request ... Hire a Bookkeeper", ["propose_hire"]), "m").toolCalls).toEqual([]);
    expect(stubJobMove(ask("Hire the company's HR representative now.", ["propose_hire"], [assistant, result("ok")]), "m").text).toBe("Done.");
  });

  it("plays each bid and job step once, then finishes", () => {
    for (const t of ["decide_opportunity", "submit_estimate", "submit_bid", "set_schedule"]) {
      expect(stubJobMove(ask("x", [t]), "m").toolCalls[0]?.name).toBe(t);
      expect(stubJobMove(ask("x", [t], [assistant, result("ok")]), "m").toolCalls).toEqual([]);
    }
    expect(names(stubJobMove(ask("x", ["request_quotes"]), "m"))).toEqual([["request_quotes", "painting"], ["request_quotes", "flooring"]]);
    expect(names(stubJobMove(ask("x", ["request_quotes"], [assistant, result("ok")]), "m"))).toEqual([["select_quote", "Q-painting-1"], ["select_quote", "Q-flooring-1"]]);
    expect(stubJobMove(ask("x", ["request_quotes"], [assistant, result("ok"), assistant, result("ok")]), "m").toolCalls).toEqual([]);
    expect(stubJobMove(ask("x", ["sign_prime_contract"]), "m").toolCalls[0]?.name).toBe("sign_prime_contract");
    expect(stubJobMove(ask("x", ["sign_prime_contract"], [assistant, result("ok")]), "m").toolCalls[0]?.name).toBe("issue_subcontracts");
    expect(stubJobMove(ask("x", ["sign_prime_contract"], [assistant, result("ok"), assistant, result("ok")]), "m").toolCalls).toEqual([]);
    expect(stubJobMove(ask("x", []), "m").text).toBe("Done.");
  });

  it("picks the first offered option for a site problem", () => {
    const req = ask("x", []);
    req.tools = [tool("resolve_problem", { properties: { option_id: { enum: ["expedite", "accept_delay"] } } })];
    expect(stubJobMove(req, "m").toolCalls[0]?.input).toMatchObject({ option_id: "expedite" });
  });

  it("prices a change order lower on each rejection until it is settled", () => {
    const co = (turns: ChatMessage[]) => stubJobMove(ask("x", ["price_change_order"], turns), "m");
    expect(co([]).toolCalls[0]?.input).toMatchObject({ price_usd: STUB_CHANGE_ORDER_USD, days: 2 });
    expect(co([assistant, result("too high", true)]).toolCalls[0]?.input).toMatchObject({ price_usd: STUB_CHANGE_ORDER_USD * 0.75 });
    expect(co([assistant, result("accepted")]).text).toBe("Done.");
    expect(co([assistant, result("That was the last try", true)]).text).toBe("Done.");
  });

  it("names the worker model by profile", () => {
    expect(stubJobProviders("cloud").local.model).toBe("stub-claude-worker");
    expect(stubJobProviders("hybrid").local.model).toBe("stub-local");
    expect(stubJobProviders().claude.model).toBe("stub-claude");
  });
});
