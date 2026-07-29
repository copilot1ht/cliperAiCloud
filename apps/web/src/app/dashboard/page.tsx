"use client";

import Link from "next/link";
import { Activity, ArrowRight, Coins, CreditCard, Key, Plus, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { StatCard } from "@/components/stat-card";
import { formatDate } from "@/lib/admin-api";
import { apiBase } from "@/lib/api-base";

interface MemberOverview {
  mode: string;
  user: { displayName: string; email: string; plan: string; deviceLimit: number; unlimitedCredits: boolean };
  credits: { balanceMicro: number; reservedMicro: number; availableMicro: number; spentMicro: number; unlimited: boolean };
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
    const apiUrl = apiBase();
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

  return <AppShell eyebrow="Workspace" title="Cliper Studio overview" actions={<Link className="button button-primary" href="/keys"><Plus size={17} /> Generate API Key</Link>}>
    {error && <section className="panel error-panel"><strong>Data belum tersedia</strong><p>{error}</p><button className="button" onClick={() => void load()}>Coba lagi</button></section>}
    {!data && !error && <section className="panel admin-loading"><span /> Memuat saldo dan usage...</section>}
    {data && <>
      <section className="member-hero">
        <div className="member-hero-copy">
          <p><Sparkles size={15} /> Cliper AI Cloud</p>
          <h2>Selamat datang, {data.user.displayName.split(/\s+/)[0]}.</h2>
          <span>Desktop key, AI usage, dan wallet Anda terhubung dalam satu workspace aman.</span>
          <div className="member-hero-actions">
            <Link className="button button-primary" href="/keys"><Key size={16} /> Kelola API key</Link>
            <Link className="button button-secondary" href="/topup"><CreditCard size={16} /> Top up credits</Link>
          </div>
        </div>
        <div className="member-balance">
          <small>Available AI credits</small>
          <strong>{data.credits.unlimited ? "Unlimited" : displayCredits(data.credits.availableMicro)}</strong>
          <span>{displayCredits(data.credits.reservedMicro)} reserved · {data.usage.requests.toLocaleString("id-ID")} requests</span>
          <Link href="/usage">Lihat penggunaan <ArrowRight size={14} /></Link>
        </div>
      </section>
      <div className="notice-line"><div><Zap size={17} /><span><strong>Satu Cliper key untuk desktop.</strong> Provider, harga internal, routing, dan fallback tetap aman di server Cliper AI Cloud.</span></div></div>
      <section className="stats-grid">
        <StatCard label="Wallet status" value={data.mode.includes("memory") ? "Local" : "Live"} detail={data.user.email} icon={ShieldCheck} tone="blue" />
        <StatCard label="Active API keys" value={String(data.keys.active)} detail={`${data.keys.total} key dibuat`} icon={Key} />
        <StatCard label="Bound devices" value={`${data.keys.devicesUsed} / ${data.user.deviceLimit}`} detail="Dihitung dari license aktif" icon={Activity} tone="amber" />
        <StatCard label="Available AI credits" value={data.credits.unlimited ? "Unlimited" : displayCredits(data.credits.availableMicro)} detail={data.credits.unlimited ? "Akun pengujian internal" : `${displayCredits(data.credits.reservedMicro)} sedang direservasi`} icon={Coins} tone="coral" />
      </section>
      <div className="content-grid member-content-grid">
        <section className="panel table-panel">
          <div className="panel-head"><div><p className="section-kicker">Actual usage</p><h2>Recent gateway requests</h2><p>User hanya melihat debit credits. Provider cost dan markup tetap internal.</p></div><span className="status-tag fallback">{data.mode.includes("memory") ? "Preview store" : "Live"}</span></div>
          {data.usage.recent.length ? <div className="table-scroll"><table><thead><tr><th>Module</th><th>Tokens</th><th>Credits</th><th>Time</th></tr></thead><tbody>{data.usage.recent.map((item) => <tr key={item.id}><td><strong>{item.module}</strong></td><td>{item.tokens.toLocaleString("id-ID")}</td><td>{displayCredits(item.creditChargeMicro)}</td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table></div> : <div className="admin-empty"><Activity size={21} /><strong>Belum ada AI request</strong><span>Aktivitas akan muncul setelah Cliper Studio menggunakan AI Gateway.</span></div>}
        </section>
        <section className="panel activation-panel">
          <div className="panel-head"><div><p className="section-kicker">Desktop activation</p><h2>Connect Cliper Studio</h2><p>Key portal dapat dipakai langsung oleh License API dan AI Gateway.</p></div><Link href="/keys">Manage keys</Link></div>
          <div className="readiness-list activation-steps"><span><i className="ready" /><strong>Generate API key</strong><small>Ditampilkan satu kali</small></span><span><i className="ready" /><strong>Paste di desktop</strong><small>Settings · API</small></span><span><i className="ready" /><strong>Verify license</strong><small>Account & device</small></span><span><i className="ready" /><strong>Start clipping</strong><small>Usage billed otomatis</small></span></div>
        </section>
      </div>
    </>}
  </AppShell>;
}
