/** Agent roles in the POC company, in hire order. */
export const ROLES = [
  "president",
  "hr",
  "project_manager",
  "estimator",
  "procurement",
  "scheduler",
  "bookkeeper",
] as const;
export type Role = (typeof ROLES)[number];

/** Simulated counterparties played by the world simulator. */
export const SIM_ACTORS = ["contracting_officer", "vendor", "subcontractor", "inspector"] as const;
export type SimActor = (typeof SIM_ACTORS)[number];

export type ModelTarget = "claude" | "local";

/** Which model family runs each role. Claude runs the two judgment roles. */
export const DEFAULT_ROLE_MODELS: Record<Role | SimActor, ModelTarget> = {
  president: "claude",
  hr: "local",
  project_manager: "claude",
  estimator: "local",
  procurement: "local",
  scheduler: "local",
  bookkeeper: "local",
  contracting_officer: "local",
  vendor: "local",
  subcontractor: "local",
  inspector: "local",
};

/** Who each role reports to. The President reports to the human owner. */
export const REPORTS_TO: Record<Role, Role | "owner"> = {
  president: "owner",
  hr: "president",
  project_manager: "president",
  estimator: "project_manager",
  procurement: "project_manager",
  scheduler: "project_manager",
  bookkeeper: "president",
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
