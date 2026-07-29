"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, BadgeDollarSign, CheckCircle2, CircleDollarSign, Coins, ReceiptText, Save, ShieldCheck } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { adminFetch, formatDate, formatIdr, formatUsd, type PricingPolicy } from "@/lib/admin-api";
import { AdminError, AdminLoading, LocalModeNotice } from "@/components/admin-ui";
import { StatCard } from "@/components/stat-card";

interface RevenuePayload {
  mode: string;
  payment: { grossIdr: number; refundedIdr: number; netIdr: number; paidCount: number; pendingCount: number; failedCount: number };
  usage: { requests: number; inputTokens: number; outputTokens: number; providerCostUsd: number; serviceCostUsd: number; billedCostUsd: number; grossMarginUsd: number; creditChargeMicro: number; recent: Array<{ id: string; accountEmail?: string; provider: string; model: string; module: string; providerCostUsd: number; serviceCostUsd: number; billedCostUsd: number; grossProfitUsd: number; creditChargeMicro: number; markupBps: number; createdAt: string }> };
  grossMarginUsd: number;
  marginRate: number;
  pricing: PricingPolicy;
  pricingValidation: PricingValidation;
  simulation: PricingQuote;
  jobBilling: {
    storage: "memory" | "postgres";
    total: number;
    active: number;
    completed: number;
    failed: number;
    providerCostIdr: number;
    customerRevenueIdr: number;
    grossProfitIdr: number;
    creditsCharged: number;
    recent: Array<{
      id: string;
      status: "active" | "completed" | "failed";
      sourceId: string;
      requestedClipCount: number;
      providerCostIdr: number;
      internalCostIdr: number;
      grossProfitIdr: number;
      finalChargeCredits: number;
      releasedCredits: number;
      requestCount: number;
      budgetStatus: string;
      createdAt: string;
    }>;
  };
}

interface PricingValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  hardLimitProtectedCredits: number;
}

interface PricingQuote {
  providerCostIdr: number;
  internalCostIdr: number;
  qualityPriceCredits: number;
  protectedPriceCredits: number;
  finalChargeCredits: number;
  reservationCredits: number;
  grossProfitIdr: number;
  grossMarginBps: number;
  acceptedClipCount: number;
  rejectedClipCount: number;
  capApplied: boolean;
  capSafe: boolean;
  budgetStatus: string;
  tierCounts: { rejected: number; optional: number; good: number; premium: number };
}

const jobPolicyKeys = [
  "creditValueIdr", "minimumGrossMarginBps", "targetGrossMarginBps", "baseAnalysisCredits",
  "optionalClipCredits", "goodClipCredits", "premiumClipCredits", "optionalScoreMin", "goodScoreMin",
  "premiumScoreMin", "minimumJobCredits", "maximumJobCredits", "infrastructureFeeIdr", "safetyBufferBps",
  "retryAllowanceBps", "paymentFeeAllocationBps", "targetProviderCostIdr", "warningProviderCostIdr",
  "hardProviderCostIdr", "lowBalanceWarningCredits", "usdToIdr",
] as const;

function jobPolicyPayload(policy: PricingPolicy) {
  return Object.fromEntries(jobPolicyKeys.map((key) => [key, policy[key]]));
}

function PricingPolicyEditor({ policy, initialQuote, initialValidation, onSaved }: { policy: PricingPolicy; initialQuote: PricingQuote; initialValidation: PricingValidation; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState(policy);
  const [providerCostIdr, setProviderCostIdr] = useState(policy.targetProviderCostIdr);
  const [scoreText, setScoreText] = useState("72, 80, 84, 91, 93");
  const [quote, setQuote] = useState(initialQuote);
  const [validation, setValidation] = useState(initialValidation);
  useEffect(() => { setDraft(policy); setProviderCostIdr(policy.targetProviderCostIdr); }, [policy]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const clipScores = scoreText.split(/[\s,;]+/).map(Number).filter(Number.isFinite).map((score) => Math.max(0, Math.min(100, score)));
      adminFetch<{ quote?: PricingQuote; validation: PricingValidation }>("/api/admin/pricing/simulate", {
        method: "POST",
        body: JSON.stringify({ providerCostIdr, clipScores, usableResult: clipScores.length > 0, policy: jobPolicyPayload(draft) }),
      }).then((result) => {
        setValidation(result.validation);
        if (result.quote) setQuote(result.quote);
      }).catch((reason) => setMessage(reason instanceof Error ? reason.message : "Simulasi pricing gagal."));
    }, 280);
    return () => window.clearTimeout(timer);
  }, [draft, providerCostIdr, scoreText]);
  const setNumber = (key: keyof PricingPolicy, value: string) => setDraft((current) => ({ ...current, [key]: Number(value || 0) }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setMessage("");
    try { await adminFetch("/api/admin/pricing", { method: "PATCH", body: JSON.stringify(jobPolicyPayload(draft)) }); setMessage("Kebijakan pricing per-job tersimpan."); onSaved(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : "Pricing policy gagal disimpan."); }
    finally { setSaving(false); }
  };
  return <section className="panel pricing-panel"><div className="panel-head"><div><p className="section-kicker">Job-based billing</p><h2>Pricing Engine</h2><p>Satu link memakai satu reservation dan satu settlement. Token provider tetap dicatat per request, tetapi user tidak ditagih berulang.</p></div><span className={`pricing-health ${validation.valid ? "safe" : "unsafe"}`}>{validation.valid ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{validation.valid ? "Profit guard active" : "Policy unsafe"}</span></div>
    <form className="job-pricing-form" onSubmit={submit}>
      <div className="pricing-settings-grid">
        <fieldset className="pricing-section"><legend>User price</legend><p>Nilai credit dan batas biaya yang terlihat user.</p>
          <label className="field-label">1 credit bernilai<input type="number" min={1} value={draft.creditValueIdr} onChange={(event) => setNumber("creditValueIdr", event.target.value)} /><em>Rp</em></label>
          <label className="field-label">Biaya analisis dasar<input type="number" min={0} value={draft.baseAnalysisCredits} onChange={(event) => setNumber("baseAnalysisCredits", event.target.value)} /><em>credit</em></label>
          <div className="pricing-pair"><label className="field-label">Minimum job<input type="number" min={0} value={draft.minimumJobCredits} onChange={(event) => setNumber("minimumJobCredits", event.target.value)} /><em>credit</em></label><label className="field-label">Maximum job<input type="number" min={1} value={draft.maximumJobCredits} onChange={(event) => setNumber("maximumJobCredits", event.target.value)} /><em>credit</em></label></div>
          <label className="field-label">Peringatan saldo rendah<input type="number" min={0} value={draft.lowBalanceWarningCredits} onChange={(event) => setNumber("lowBalanceWarningCredits", event.target.value)} /><em>credit</em></label>
        </fieldset>
        <fieldset className="pricing-section"><legend>Clip value</legend><p>Clip di bawah threshold Optional ditolak dan tidak menambah biaya.</p>
          <div className="tier-row optional"><span>Optional</span><label>Score <input type="number" min={0} max={100} value={draft.optionalScoreMin} onChange={(event) => setNumber("optionalScoreMin", event.target.value)} /></label><label>Biaya <input type="number" min={0} value={draft.optionalClipCredits} onChange={(event) => setNumber("optionalClipCredits", event.target.value)} /></label></div>
          <div className="tier-row good"><span>Good</span><label>Score <input type="number" min={0} max={100} value={draft.goodScoreMin} onChange={(event) => setNumber("goodScoreMin", event.target.value)} /></label><label>Biaya <input type="number" min={0} value={draft.goodClipCredits} onChange={(event) => setNumber("goodClipCredits", event.target.value)} /></label></div>
          <div className="tier-row premium"><span>Premium</span><label>Score <input type="number" min={0} max={100} value={draft.premiumScoreMin} onChange={(event) => setNumber("premiumScoreMin", event.target.value)} /></label><label>Biaya <input type="number" min={0} value={draft.premiumClipCredits} onChange={(event) => setNumber("premiumClipCredits", event.target.value)} /></label></div>
        </fieldset>
        <fieldset className="pricing-section"><legend>Cost protection</legend><p>Gross margin memakai rumus cost ÷ (1 − margin), bukan cost + margin.</p>
          <label className="field-label">Target gross margin<input type="number" min={50} max={90} step={1} value={draft.targetGrossMarginBps / 100} onChange={(event) => setNumber("targetGrossMarginBps", String(Number(event.target.value) * 100))} /><em>%</em></label>
          <div className="pricing-pair"><label className="field-label">Infrastructure<input type="number" min={0} value={draft.infrastructureFeeIdr} onChange={(event) => setNumber("infrastructureFeeIdr", event.target.value)} /><em>Rp</em></label><label className="field-label">USD rate<input type="number" min={1} value={draft.usdToIdr} onChange={(event) => setNumber("usdToIdr", event.target.value)} /><em>Rp</em></label></div>
          <div className="pricing-pair"><label className="field-label">Safety buffer<input type="number" min={0} max={100} step={0.5} value={draft.safetyBufferBps / 100} onChange={(event) => setNumber("safetyBufferBps", String(Number(event.target.value) * 100))} /><em>%</em></label><label className="field-label">Retry allowance<input type="number" min={0} max={100} step={0.5} value={draft.retryAllowanceBps / 100} onChange={(event) => setNumber("retryAllowanceBps", String(Number(event.target.value) * 100))} /><em>%</em></label></div>
          <div className="provider-budget-row"><label>Target <input type="number" min={0} value={draft.targetProviderCostIdr} onChange={(event) => setNumber("targetProviderCostIdr", event.target.value)} /></label><label>Warning <input type="number" min={0} value={draft.warningProviderCostIdr} onChange={(event) => setNumber("warningProviderCostIdr", event.target.value)} /></label><label>Hard <input type="number" min={0} value={draft.hardProviderCostIdr} onChange={(event) => setNumber("hardProviderCostIdr", event.target.value)} /></label></div>
        </fieldset>
      </div>
      <div className="pricing-simulator">
        <div className="simulator-inputs"><div><p className="section-kicker">Live server simulation</p><h3>Uji satu link sebelum disimpan</h3></div><label>Biaya provider (IDR)<input type="number" min={0} value={providerCostIdr} onChange={(event) => setProviderCostIdr(Number(event.target.value || 0))} /></label><label>Score clip<input value={scoreText} onChange={(event) => setScoreText(event.target.value)} placeholder="72, 80, 91" /></label></div>
        <div className="simulation-metrics"><span><small>Clip diterima</small><strong>{quote.acceptedClipCount}</strong><em>{quote.rejectedClipCount} ditolak</em></span><span><small>Harga berdasarkan kualitas</small><strong>{quote.qualityPriceCredits.toLocaleString("id-ID")}</strong><em>credits</em></span><span><small>Harga terlindungi</small><strong>{quote.protectedPriceCredits.toLocaleString("id-ID")}</strong><em>credits</em></span><span className="result"><small>Final charge</small><strong>{quote.finalChargeCredits.toLocaleString("id-ID")}</strong><em>{(quote.grossMarginBps / 100).toFixed(1)}% margin</em></span></div>
        <div className="simulation-foot"><span><ShieldCheck size={15} /> Reserve {quote.reservationCredits.toLocaleString("id-ID")} · release otomatis setelah settlement</span><span className={`budget-${quote.budgetStatus}`}>Provider {formatIdr(quote.providerCostIdr)} · profit {formatIdr(quote.grossProfitIdr)}</span></div>
      </div>
      {!validation.valid && <div className="pricing-errors"><AlertTriangle size={16} /><div>{validation.errors.map((error) => <p key={error}>{error}</p>)}</div></div>}
      {validation.valid && validation.warnings.length > 0 && <div className="pricing-warnings"><AlertTriangle size={15} /><span>{validation.warnings.join(" ")}</span></div>}
      <div className="pricing-actions"><span>Protected cost pada hard limit: {validation.hardLimitProtectedCredits.toLocaleString("id-ID")} credits</span><button className="button button-primary" disabled={saving || !validation.valid}><Save size={15} /> {saving ? "Menyimpan..." : "Simpan pricing"}</button></div>
    </form>{message && <p className="form-status">{message}</p>}</section>;
}

export function AdminRevenue() {
  const [data, setData] = useState<RevenuePayload | null>(null);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");
  const load = useCallback(() => { setError(""); adminFetch<RevenuePayload>("/api/admin/revenue").then((next) => { setData(next); setLastUpdated(new Date().toISOString()); }).catch((reason) => setError(reason.message)); }, []);
  useEffect(() => { load(); const timer = window.setInterval(load, 15_000); return () => window.clearInterval(timer); }, [load]);
  if (error) return <><LocalModeNotice /><AdminError message={error} retry={load} /></>;
  if (!data) return <AdminLoading />;
  return <>
    <LocalModeNotice />
    <div className="live-status"><i /> Live · {data.jobBilling.storage === "postgres" ? "PostgreSQL ledger" : "local memory trial"} · diperbarui {lastUpdated ? formatDate(lastUpdated) : "..."}</div>
    {data.jobBilling.storage === "memory" && <div className="pricing-warnings"><AlertTriangle size={15} /><span>Mode uji lokal: job dan wallet akan kembali ke nilai awal ketika API restart. Gunakan PostgreSQL untuk staging dan production.</span></div>}
    <div className="stats-grid">
      <StatCard label="Customer payments" value={formatIdr(data.payment.grossIdr)} detail={`${data.payment.paidCount} settled payments`} icon={ReceiptText} tone="teal" />
      <StatCard label="Net payment revenue" value={formatIdr(data.payment.netIdr)} detail={`${formatIdr(data.payment.refundedIdr)} refunded`} icon={CircleDollarSign} tone="blue" />
      <StatCard label="Analysis job revenue" value={formatIdr(data.jobBilling.customerRevenueIdr)} detail={`${data.jobBilling.completed} settled jobs`} icon={Coins} tone="amber" />
      <StatCard label="Analysis gross profit" value={formatIdr(data.jobBilling.grossProfitIdr)} detail={`${data.jobBilling.active} active · ${data.jobBilling.failed} failed`} icon={BadgeDollarSign} tone="coral" />
    </div>
    <div className="two-column">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Revenue definition</p><h2>One job, one settlement</h2><p>User billing dihitung per link. Request AI di dalam job hanya mengumpulkan biaya aktual dan tidak memotong wallet berulang.</p></div></div><div className="economics-equation"><span><small>User billing</small><strong>{formatIdr(data.jobBilling.customerRevenueIdr)}</strong></span><b>−</b><span><small>Provider cost</small><strong>{formatIdr(data.jobBilling.providerCostIdr)}</strong></span><b>=</b><span className="result"><small>Gross profit</small><strong>{formatIdr(data.jobBilling.grossProfitIdr)}</strong></span></div></section>
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Payment operations</p><h2>Incoming money is managed separately</h2><p>Admin tidak membeli paket. Halaman Payments dipakai untuk rekonsiliasi pembayaran user, refund, dan status transaksi.</p></div><Link href="/admin/payments">Open payments <ArrowRight size={13} /></Link></div><div className="finance-grid compact-finance"><span><small>Paid</small><strong>{data.payment.paidCount}</strong></span><span><small>Pending</small><strong>{data.payment.pendingCount}</strong></span><span><small>Failed</small><strong>{data.payment.failedCount}</strong></span><span><small>Refunded</small><strong>{formatIdr(data.payment.refundedIdr)}</strong></span></div></section>
    </div>
    <PricingPolicyEditor policy={data.pricing} initialQuote={data.simulation} initialValidation={data.pricingValidation} onSaved={load} />
    <section className="panel"><div className="panel-head"><div><p className="section-kicker">Job settlement ledger</p><h2>Recent analysis jobs</h2><p>Reservation, charge, release, dan biaya provider ditampilkan per link untuk audit margin.</p></div></div>{data.jobBilling.recent.length ? <div className="table-scroll"><table><thead><tr><th>Status</th><th>Created</th><th>AI calls</th><th>Provider cost</th><th>Charged</th><th>Released</th><th>Profit</th><th>Budget</th></tr></thead><tbody>{data.jobBilling.recent.map((item) => <tr key={item.id}><td><strong>{item.status}</strong></td><td>{formatDate(item.createdAt)}</td><td>{item.requestCount}</td><td>{formatIdr(item.providerCostIdr)}</td><td>{item.finalChargeCredits.toLocaleString("id-ID")} cr</td><td>{item.releasedCredits.toLocaleString("id-ID")} cr</td><td>{formatIdr(item.grossProfitIdr)}</td><td><code>{item.budgetStatus}</code></td></tr>)}</tbody></table></div> : <div className="admin-empty"><strong>Belum ada analysis job</strong><span>Uji Find Highlight dari Cliper Studio untuk melihat reserve → settle → release secara nyata.</span></div>}</section>
    <section className="panel"><div className="panel-head"><div><p className="section-kicker">Provider usage</p><h2>Recent internal AI requests</h2><p>Biaya provider dicatat per request. User charge bernilai nol selama request menjadi bagian dari analysis job karena settlement dilakukan sekali di tabel job.</p></div></div>{data.usage.recent.length ? <div className="table-scroll"><table><thead><tr><th>User</th><th>Module</th><th>Provider</th><th>Model</th><th>Provider cost</th><th>Service cost</th><th>User charge</th><th>Gross profit</th><th>Credits</th></tr></thead><tbody>{data.usage.recent.map((item) => <tr key={item.id}><td>{item.accountEmail || "-"}</td><td><strong>{item.module}</strong></td><td>{item.provider}</td><td><code>{item.model}</code></td><td>{formatUsd(item.providerCostUsd)}</td><td>{formatUsd(item.serviceCostUsd)}</td><td>{formatUsd(item.billedCostUsd)}</td><td>{formatUsd(item.grossProfitUsd)}</td><td>{item.creditChargeMicro.toLocaleString("id-ID")}</td></tr>)}</tbody></table></div> : <div className="admin-empty"><strong>No gateway usage yet</strong><span>Jalankan request AI dari Cliper Studio untuk melihat biaya provider aktual.</span></div>}</section>
  </>;
}
