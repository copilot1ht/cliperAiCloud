"use client";

import { Activity, Clock3, Database, MemoryStick, ServerCog } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { adminFetch, formatDate } from "@/lib/admin-api";
import { AdminError, AdminLoading, LocalModeNotice } from "@/components/admin-ui";
import { StatCard } from "@/components/stat-card";

interface HealthPayload {
  mode: string;
  checkedAt: string;
  process: { uptimeSeconds: number; rssMb: number; heapUsedMb: number; node: string };
  components: Array<{ code: string; label: string; status: "healthy" | "offline" | "not-configured"; detail: string }>;
  providers: Array<{ code: string; displayName: string; model: string; status: string; latencyMs?: number; lastError?: string }>;
  payment: { provider: string; label: string; mode: string; configuration: string; source: string; webhookUrl: string; finishRedirectUrl: string; apiReachability: string; connectionState: "healthy" | "failed" | "not-tested"; connectionCheckedAt: string | null; lastWebhookAt: string | null; lastSuccessfulPaymentAt: string | null; failedWebhookCount: number; signatureVerification: string };
  warnings: string[];
  errors: string[];
}

function statusClass(status: string): string {
  return status === "healthy" ? "status-tag healthy" : status === "offline" ? "status-tag danger-tag" : "status-tag muted-tag";
}

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export function AdminSystemHealth() {
  const [data, setData] = useState<HealthPayload | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => { setError(""); adminFetch<HealthPayload>("/api/admin/system-health").then(setData).catch((reason) => setError(reason.message)); }, []);
  useEffect(() => { load(); const timer = window.setInterval(load, 30_000); return () => window.clearInterval(timer); }, [load]);
  if (error && !data) return <><LocalModeNotice /><AdminError message={error} retry={load} /></>;
  if (!data) return <AdminLoading />;
  return <>
    <LocalModeNotice />
    {error && <AdminError message={error} retry={load} />}
    <div className="stats-grid">
      <StatCard label="API uptime" value={duration(data.process.uptimeSeconds)} detail={data.process.node} icon={Clock3} tone="blue" />
      <StatCard label="Process RSS" value={`${data.process.rssMb} MB`} detail={`${data.process.heapUsedMb} MB heap used`} icon={MemoryStick} />
      <StatCard label="Healthy components" value={`${data.components.filter((item) => item.status === "healthy").length}/${data.components.length}`} detail={`Checked ${formatDate(data.checkedAt)}`} icon={Activity} tone="amber" />
      <StatCard label="Provider health" value={String(data.providers.filter((item) => item.status === "healthy").length)} detail={`${data.providers.length} configured definitions`} icon={ServerCog} tone="coral" />
    </div>
    <section className="panel table-panel"><div className="panel-head"><div><p className="section-kicker">Runtime dependencies</p><h2>System health</h2><p>Status berasal dari process dan TCP dependency check, bukan sample dashboard.</p></div><button className="button button-secondary" onClick={load}>Refresh</button></div><div className="table-scroll"><table><thead><tr><th>Component</th><th>Status</th><th>Detail</th></tr></thead><tbody>{data.components.map((item) => <tr key={item.code}><td><strong>{item.label}</strong><small>{item.code}</small></td><td><span className={statusClass(item.status)}>{item.status}</span></td><td>{item.detail}</td></tr>)}</tbody></table></div></section>
    <section className="panel"><div className="panel-head"><div><p className="section-kicker">Payment gateway</p><h2>{data.payment.label}</h2><p>Informasi aman tanpa menampilkan credential atau webhook token.</p></div><span className={statusClass(data.payment.connectionState === "healthy" ? "healthy" : data.payment.connectionState === "failed" ? "offline" : "not-configured")}>{data.payment.mode}</span></div><div className="finance-grid compact-finance"><span><small>Configuration</small><strong>{data.payment.configuration}</strong></span><span><small>Connection test</small><strong>{data.payment.connectionState === "healthy" ? `Passed ${data.payment.connectionCheckedAt ? formatDate(data.payment.connectionCheckedAt) : ""}` : data.payment.connectionState === "failed" ? "Failed" : "Not run since API start"}</strong></span><span><small>Last paid</small><strong>{data.payment.lastSuccessfulPaymentAt ? formatDate(data.payment.lastSuccessfulPaymentAt) : "Belum ada"}</strong></span><span><small>Rejected webhooks</small><strong>{data.payment.failedWebhookCount}</strong></span></div><div className="callout info-callout"><span><strong>Notification URL:</strong> {data.payment.webhookUrl} · Signature: {data.payment.signatureVerification} · API: {data.payment.apiReachability}</span></div></section>
    <div className="two-column">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">AI dependencies</p><h2>Providers</h2></div></div>{data.providers.length ? <div className="readiness-list">{data.providers.map((provider) => <span key={provider.code}><i className={provider.status === "healthy" ? "ready" : "warning"} /><strong>{provider.displayName}</strong><small>{provider.model} · {provider.latencyMs ? `${provider.latencyMs} ms` : provider.status}</small></span>)}</div> : <div className="admin-empty"><Database size={22} /><strong>No active provider</strong><span>Configure a server-side provider key before live AI testing.</span></div>}</section>
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Readiness findings</p><h2>Warnings and errors</h2></div></div>{[...data.errors, ...data.warnings].length ? <div className="readiness-list">{data.errors.map((item) => <span key={item}><i className="warning" /><strong>Error</strong><small>{item}</small></span>)}{data.warnings.map((item) => <span key={item}><i className="warning" /><strong>Warning</strong><small>{item}</small></span>)}</div> : <div className="admin-empty"><strong>No config findings</strong><span>Runtime configuration checks passed.</span></div>}</section>
    </div>
  </>;
}
