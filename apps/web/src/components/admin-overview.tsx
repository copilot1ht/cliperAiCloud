"use client";

import Link from "next/link";
import { Activity, ArrowRight, BadgeDollarSign, CircleCheck, Route, ServerCog, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { adminFetch, formatDate, formatIdr, formatUsd } from "@/lib/admin-api";
import { AdminError, AdminLoading, EmptyState, LocalModeNotice } from "@/components/admin-ui";
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
  const [lastUpdated, setLastUpdated] = useState("");
  const inFlight = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setError("");
    try {
      const next = await adminFetch<OverviewData>("/api/admin/overview", { signal: controller.signal });
      setData(next);
      setLastUpdated(new Date().toISOString());
    } catch (reason) {
      if ((reason as { name?: string })?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "Overview tidak dapat dimuat.");
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      inFlight.current = false;
    }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      activeRequest.current?.abort();
    };
  }, [load]);

  if (error && !data) return <><LocalModeNotice /><AdminError message={error} retry={() => void load()} /></>;
  if (!data) return <AdminLoading />;
  return (
    <>
      {data.mode.includes("memory") && <LocalModeNotice />}
      {error && <AdminError message={error} retry={() => void load()} />}
      <div className="live-status"><i /> Live · diperbarui {lastUpdated ? formatDate(lastUpdated) : "..."}</div>
      <section className="admin-command">
        <div>
          <p className="section-kicker">Operations snapshot</p>
          <h2>Cloud control plane is responding.</h2>
          <span>Monitor member access, provider readiness, routing, payment, dan margin dari data server aktual.</span>
        </div>
        <div className="admin-command-status">
          <span><CircleCheck size={17} /><b>{data.users.active}</b><small>active members</small></span>
          <span><ServerCog size={17} /><b>{data.providers.ready}</b><small>ready providers</small></span>
          <span><Activity size={17} /><b>{data.routing.enabled}</b><small>active routes</small></span>
        </div>
      </section>
      <div className="stats-grid">
        <StatCard label="Active members" value={String(data.users.active)} detail={`${data.users.suspended} suspended`} icon={Users} tone="teal" />
        <StatCard label="Ready providers" value={`${data.providers.ready}/${data.providers.total}`} detail={`${data.providers.needsKey} need API key`} icon={ServerCog} tone="blue" />
        <StatCard label="Gateway requests" value={String(data.usage.requests)} detail={`${data.routing.enabled} routing rules enabled`} icon={Activity} tone="amber" />
        <StatCard label="Recorded revenue" value={formatIdr(data.revenue.netIdr)} detail={`${data.revenue.paidCount} paid payments`} icon={BadgeDollarSign} tone="coral" />
      </div>

      <div className="content-grid content-grid-main">
        <section className="panel">
          <div className="panel-head"><div><p className="section-kicker">Provider readiness</p><h2>AI gateway configuration</h2><p>Status ini berasal dari konfigurasi server saat ini, bukan angka contoh.</p></div><Link href="/admin/providers">Manage providers <ArrowRight size={13} /></Link></div>
          {data.providers.items.length ? <div className="table-scroll"><table><thead><tr><th>Provider</th><th>Model</th><th>Key pool</th><th>Latency</th><th>Status</th></tr></thead><tbody>
            {data.providers.items.map((provider) => <tr key={provider.code}><td><strong>{provider.displayName}</strong><small>{provider.code}</small></td><td><code>{provider.model}</code></td><td>{provider.keyCount}</td><td>{provider.latencyMs ? `${provider.latencyMs} ms` : "Belum diuji"}</td><td><span className={provider.status === "healthy" ? "status-tag healthy" : "status-tag fallback"}>{provider.status}</span></td></tr>)}
          </tbody></table></div> : <EmptyState title="Belum ada AI provider" detail="Tambahkan provider pertama di halaman Providers untuk mengaktifkan gateway." />}
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Local infrastructure</p>
              <h2>Production dependencies</h2>
              <p>
                {data.infrastructure.persistence
                  ? "PostgreSQL aktif. Redis digunakan untuk cache, antrean, dan rate limiting saat tersedia."
                  : "Data admin belum persisten sampai PostgreSQL aktif."}
              </p>
            </div>
          </div>
          <div className="readiness-list">
            <span><i className="ready" /><strong>API gateway</strong><small>Active</small></span>
            <span><i className={data.infrastructure.persistence ? "ready" : "warning"} /><strong>PostgreSQL</strong><small>{data.infrastructure.persistence ? "Connected" : "Not connected"}</small></span>
            <span><i className={data.infrastructure.redisConfigured ? "ready" : "warning"} /><strong>Redis</strong><small>{data.infrastructure.redisConfigured ? "Configured" : "Not configured"}</small></span>
          </div>
        </section>
      </div>

      <div className="two-column">
        <section className="panel"><div className="panel-head"><div><p className="section-kicker">Unit economics</p><h2>AI cost and margin</h2><p>Nilai USD berasal dari request gateway yang benar-benar tercatat.</p></div><Link href="/admin/revenue">Open revenue <ArrowRight size={13} /></Link></div><div className="finance-grid compact-finance"><span><small>Provider cost</small><strong>{formatUsd(data.usage.providerCostUsd)}</strong></span><span><small>User billing</small><strong>{formatUsd(data.usage.billedCostUsd)}</strong></span><span><small>Gross margin</small><strong>{formatUsd(data.usage.grossMarginUsd)}</strong></span><span><small>Tokens</small><strong>{(data.usage.inputTokens + data.usage.outputTokens).toLocaleString("id-ID")}</strong></span></div></section>
        <section className="panel"><div className="panel-head"><div><p className="section-kicker">Routing control</p><h2>AI Router</h2><p>Router memilih primary provider dan otomatis pindah ke fallback jika request gagal.</p></div><Link href="/admin/ai-router">Configure <ArrowRight size={13} /></Link></div><div className="router-summary"><Route size={22} /><span><strong>{data.routing.enabled} rules active</strong><small>{data.routing.rules} module rules</small></span></div></section>
      </div>
    </>
  );
}
