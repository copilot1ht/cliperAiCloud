"use client";

import { KeyRound, Radio, ShieldAlert, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { adminFetch, formatDate } from "@/lib/admin-api";
import { normalizeSecurityPayload, type SecurityPayload } from "@/lib/admin-security-payload";
import { AdminError, AdminLoading, LocalModeNotice } from "@/components/admin-ui";
import { StatCard } from "@/components/stat-card";

export function AdminSecurity() {
  const [data, setData] = useState<SecurityPayload | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    adminFetch<unknown>("/api/admin/security")
      .then((payload) => setData(normalizeSecurityPayload(payload)))
      .catch((reason) => setError(reason.message));
  }, []);

  useEffect(load, [load]);
  if (error)
    return (
      <>
        <LocalModeNotice />
        <AdminError message={error} retry={load} />
      </>
    );
  if (!data) return <AdminLoading />;

  const requestLimits = Object.entries(data.policy.rateLimitsPerMinute);
  const concurrencyLimits = Object.entries(data.policy.aiConcurrency);

  return (
    <>
      <LocalModeNotice />
      <div className="stats-grid">
        <StatCard
          label="Signed sessions"
          value={String(data.sessions.active)}
          detail={`${data.sessions.total} total issued`}
          icon={KeyRound}
          tone="blue"
        />
        <StatCard
          label="Security events"
          value={String(data.eventSummary.total)}
          detail={`${data.eventSummary.warnings} warnings`}
          icon={ShieldAlert}
        />
        <StatCard
          label="Replay blocked"
          value={String(data.eventSummary.replayBlocked)}
          detail={`${data.eventSummary.critical} critical events`}
          icon={ShieldCheck}
          tone="amber"
        />
        <StatCard
          label="Stale heartbeat"
          value={String(data.sessions.staleHeartbeat)}
          detail="No heartbeat for 20 minutes"
          icon={Radio}
          tone="coral"
        />
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="section-kicker">Enforced controls</p>
            <h2>Desktop security policy</h2>
            <p>
              Session requests use access tokens, body checksums, nonces,
              timestamps, and HMAC signatures.
            </p>
          </div>
        </div>
        <div className="finance-grid">
          <span><small>Access token</small><strong>{data.policy.accessTokenMinutes} min</strong></span>
          <span><small>Refresh token</small><strong>{data.policy.refreshTokenDays} days</strong></span>
          <span><small>Offline grace</small><strong>{data.policy.offlineGraceHours} hours</strong></span>
          <span><small>Replay window</small><strong>{data.policy.replayWindowSeconds} sec</strong></span>
          <span><small>Request integrity</small><strong>{data.policy.hmac}</strong></span>
          <span><small>Provider encryption</small><strong>{data.policy.providerEncryption}</strong></span>
        </div>
        <div className="notice-line security-notice">
          <div>
            <ShieldCheck size={17} />
            <span>
              <strong>Legacy direct-key auth:</strong>{" "}
              {data.policy.legacyApiKeyAuth
                ? "enabled for local compatibility"
                : "disabled"}
              . Production default is disabled.
            </span>
          </div>
        </div>
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <div>
            <p className="section-kicker">Audit trail</p>
            <h2>Security events</h2>
            <p>
              Signature mismatch, replay, refresh rejection, and desktop
              activation are recorded without secrets.
            </p>
          </div>
          <button className="button button-secondary" onClick={load}>Refresh</button>
        </div>
        {data.events.length ? (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Event</th><th>Severity</th><th>Account / Session</th><th>Detail</th><th>Time</th></tr></thead>
              <tbody>
                {data.events.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.event}</strong></td>
                    <td><span className={item.severity === "critical" ? "status-tag danger-tag" : item.severity === "warning" ? "status-tag fallback" : "status-tag healthy"}>{item.severity}</span></td>
                    <td>{item.accountId || "-"}<small>{item.sessionId || "-"}</small></td>
                    <td>{item.detail}</td>
                    <td>{formatDate(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="admin-empty">
            <strong>No security events yet</strong>
            <span>Events appear after desktop activation or rejected integrity checks.</span>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="section-kicker">Request safeguards</p>
            <h2>Rate limits and concurrency</h2>
            <p>
              Request volume and active AI jobs are limited separately. Counters
              use {data.policy.distributed ? "Redis" : "the API process"}.
            </p>
          </div>
        </div>
        <div className="finance-grid">
          {requestLimits.map(([plan, value]) => (
            <span key={`request-${plan}`}><small>{plan} requests</small><strong>{value} req/min</strong></span>
          ))}
          {concurrencyLimits.map(([plan, value]) => (
            <span key={`concurrency-${plan}`}><small>{plan} AI jobs</small><strong>{value} concurrent</strong></span>
          ))}
          <span><small>Provider throughput</small><strong>{data.policy.provider.requestsPerSecond} req/sec</strong></span>
          <span><small>Provider concurrency</small><strong>{data.policy.provider.concurrency} active</strong></span>
          <span><small>Admin password resets</small><strong>{data.policy.passwordRecovery.adminResetPerHour}/hour</strong></span>
          <span><small>Password changes</small><strong>{data.policy.passwordRecovery.passwordChangePer15Minutes}/15 min</strong></span>
        </div>
      </section>
    </>
  );
}
