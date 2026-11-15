import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GATES } from "../src/approvals/approvals.js";
import { DASHBOARD_FONTS, clearFontCache, fontFile } from "../src/dashboard/fonts.js";
import { DASHBOARD_COLORS, DASHBOARD_HTML, eventDetail, formatMoney, gateLabel, outcomeTone, splitSummary } from "../src/dashboard/page.js";

describe("gateLabel", () => {
  it("has plain words for every gate", () => {
    for (const g of GATES) {
      expect(gateLabel(g)).not.toContain("_");
      expect(gateLabel(g)[0]).toMatch(/[A-Z]/);
    }
    expect(gateLabel("pursue_opportunity")).toBe("Pursue a project");
  });

  it("falls back to sentence case, and never to an inherited property", () => {
    expect(gateLabel("some_new_gate")).toBe("Some new gate");
    expect(gateLabel("toString")).toBe("ToString");
    expect(gateLabel("")).toBe("Approval");
    expect(gateLabel(undefined as unknown as string)).toBe("Approval");
  });
});

describe("splitSummary", () => {
  it("separates the first sentence from the rest", () => {
    expect(splitSummary('Pursue STUB-E02 "Interior paint". Good fit. Low risk.')).toEqual({ lead: 'Pursue STUB-E02 "Interior paint".', rest: ["Good fit. Low risk."] });
  });

  it("does not split inside amounts or lower-case continuations", () => {
    expect(splitSummary("Submit a $1,200.50 bid on STUB-E02. Assumes daytime access.").lead).toBe("Submit a $1,200.50 bid on STUB-E02.");
    expect(splitSummary("Pay 3 bills totaling $9,120.").rest).toEqual([]);
    expect(splitSummary("Uses approx. two crews for it").lead).toBe("Uses approx. two crews for it");
  });

  it("turns line breaks in the rest into paragraphs", () => {
    expect(splitSummary("Close the job. First point.\n\nSecond point.\n  Third.").rest).toEqual(["First point.", "Second point.", "Third."]);
  });

  it("handles empty and non-text input", () => {
    expect(splitSummary("")).toEqual({ lead: "", rest: [] });
    expect(splitSummary("   ")).toEqual({ lead: "", rest: [] });
    expect(splitSummary(undefined)).toEqual({ lead: "", rest: [] });
    expect(splitSummary(42)).toEqual({ lead: "", rest: [] });
  });
});

describe("formatMoney", () => {
  it("formats numbers and blanks everything else", () => {
    expect(formatMoney(1234567)).toBe("$1,234,567");
    expect(formatMoney(0)).toBe("$0");
    expect(formatMoney(-950)).toBe("−$950");
    for (const v of [undefined, null, "12", NaN, Infinity]) expect(formatMoney(v)).toBe("");
  });
});

describe("eventDetail", () => {
  it("keeps simple fields, words the keys and drops nested data", () => {
    expect(eventDetail({ approvalId: 3, gate: "submit_bid", ok: true, items: [1], nested: { a: 1 }, none: null })).toEqual([
      { key: "approval id", value: "3" }, { key: "gate", value: "submit_bid" }, { key: "ok", value: "true" },
    ]);
  });

  it("cuts long text and stops at six fields", () => {
    expect(eventDetail({ summary: "x".repeat(200) })[0]!.value).toBe("x".repeat(120) + "…");
    expect(eventDetail({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 })).toHaveLength(6);
  });

  it("returns nothing for a missing or non-object payload", () => {
    for (const v of [undefined, null, "text", 5]) expect(eventDetail(v)).toEqual([]);
  });
});

describe("outcomeTone", () => {
  it("sorts outcomes into good, bad and neither", () => {
    expect(outcomeTone("closed")).toBe("success");
    expect(outcomeTone("Awarded")).toBe("success");
    expect(outcomeTone("lost")).toBe("danger");
    expect(outcomeTone("interrupted")).toBe("danger");
    expect(outcomeTone("no_bid")).toBe("warning");
    expect(outcomeTone(undefined)).toBe("warning");
  });
});

describe("the page", () => {
  it("uses the Blueprint colours from the design system's tokens, exactly", () => {
    const tokens = JSON.parse(readFileSync(new URL("../web/src/design/tokens.json", import.meta.url), "utf8")) as {
      color: { tokens: Array<{ name: string; value: string | Record<string, string> }> };
    };
    for (const [name, value] of Object.entries(DASHBOARD_COLORS)) {
      const token = tokens.color.tokens.find((t) => t.name === name);
      expect(token, name).toBeDefined();
      expect(typeof token!.value === "string" ? token!.value : token!.value.blueprint, name).toBe(value);
      expect(DASHBOARD_HTML).toContain(`--${name}:${value};`);
    }
  });

  it("inlines the tested helpers rather than a second copy", () => {
    for (const fn of [gateLabel, splitSummary, formatMoney, eventDetail, outcomeTone]) expect(DASHBOARD_HTML).toContain(fn.toString());
  });

  it("loads only its own fonts, and one @font-face per served file", () => {
    const urls = [...DASHBOARD_HTML.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(urls.sort()).toEqual(Object.keys(DASHBOARD_FONTS).map((f) => `/fonts/${f}`).sort());
    expect(DASHBOARD_HTML).not.toMatch(/https?:\/\//);
  });

  it("has the Blueprint shell: wordmark, side navigation and a heading per tab", () => {
    expect(DASHBOARD_HTML).toContain('<div class="wordmark">Contracting<b>.Bid</b></div>');
    for (const tab of ["approvals", "live", "runs", "start"]) expect(DASHBOARD_HTML).toContain(`data-tab="${tab}"`);
    for (const h of ["Approvals", "Live log", "Past runs", "Start a run"]) expect(DASHBOARD_HTML).toContain(`<h1>${h}</h1>`);
  });

  it("never builds HTML from run data", () => {
    expect(DASHBOARD_HTML).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe("fontFile", () => {
  it("returns WOFF2 bytes for every font the page asks for", () => {
    clearFontCache();
    for (const name of Object.keys(DASHBOARD_FONTS)) {
      const bytes = fontFile(name);
      expect(bytes, name).not.toBeNull();
      expect(bytes!.subarray(0, 4).toString("latin1"), name).toBe("wOF2");
    }
  });

  it("serves nothing outside its list", () => {
    for (const name of ["", "x.woff2", "../package.json", "archivo-600.woff2/../../x", "constructor", "__proto__"]) expect(fontFile(name)).toBeNull();
  });

  it("returns null when the package is missing, and remembers the answer", () => {
    clearFontCache();
    let calls = 0;
    const missing = () => { calls++; throw new Error("not installed"); };
    expect(fontFile("archivo-600.woff2", missing)).toBeNull();
    expect(fontFile("archivo-600.woff2", missing)).toBeNull();
    expect(calls).toBe(1);
    clearFontCache();
    expect(fontFile("archivo-600.woff2")).not.toBeNull();
  });
});
