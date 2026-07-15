import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";

export type SecurityEventSeverity = "info" | "warning" | "critical";

export interface SecurityEventRecord {
  id: string;
  event: string;
  severity: SecurityEventSeverity;
  accountId?: string;
  sessionId?: string;
  requestId?: string;
  detail: string;
  createdAt: string;
}

@Injectable()
export class SecurityEventService {
  private readonly eventsValue: SecurityEventRecord[] = [];

  record(input: Omit<SecurityEventRecord, "id" | "createdAt">): void {
    this.eventsValue.unshift({ id: randomUUID(), createdAt: new Date().toISOString(), ...input });
    if (this.eventsValue.length > 1000) this.eventsValue.length = 1000;
  }

  list(limit = 100): SecurityEventRecord[] {
    return this.eventsValue.slice(0, Math.max(1, Math.min(500, limit))).map((item) => ({ ...item }));
  }

  summary() {
    return {
      total: this.eventsValue.length,
      warnings: this.eventsValue.filter((item) => item.severity === "warning").length,
      critical: this.eventsValue.filter((item) => item.severity === "critical").length,
      replayBlocked: this.eventsValue.filter((item) => item.event === "desktop_replay_blocked").length,
    };
  }
}
