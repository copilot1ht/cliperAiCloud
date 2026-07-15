"use client";

import Link from "next/link";
import { Activity, Coins, Key, Plus, ShieldCheck, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { StatCard } from "@/components/stat-card";
import { formatDate } from "@/lib/admin-api";

interface MemberOverview {
  mode: string;
  user: { displayName: string; email: string; plan: string; deviceLimit: number };
  credits: { balanceMicro: number; reservedMicro: number; availableMicro: number; spentMicro: number };
  keys: { total: number; active: number; devicesUsed: number };
  usage: { requests: number; inputTokens: number; outputTokens: number; creditChargeMicro: number; recent: Array<{ id: string; module: string; tokens: number; creditChargeMicro: number; createdAt: string }> };
}

function displayCredits(micro: number): string {
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(Number(micro || 0) / 1_000_000);
}

export default function DashboardPage() {
  const [data, setData] = useState<MemberOverview | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const apiUrl = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4100").replace(/\/$/, "");
    try {
      const response = await fetch(`${apiUrl}/api/member/overview`, { cache: "no-store", credentials: "include" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Dashboard tidak dapat dimuat.");
      setData(payload); setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Dashboard tidak dapat dimuat.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <AppShell eyebrow="Dashboard" title="License & usage overview" actions={<Link className="button button-primary" href="/keys"><Plus size={17} /> Generate API Key</Link>}>
    <div className="notice-line"><div><Zap size={17} /><span><strong>Satu Cliper key untuk desktop.</strong> Provider, harga internal, routing, dan fallback tetap aman di server Cliper AI Cloud.</span></div></div>
    {error && <section className="panel error-panel"><strong>Data belum tersedia</strong><p>{error}</p><button className="button" onClick={() => void load()}>Coba lagi</button></section>}
    {!data && !error && <section className="panel admin-loading"><span /> Memuat saldo dan usage...</section>}
    {data && <>
      <section className="stats-grid">
        <StatCard label="Active plan" value={data.user.plan.toUpperCase()} detail={data.user.email} icon={ShieldCheck} tone="blue" />
        <StatCard label="Active API keys" value={String(data.keys.active)} detail={`${data.keys.total} key dibuat`} icon={Key} />
        <StatCard label="Bound devices" value={`${data.keys.devicesUsed} / ${data.user.deviceLimit}`} detail="Dihitung dari license aktif" icon={Activity} tone="amber" />
        <StatCard label="Available credits" value={displayCredits(data.credits.availableMicro)} detail={`${displayCredits(data.credits.reservedMicro)} sedang direservasi`} icon={Coins} tone="coral" />
      </section>
      <section className="panel">
        <div className="panel-head"><div><p className="section-kicker">Desktop activation</p><h2>Connect Cliper Studio</h2><p>Key yang dibuat di portal sudah dapat dipakai langsung oleh License API dan AI Gateway.</p></div><Link href="/keys">Manage keys</Link></div>
        <div className="readiness-list"><span><i className="ready" /><strong>1. Generate API key</strong><small>Key rahasia hanya ditampilkan satu kali.</small></span><span><i className="ready" /><strong>2. Paste di desktop</strong><small>Masukkan key pada Settings Cliper Studio.</small></span><span><i className="ready" /><strong>3. Verify license</strong><small>Server memeriksa pemilik, status, device, plan, dan saldo.</small></span><span><i className="ready" /><strong>4. Start clipping</strong><small>Biaya aktual dikonversi menjadi Cliper Credits.</small></span></div>
      </section>
      <section className="panel table-panel">
        <div className="panel-head"><div><p className="section-kicker">Actual usage</p><h2>Recent gateway requests</h2><p>User hanya melihat debit credits. Provider cost dan markup tetap internal.</p></div><span className="status-tag fallback">{data.mode === "development-memory" ? "Local test mode" : "Live"}</span></div>
        {data.usage.recent.length ? <div className="table-scroll"><table><thead><tr><th>Module</th><th>Tokens</th><th>Credits</th><th>Time</th></tr></thead><tbody>{data.usage.recent.map((item) => <tr key={item.id}><td><strong>{item.module}</strong></td><td>{item.tokens.toLocaleString("id-ID")}</td><td>{displayCredits(item.creditChargeMicro)}</td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table></div> : <div className="admin-empty"><strong>Belum ada AI request</strong><span>Usage akan muncul setelah desktop mengirim request melalui Cliper API key ini.</span></div>}
      </section>
    </>}
  </AppShell>;
}
