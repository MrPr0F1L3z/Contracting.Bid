/**
 * Structured details for an approval, so the dashboard can lay a request out
 * as a title, labelled facts and labelled notes instead of one long sentence.
 * The `summary` string stays the plain-text form (terminal, event log, database).
 */
import type { Opportunity } from "../opportunities/types.js";

export interface ApprovalFact {
  label: string;
  value: string;
}

/** A longer piece of text, usually written by an agent. */
export interface ApprovalNote {
  label: string;
  text: string;
}

export interface ApprovalDetails {
  title: string;
  subtitle?: string;
  facts: ApprovalFact[];
  notes?: ApprovalNote[];
}

export const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

/** "Dec 4, 2026, 2:00 PM UTC". Always UTC, so a report reads the same on every machine. */
export function formatDeadline(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const text = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
  return `${text} UTC`;
}

export function valueRange(range: { min: number; max: number } | null): string {
  if (!range) return "Not stated";
  return range.min === range.max ? usd(range.min) : `${usd(range.min)} to ${usd(range.max)}`;
}

const sentenceCase = (s: string): string => {
  const t = s.replace(/_/g, " ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
};

/** Drops notes with nothing in them; returns undefined when none are left, so the field can be omitted. */
export function notes(...entries: Array<[label: string, text: unknown]>): ApprovalNote[] | undefined {
  const kept = entries
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim().length > 0)
    .map(([label, text]) => ({ label, text: text.trim() }));
  return kept.length ? kept : undefined;
}

function withNotes(details: Omit<ApprovalDetails, "notes">, list: ApprovalNote[] | undefined): ApprovalDetails {
  return list ? { ...details, notes: list } : details;
}

export function opportunityFacts(o: Opportunity): ApprovalFact[] {
  return [
    { label: "Location", value: `${o.placeOfPerformance.city}, ${o.placeOfPerformance.state}` },
    { label: "Government estimate", value: valueRange(o.estimatedValueUsd) },
    { label: "Response due", value: formatDeadline(o.responseDeadline) },
    { label: "Set-aside", value: o.setAside ?? "None" },
    { label: "Notice type", value: sentenceCase(o.type) },
    { label: "NAICS", value: o.naicsCode },
    ...(o.complexity ? [{ label: "Complexity", value: sentenceCase(o.complexity) }] : []),
  ];
}

const jobLine = (o: Opportunity): string => `${o.agency} · ${o.noticeId}`;

export function pursueDetails(o: Opportunity, rationale: string): ApprovalDetails {
  return withNotes({ title: o.title, subtitle: jobLine(o), facts: opportunityFacts(o) }, notes(["Scope", o.scopeSummary], ["Why pursue it", rationale]));
}

export function bidDetails(o: Opportunity, priceUsd: number, costUsd: number, assumptions: string): ApprovalDetails {
  const margin = priceUsd - costUsd;
  const pct = priceUsd > 0 ? `${((margin / priceUsd) * 100).toFixed(1)}%` : "n/a";
  return withNotes(
    {
      title: o.title,
      subtitle: jobLine(o),
      facts: [
        { label: "Bid price", value: usd(priceUsd) },
        { label: "Selected quotes", value: usd(costUsd) },
        { label: "Margin", value: `${usd(margin)} (${pct})` },
        { label: "Government estimate", value: valueRange(o.estimatedValueUsd) },
        { label: "Response due", value: formatDeadline(o.responseDeadline) },
      ],
    },
    notes(["Assumptions", assumptions]),
  );
}

export function hireDetails(input: { role: string; budgetUsd: number; hirer: string; justification: string; instructions: string }): ApprovalDetails {
  return withNotes(
    {
      title: `Hire ${input.role}`,
      subtitle: `Proposed by ${input.hirer}`,
      facts: [
        { label: "Role", value: input.role },
        { label: "Spending limit", value: usd(input.budgetUsd) },
      ],
    },
    notes(["Why now", input.justification], ["Standing instructions", input.instructions]),
  );
}

export function contractDetails(o: Opportunity, priceUsd: number, contractDays: number, ldPerDayUsd: number): ApprovalDetails {
  return {
    title: o.title,
    subtitle: jobLine(o),
    facts: [
      { label: "Contract price", value: usd(priceUsd) },
      { label: "Time to complete", value: `${contractDays} working days` },
      { label: "Liquidated damages", value: `${usd(ldPerDayUsd)} per day late` },
    ],
  };
}

export function changeOrderDetails(o: Opportunity, priceUsd: number, days: number, problem: string, justification: unknown): ApprovalDetails {
  return withNotes(
    {
      title: o.title,
      subtitle: jobLine(o),
      facts: [
        { label: "Added price", value: usd(priceUsd) },
        { label: "Added time", value: `${days} ${days === 1 ? "day" : "days"}` },
      ],
    },
    notes(["What happened", problem], ["Justification", justification]),
  );
}

export function closeDetails(o: Opportunity, account: { invoicedUsd: number; receivedUsd: number; paidOutUsd: number; cashProfitUsd: number; interestUsd: number; writtenOffUsd: number }, summary: unknown): ApprovalDetails {
  return withNotes(
    {
      title: o.title,
      subtitle: jobLine(o),
      facts: [
        { label: "Invoiced", value: usd(account.invoicedUsd) },
        { label: "Received", value: usd(account.receivedUsd) },
        { label: "Paid out", value: usd(account.paidOutUsd) },
        { label: "Cash profit", value: usd(account.cashProfitUsd) },
        ...(account.interestUsd ? [{ label: "Interest recovered", value: usd(account.interestUsd) }] : []),
        ...(account.writtenOffUsd ? [{ label: "Written off", value: usd(account.writtenOffUsd) }] : []),
      ],
    },
    notes(["Closeout summary", summary]),
  );
}
