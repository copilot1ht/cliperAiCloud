"use client";

import { Activity, Coins, Download, Gauge, Timer } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { StatCard } from "@/components/stat-card";
import { formatDate } from "@/lib/admin-api";
import { apiBase } from "@/lib/api-base";
import { formatUsdMicro } from "@/lib/money";

interface MemberUsagePayload {
  mode: string;
  wallet: { spendableMicroUsd: number; spentMicroUsd: number };
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    chargedMicroUsd: number;
    averageLatencyMs: number;
    p95LatencyMs: number;
    recent: Array<{ id: string; module: string; tokens: number; latencyMs: number; chargedMicroUsd: number; createdAt: string }>;
  };
}

const credits = formatUsdMicro;

export default function UsagePage() {
  const [data, setData] = useState<MemberUsagePayload | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const base = apiBase();
    try {
      const response = await fetch(`${base}/api/member/overview`, { cache: "no-store", credentials: "include" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Usage tidak dapat dimuat.");
      setData(payload); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Usage tidak dapat dimuat."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const exportCsv = () => {
    if (!data?.usage.recent.length) return;
  const rows = [["module", "tokens", "latency_ms", "wallet_usd", "created_at"], ...data.usage.recent.map((item) => [item.module, item.tokens, item.latencyMs, credits(item.chargedMicroUsd), item.createdAt])];
    const blob = new Blob([rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "cliper-usage.csv"; link.click(); URL.revokeObjectURL(url);
  };

  return <AppShell eyebrow="Consumption" title="Usage & wallet" actions={<button className="button button-secondary" onClick={exportCsv} disabled={!data?.usage.recent.length}><Download size={16} /> Export CSV</button>}>
    <div className="notice-line"><div><Activity size={17} /><span><strong>Account-scoped usage.</strong> Data hanya berasal dari request milik account ini. Provider cost dan markup tetap internal.</span></div></div>
    {error && <section className="panel error-panel"><strong>Usage gagal dimuat</strong><p>{error}</p><button className="button" onClick={() => void load()}>Coba lagi</button></section>}
    {!data && !error && <section className="panel admin-loading"><span /> Memuat usage...</section>}
    {data && <>
      <section className="stats-grid">
        <StatCard label="Total tokens" value={(data.usage.inputTokens + data.usage.outputTokens).toLocaleString("id-ID")} detail={`${data.usage.inputTokens.toLocaleString("id-ID")} input · ${data.usage.outputTokens.toLocaleString("id-ID")} output`} icon={Activity} />
        <StatCard label="Average latency" value={`${data.usage.averageLatencyMs} ms`} detail={`P95 ${data.usage.p95LatencyMs} ms`} icon={Timer} tone="blue" />
        <StatCard label="Completed requests" value={String(data.usage.requests)} detail="Successfully billed gateway calls" icon={Gauge} tone="amber" />
        <StatCard label="Wallet spent" value={credits(data.usage.chargedMicroUsd)} detail={`${credits(data.wallet.spendableMicroUsd)} available`} icon={Coins} tone="coral" />
      </section>
      <section className="panel table-panel"><div className="panel-head"><div><p className="section-kicker">Immutable usage view</p><h2>Recent activity</h2><p>Semua biaya wallet dicatat dalam USD mikro di server.</p></div><button className="button button-secondary" onClick={() => void load()}>Refresh</button></div>{data.usage.recent.length ? <div className="table-scroll"><table><thead><tr><th>Module</th><th>Tokens</th><th>Latency</th><th>Wallet USD</th><th>Time</th></tr></thead><tbody>{data.usage.recent.map((item) => <tr key={item.id}><td><strong>{item.module}</strong></td><td>{item.tokens.toLocaleString("id-ID")}</td><td>{item.latencyMs} ms</td><td>{credits(item.chargedMicroUsd)}</td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table></div> : <div className="admin-empty"><strong>Belum ada request</strong><span>Aktivitas akan muncul setelah Cliper Studio menggunakan AI Gateway.</span></div>}</section>
    </>}
  </AppShell>;
}
