type SecuritySeverity = "info" | "warning" | "critical";

interface SecurityEvent {
  id: string;
  event: string;
  severity: SecuritySeverity;
  accountId?: string;
  sessionId?: string;
  detail: string;
  createdAt: string;
}

export interface SecurityPayload {
  mode: string;
  sessions: { total: number; active: number; staleHeartbeat: number };
  eventSummary: {
    total: number;
    warnings: number;
    critical: number;
    replayBlocked: number;
  };
  events: SecurityEvent[];
  policy: {
    accessTokenMinutes: number;
    refreshTokenDays: number;
    offlineGraceHours: number;
    replayWindowSeconds: number;
    hmac: string;
    providerEncryption: string;
    legacyApiKeyAuth: boolean;
    rateLimitsPerMinute: Record<string, number>;
    aiConcurrency: Record<string, number>;
    provider: { requestsPerSecond: number; concurrency: number };
    passwordRecovery: {
      adminResetPerHour: number;
      passwordChangePer15Minutes: number;
    };
    distributed: boolean;
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function numericRecord(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record(value))
      .filter(([, item]) => Number.isFinite(Number(item)))
      .map(([key, item]) => [key, finiteNumber(item)]),
  );
}

export function normalizeSecurityPayload(value: unknown): SecurityPayload {
  const source = record(value);
  const sessions = record(source.sessions);
  const eventSummary = record(source.eventSummary);
  const policy = record(source.policy);
  const limits = record(policy.rateLimitsPerMinute);
  const provider = record(limits.provider);
  const passwordRecovery = record(limits.passwordRecovery);
  const rateLimitsPerMinute = Object.fromEntries(
    ["wallet", "free", "starter", "pro", "enterprise"]
      .filter((plan) => Number.isFinite(Number(limits[plan])))
      .map((plan) => [plan, finiteNumber(limits[plan])]),
  );
  const events = Array.isArray(source.events)
    ? source.events.map((item, index): SecurityEvent => {
        const event = record(item);
        const rawSeverity = String(event.severity || "info");
        const severity: SecuritySeverity =
          rawSeverity === "critical" || rawSeverity === "warning"
            ? rawSeverity
            : "info";
        return {
          id: textValue(event.id, `security-event-${index}`),
          event: textValue(event.event, "security_event"),
          severity,
          accountId: textValue(event.accountId, "") || undefined,
          sessionId: textValue(event.sessionId, "") || undefined,
          detail: textValue(event.detail, "No additional detail."),
          createdAt: textValue(event.createdAt, ""),
        };
      })
    : [];

  return {
    mode: textValue(source.mode, "unknown"),
    sessions: {
      total: finiteNumber(sessions.total),
      active: finiteNumber(sessions.active),
      staleHeartbeat: finiteNumber(sessions.staleHeartbeat),
    },
    eventSummary: {
      total: finiteNumber(eventSummary.total),
      warnings: finiteNumber(eventSummary.warnings),
      critical: finiteNumber(eventSummary.critical),
      replayBlocked: finiteNumber(eventSummary.replayBlocked),
    },
    events,
    policy: {
      accessTokenMinutes: finiteNumber(policy.accessTokenMinutes),
      refreshTokenDays: finiteNumber(policy.refreshTokenDays),
      offlineGraceHours: finiteNumber(policy.offlineGraceHours),
      replayWindowSeconds: finiteNumber(policy.replayWindowSeconds),
      hmac: textValue(policy.hmac, "Not reported"),
      providerEncryption: textValue(policy.providerEncryption, "Not reported"),
      legacyApiKeyAuth: policy.legacyApiKeyAuth === true,
      rateLimitsPerMinute,
      aiConcurrency: numericRecord(limits.aiConcurrency),
      provider: {
        requestsPerSecond: finiteNumber(provider.requestsPerSecond),
        concurrency: finiteNumber(provider.concurrency),
      },
      passwordRecovery: {
        adminResetPerHour: finiteNumber(passwordRecovery.adminResetPerHour),
        passwordChangePer15Minutes: finiteNumber(
          passwordRecovery.passwordChangePer15Minutes,
        ),
      },
      distributed: limits.distributed === true,
    },
  };
}
