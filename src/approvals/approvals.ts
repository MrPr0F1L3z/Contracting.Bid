/** Every action that needs the owner's approval. See the POC spec. */
export const GATES = [
  "hire_agent",
  "pursue_opportunity",
  "submit_bid",
  "sign_contract",
  "sign_commitment",
  "approve_change_order",
  "release_payment",
  "close_project",
] as const;
export type Gate = (typeof GATES)[number];

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalRequest {
  id: number;
  gate: Gate;
  requestedBy: string;
  summary: string;
  amountUsd?: number;
  status: ApprovalStatus;
  decidedBy?: string;
  reason?: string;
  autoApproved: boolean;
}

/**
 * Holds approval requests. A gate on auto-approve (simulation only) is
 * approved at once but still recorded and flagged.
 */
export class ApprovalQueue {
  private readonly requests: ApprovalRequest[] = [];

  constructor(private readonly autoApprove: ReadonlySet<Gate> = new Set()) {}

  request(input: { gate: Gate; requestedBy: string; summary: string; amountUsd?: number }): ApprovalRequest {
    if (input.amountUsd !== undefined && !(input.amountUsd >= 0)) {
      throw new Error(`Invalid amount ${input.amountUsd}`);
    }
    const auto = this.autoApprove.has(input.gate);
    const req: ApprovalRequest = {
      ...input,
      id: this.requests.length + 1,
      status: auto ? "approved" : "pending",
      autoApproved: auto,
      ...(auto ? { decidedBy: "auto", reason: "Gate set to auto-approve for this simulation" } : {}),
    };
    this.requests.push(req);
    return req;
  }

  decide(id: number, approve: boolean, decidedBy: string, reason?: string): ApprovalRequest {
    const req = this.requests.find((r) => r.id === id);
    if (!req) throw new Error(`No approval request ${id}`);
    if (req.status !== "pending") throw new Error(`Approval ${id} is already ${req.status}`);
    req.status = approve ? "approved" : "rejected";
    req.decidedBy = decidedBy;
    if (reason !== undefined) req.reason = reason;
    return req;
  }

  get(id: number): ApprovalRequest | undefined {
    return this.requests.find((r) => r.id === id);
  }

  pending(): ApprovalRequest[] {
    return this.requests.filter((r) => r.status === "pending");
  }

  all(): ApprovalRequest[] {
    return [...this.requests];
  }
}
