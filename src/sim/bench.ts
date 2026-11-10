import type { HiringReport } from "./hiringChain.js";

export interface ProfileSummary {
  profile: string;
  runs: number;
  complete: number;
  meanSec: number;
  minSec: number;
  maxSec: number;
  /** Mean seconds per role's task, e.g. { president: 12.1, hr: 30.4 }. */
  meanTaskSec: Record<string, number>;
  meanModelCalls: number;
  meanClaudeUsd: number;
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Summarises benchmark runs per profile, in the order profiles first appear. */
export function summarizeBench(reports: HiringReport[]): ProfileSummary[] {
  const byProfile = new Map<string, HiringReport[]>();
  for (const r of reports) byProfile.set(r.profile, [...(byProfile.get(r.profile) ?? []), r]);
  return [...byProfile].map(([profile, rs]) => {
    const secs = rs.map((r) => r.durationMs / 1000);
    const taskSecs = new Map<string, number[]>();
    for (const r of rs) for (const t of r.tasks) taskSecs.set(t.role, [...(taskSecs.get(t.role) ?? []), t.durationMs / 1000]);
    return {
      profile,
      runs: rs.length,
      complete: rs.filter((r) => r.outcome === "complete").length,
      meanSec: mean(secs),
      minSec: Math.min(...secs),
      maxSec: Math.max(...secs),
      meanTaskSec: Object.fromEntries([...taskSecs].map(([role, xs]) => [role, mean(xs)])),
      meanModelCalls: mean(rs.map((r) => r.tasks.reduce((n, t) => n + t.steps, 0))),
      meanClaudeUsd: mean(rs.map((r) => r.spentUsd)),
    };
  });
}

/** A plain-text comparison table, one line per profile, plus the speed-up when both are present. */
export function formatBench(summaries: ProfileSummary[]): string[] {
  const lines = ["profile  runs  complete  mean s   min s   max s   model calls  Claude $/run  per task (s)"];
  for (const s of summaries) {
    const tasks = Object.entries(s.meanTaskSec).map(([role, sec]) => `${role} ${sec.toFixed(1)}`).join(", ");
    lines.push(
      [
        s.profile.padEnd(7),
        String(s.runs).padStart(4),
        `${s.complete}/${s.runs}`.padStart(9),
        s.meanSec.toFixed(1).padStart(7),
        s.minSec.toFixed(1).padStart(7),
        s.maxSec.toFixed(1).padStart(7),
        s.meanModelCalls.toFixed(1).padStart(12),
        `$${s.meanClaudeUsd.toFixed(4)}`.padStart(13),
        ` ${tasks}`,
      ].join(" "),
    );
  }
  const hybrid = summaries.find((s) => s.profile === "hybrid");
  const cloud = summaries.find((s) => s.profile === "cloud");
  if (hybrid && cloud && cloud.meanSec > 0) {
    const ratio = hybrid.meanSec / cloud.meanSec;
    lines.push(
      `cloud is ${ratio >= 1 ? `${ratio.toFixed(1)}x faster` : `${(1 / ratio).toFixed(1)}x slower`} than hybrid, ` +
        `at $${(cloud.meanClaudeUsd - hybrid.meanClaudeUsd).toFixed(4)} more Claude spend per run`,
    );
  }
  return lines;
}
