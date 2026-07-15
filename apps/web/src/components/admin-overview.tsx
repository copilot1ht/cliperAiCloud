"use client";

import Link from "next/link";
import { Activity, ArrowRight, BadgeDollarSign, Route, ServerCog, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { adminFetch, formatIdr, formatUsd } from "@/lib/admin-api";
import { AdminError, AdminLoading, LocalModeNotice } from "@/components/admin-ui";
import { StatCard } from "@/components/stat-card";

interface OverviewData {
  mode: string;
  users: { total: number; members: number; active: number; suspended: number };
  providers: { total: number; ready: number; needsKey: number; items: Array<{ code: string; displayName: string; status: string; model: string; keyCount: number; latencyMs?: number }> };
  routing: { rules: number; enabled: number };
  revenue: { grossIdr: number; netIdr: number; paidCount: number; pendingCount: number };
  usage: { requests: number; providerCostUsd: number; billedCostUsd: number; grossMarginUsd: number; inputTokens: number; outputTokens: number };
  infrastructure: { databaseConfigured: boolean; redisConfigured: boolean; persistence: boolean };
}

export function AdminOverview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    adminFetch<OverviewData>("/api/admin/overview").then(setData).catch((reason) => setError(reason.message));
  }, []);
  useEffect(load, [load]);

  if (error) return <><LocalModeNotice /><AdminError message={error} retry={load} /></>;
  if (!data) return <AdminLoading />;
  return (
    <>
      <LocalModeNotice />
      <div className="stats-grid">
        <StatCard label="Active members" value={String(data.users.active)} detail={`${data.users.suspended} suspended`} icon={Users} tone="teal" />
        <StatCard label="Ready providers" value={`${data.providers.ready}/${data.providers.total}`} detail={`${data.providers.needsKey} need API key`} icon={ServerCog} tone="blue" />
        <StatCard label="Gateway requests" value={String(data.usage.requests)} detail={`${data.routing.enabled} routing rules enabled`} icon={Activity} tone="amber" />
        <StatCard label="Recorded revenue" value={formatIdr(data.revenue.netIdr)} detail={`${data.revenue.paidCount} paid payments`} icon={BadgeDollarSign} tone="coral" />
      </div>

      <div className="content-grid content-grid-main">
        <section className="panel">
          <div className="panel-head"><div><p className="section-kicker">Provider readiness</p><h2>AI gateway configuration</h2><p>Status ini berasal dari konfigurasi server saat ini, bukan angka contoh.</p></div><Link href="/admin/providers">Manage providers <ArrowRight size={13} /></Link></div>
          <div className="table-scroll"><table><thead><tr><th>Provider</th><th>Model</th><th>Key pool</th><th>Latency</th><th>Status</th></tr></thead><tbody>
            {data.providers.items.map((provider) => <tr key={provider.code}><td><strong>{provider.displayName}</strong><small>{provider.code}</small></td><td><code>{provider.model}</code></td><td>{provider.keyCount}</td><td>{provider.latencyMs ? `${provider.latencyMs} ms` : "Belum diuji"}</td><td><span className={provider.status === "healthy" ? "status-tag healthy" : "status-tag fallback"}>{provider.status}</span></td></tr>)}
          </tbody></table></div>
        </section>
        <section className="panel">
          <div className="panel-head"><div><p className="section-kicker">Local infrastructure</p><h2>Production dependencies</h2><p>Data admin belum persisten sampai PostgreSQL dan Redis aktif.</p></div></div>
          <div className="readiness-list">
            <span><i className="ready" /><strong>API gateway</strong><small>Active</small></span>
            <span><i className={data.infrastructure.databaseConfigured ? "warning" : "warning"} /><strong>PostgreSQL</strong><small>{data.infrastructure.persistence ? "Connected" : "Not connected"}</small></span>
            <span><i className={data.infrastructure.redisConfigured ? "warning" : "warning"} /><strong>Redis</strong><small>{data.infrastructure.redisConfigured ? "Configured" : "Not configured"}</small></span>
          </div>
        </section>
      </div>

      <div className="two-column">
        <section className="panel"><div className="panel-head"><div><p className="section-kicker">Unit economics</p><h2>AI cost and margin</h2><p>Nilai USD berasal dari request gateway yang benar-benar tercatat.</p></div><Link href="/admin/revenue">Open revenue <ArrowRight size={13} /></Link></div><div className="finance-grid compact-finance"><span><small>Provider cost</small><strong>{formatUsd(data.usage.providerCostUsd)}</strong></span><span><small>User billing</small><strong>{formatUsd(data.usage.billedCostUsd)}</strong></span><span><small>Gross margin</small><strong>{formatUsd(data.usage.grossMarginUsd)}</strong></span><span><small>Tokens</small><strong>{(data.usage.inputTokens + data.usage.outputTokens).toLocaleString("id-ID")}</strong></span></div></section>
        <section className="panel"><div className="panel-head"><div><p className="section-kicker">Routing control</p><h2>AI Router</h2><p>Router memilih primary provider dan otomatis pindah ke fallback jika request gagal.</p></div><Link href="/admin/ai-router">Configure <ArrowRight size={13} /></Link></div><div className="router-summary"><Route size={22} /><span><strong>{data.routing.enabled} rules active</strong><small>{data.routing.rules} total rules across all plans</small></span></div></section>
      </div>
    </>
  );
}
