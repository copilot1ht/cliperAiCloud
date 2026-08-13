"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BadgeDollarSign,
  CheckCircle2,
  CircleDollarSign,
  Coins,
  ReceiptText,
  Save,
  ShieldCheck,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { adminFetch, formatDate, formatIdr, type PricingPolicy } from "@/lib/admin-api";
import { AdminError, AdminLoading } from "@/components/admin-ui";
import { StatCard } from "@/components/stat-card";

interface PricingValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  hardLimitProtectedMicroUsd: number;
  hardLimitProtectedIdr: number;
}

interface PricingQuote {
  providerCostMicroUsd: number;
  internalCostMicroUsd: number;
  protectedChargeMicroUsd: number;
  userChargeMicroUsd: number;
  reservationMicroUsd: number;
  reservationCapped: boolean;
  grossProfitMicroUsd: number;
  providerCostIdr: number;
  internalCostIdr: number;
  protectedChargeIdr: number;
  userChargeIdr: number;
  reservationIdr: number;
  grossProfitIdr: number;
  grossMarginBps: number;
  capSafe: boolean;
  budgetStatus: string;
}

interface RevenuePayload {
  payment: {
    grossIdr: number;
    refundedIdr: number;
    netIdr: number;
    paidCount: number;
    pendingCount: number;
    failedCount: number;
  };
  usage: {
    recent: Array<{
      id: string;
      accountEmail?: string;
      provider: string;
      model: string;
      module: string;
      providerCostUsd: number;
      serviceCostUsd: number;
      billedCostUsd: number;
      grossProfitUsd: number;
      createdAt: string;
    }>;
  };
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
    recent: Array<{
      id: string;
      status: "active" | "completed" | "failed";
      requestedClipCount: number;
      providerCostIdr: number;
      internalCostIdr: number;
      finalChargeIdr: number;
      releasedIdr: number;
      grossProfitIdr: number;
      requestCount: number;
      budgetStatus: string;
      createdAt: string;
    }>;
  };
}

const jobPolicyKeys = [
  "minimumMarginBps",
  "targetMarginBps",
  "infrastructureCostMicroUsd",
  "paymentFeeBps",
  "safetyBufferBps",
  "retryAllowanceBps",
  "minimumJobChargeMicroUsd",
  "maximumJobChargeMicroUsd",
  "reservationHeadroomBps",
  "targetProviderCostMicroUsd",
  "warningProviderCostMicroUsd",
  "hardProviderCostMicroUsd",
  "lowBalanceWarningMicroUsd",
  "usdToIdr",
] as const;

function jobPolicyPayload(policy: PricingPolicy) {
  return Object.fromEntries(jobPolicyKeys.map((key) => [key, policy[key]]));
}

function microUsdToIdr(value: number, rate: number) {
  const raw = Number(value || 0) * Math.max(1, Number(rate || 1)) / 1_000_000;
  return raw < 0 ? Math.floor(raw) : Math.ceil(raw);
}

function idrToMicroUsd(value: number, rate: number) {
  return Math.max(0, Math.round(Number(value || 0) * 1_000_000 / Math.max(1, Number(rate || 1))));
}

function percentage(value: number) {
  return Number(value || 0) / 100;
}

function PricingPolicyEditor({
  policy,
  initialQuote,
  initialValidation,
  onSaved,
}: {
  policy: PricingPolicy;
  initialQuote: PricingQuote;
  initialValidation: PricingValidation;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState(policy);
  const [providerCostIdr, setProviderCostIdr] = useState(
    microUsdToIdr(policy.targetProviderCostMicroUsd, policy.usdToIdr),
  );
  const [usableResult, setUsableResult] = useState(true);
  const [quote, setQuote] = useState(initialQuote);
  const [validation, setValidation] = useState(initialValidation);

  useEffect(() => {
    setDraft(policy);
    setProviderCostIdr(microUsdToIdr(policy.targetProviderCostMicroUsd, policy.usdToIdr));
  }, [policy]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      adminFetch<{ quote?: PricingQuote; validation: PricingValidation }>("/api/admin/pricing/simulate", {
        method: "POST",
        body: JSON.stringify({
          providerCostIdr,
          usableResult,
          policy: jobPolicyPayload(draft),
        }),
      })
        .then((result) => {
          setValidation(result.validation);
          if (result.quote) setQuote(result.quote);
        })
        .catch((reason) => setMessage(reason instanceof Error ? reason.message : "Simulasi pricing gagal."));
    }, 280);
    return () => window.clearTimeout(timer);
  }, [draft, providerCostIdr, usableResult]);

  const setNumber = (key: keyof PricingPolicy, value: string) => {
    setDraft((current) => ({ ...current, [key]: Number(value || 0) }));
  };
  const setIdrMicro = (key: keyof PricingPolicy, value: string) => {
    setDraft((current) => ({
      ...current,
      [key]: idrToMicroUsd(Number(value || 0), current.usdToIdr),
    }));
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      await adminFetch("/api/admin/pricing", {
        method: "PATCH",
        body: JSON.stringify(jobPolicyPayload(draft)),
      });
      setMessage("Kebijakan biaya per-job tersimpan.");
      onSaved();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Pricing policy gagal disimpan.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel pricing-panel">
      <div className="panel-head">
        <div>
          <p className="section-kicker">Job-based billing</p>
          <h2>Pricing Engine</h2>
          <p>Saldo pengguna dicatat dalam USD. Semua angka administrasi di bawah dikonversi ke rupiah untuk memudahkan pemantauan margin.</p>
        </div>
        <span className={`pricing-health ${validation.valid ? "safe" : "unsafe"}`}>
          {validation.valid ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          {validation.valid ? "Profit guard active" : "Policy unsafe"}
        </span>
      </div>
      <form className="job-pricing-form" onSubmit={submit}>
        <div className="pricing-settings-grid">
          <fieldset className="pricing-section">
            <legend>Harga pengguna</legend>
            <p>Biaya diproteksi sebelum provider dipanggil. Score editorial tidak mengubah harga.</p>
            <div className="pricing-pair">
              <label className="field-label">Minimum job<input type="number" min={0} value={microUsdToIdr(draft.minimumJobChargeMicroUsd, draft.usdToIdr)} onChange={(event) => setIdrMicro("minimumJobChargeMicroUsd", event.target.value)} /><em>Rp</em></label>
              <label className="field-label">Ceiling tagihan job<input type="number" min={1} value={microUsdToIdr(draft.maximumJobChargeMicroUsd, draft.usdToIdr)} onChange={(event) => setIdrMicro("maximumJobChargeMicroUsd", event.target.value)} /><em>Rp</em></label>
            </div>
            <label className="field-label">Headroom reservasi<input type="number" min={0} max={100} step={1} value={percentage(draft.reservationHeadroomBps)} onChange={(event) => setNumber("reservationHeadroomBps", String(Number(event.target.value) * 100))} /><em>%</em></label>
            <label className="field-label">Peringatan saldo rendah<input type="number" min={0} value={microUsdToIdr(draft.lowBalanceWarningMicroUsd, draft.usdToIdr)} onChange={(event) => setIdrMicro("lowBalanceWarningMicroUsd", event.target.value)} /><em>Rp</em></label>
            <label className="field-label">Kurs USD ke IDR<input type="number" min={1} value={draft.usdToIdr} onChange={(event) => setNumber("usdToIdr", event.target.value)} /><em>Rp</em></label>
          </fieldset>
          <fieldset className="pricing-section">
            <legend>Cost guard</legend>
            <p>Provider dibatasi berdasarkan biaya aktual, bukan berdasarkan jumlah clip atau score.</p>
            <div className="pricing-pair">
              <label className="field-label">Margin minimum<input type="number" min={50} max={95} step={1} value={percentage(draft.minimumMarginBps)} onChange={(event) => setNumber("minimumMarginBps", String(Number(event.target.value) * 100))} /><em>%</em></label>
              <label className="field-label">Margin target<input type="number" min={50} max={95} step={1} value={percentage(draft.targetMarginBps)} onChange={(event) => setNumber("targetMarginBps", String(Number(event.target.value) * 100))} /><em>%</em></label>
            </div>
            <label className="field-label">Alokasi infrastruktur/job<input type="number" min={0} value={microUsdToIdr(draft.infrastructureCostMicroUsd, draft.usdToIdr)} onChange={(event) => setIdrMicro("infrastructureCostMicroUsd", event.target.value)} /><em>Rp</em></label>
            <div className="pricing-pair">
              <label className="field-label">Buffer aman<input type="number" min={0} max={100} step={0.5} value={percentage(draft.safetyBufferBps)} onChange={(event) => setNumber("safetyBufferBps", String(Number(event.target.value) * 100))} /><em>%</em></label>
              <label className="field-label">Allowance retry<input type="number" min={0} max={100} step={0.5} value={percentage(draft.retryAllowanceBps)} onChange={(event) => setNumber("retryAllowanceBps", String(Number(event.target.value) * 100))} /><em>%</em></label>
            </div>
          </fieldset>
          <fieldset className="pricing-section">
            <legend>Batas provider</legend>
            <p>Job dihentikan sebelum biaya melewati batas keras. Admin dapat menaikkan bertahap setelah data nyata cukup.</p>
            <div className="provider-budget-row">
              <label>Target<input type="number" min={0} value={microUsdToIdr(draft.targetProviderCostMicroUsd, draft.usdToIdr)} onChange={(event) => setIdrMicro("targetProviderCostMicroUsd", event.target.value)} /></label>
              <label>Warning<input type="number" min={0} value={microUsdToIdr(draft.warningProviderCostMicroUsd, draft.usdToIdr)} onChange={(event) => setIdrMicro("warningProviderCostMicroUsd", event.target.value)} /></label>
              <label>Hard<input type="number" min={0} value={microUsdToIdr(draft.hardProviderCostMicroUsd, draft.usdToIdr)} onChange={(event) => setIdrMicro("hardProviderCostMicroUsd", event.target.value)} /></label>
            </div>
          </fieldset>
        </div>
        <div className="pricing-simulator">
          <div className="simulator-inputs">
            <div><p className="section-kicker">Live server simulation</p><h3>Uji satu job sebelum disimpan</h3></div>
            <label>Biaya provider (IDR)<input type="number" min={0} value={providerCostIdr} onChange={(event) => setProviderCostIdr(Number(event.target.value || 0))} /></label>
            <label className="checkbox-label"><input type="checkbox" checked={usableResult} onChange={(event) => setUsableResult(event.target.checked)} /> Hasil layak dipakai</label>
          </div>
          <div className="simulation-metrics">
            <span><small>Biaya provider</small><strong>{formatIdr(quote.providerCostIdr)}</strong><em>biaya aktual</em></span>
            <span><small>Biaya terlindungi</small><strong>{formatIdr(quote.protectedChargeIdr)}</strong><em>margin + buffer</em></span>
            <span><small>Reservasi estimasi</small><strong>{formatIdr(quote.reservationIdr)}</strong><em>{quote.reservationCapped ? "dibatasi ceiling job" : "estimate + headroom"}</em></span>
            <span className="result"><small>Tagihan akhir</small><strong>{formatIdr(quote.userChargeIdr)}</strong><em>{percentage(quote.grossMarginBps).toFixed(1)}% margin</em></span>
          </div>
          <div className="simulation-foot"><span><ShieldCheck size={15} /> Reserve estimate + headroom sekali sebelum job, settle sekali setelah hasil usable.</span><span className={`budget-${quote.budgetStatus}`}>Provider {formatIdr(quote.providerCostIdr)} · profit {formatIdr(quote.grossProfitIdr)}</span></div>
        </div>
        {!validation.valid && <div className="pricing-errors"><AlertTriangle size={16} /><div>{validation.errors.map((error) => <p key={error}>{error}</p>)}</div></div>}
        {validation.valid && validation.warnings.length > 0 && <div className="pricing-warnings"><AlertTriangle size={15} /><span>{validation.warnings.join(" ")}</span></div>}
        <div className="pricing-actions"><span>Biaya terlindungi pada batas hard: {formatIdr(validation.hardLimitProtectedIdr)}</span><button className="button button-primary" disabled={saving || !validation.valid}><Save size={15} /> {saving ? "Menyimpan..." : "Simpan pricing"}</button></div>
      </form>
      {message && <p className="form-status">{message}</p>}
    </section>
  );
}

function usageIdr(value: number, policy: PricingPolicy) {
  return microUsdToIdr(Math.round(Number(value || 0) * 1_000_000), policy.usdToIdr);
}

export function AdminRevenue() {
  const [data, setData] = useState<RevenuePayload | null>(null);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");
  const load = useCallback(() => {
    setError("");
    adminFetch<RevenuePayload>("/api/admin/revenue")
      .then((next) => {
        setData(next);
        setLastUpdated(new Date().toISOString());
      })
      .catch((reason) => setError(reason.message));
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);
  if (error) return <AdminError message={error} retry={load} />;
  if (!data) return <AdminLoading />;
  return <>
    <div className="live-status"><i /> Live · {data.jobBilling.storage === "postgres" ? "PostgreSQL ledger" : "local memory trial"} · diperbarui {lastUpdated ? formatDate(lastUpdated) : "..."}</div>
    {data.jobBilling.storage === "memory" && <div className="pricing-warnings"><AlertTriangle size={15} /><span>Mode lokal: job dan wallet kembali ke nilai awal ketika API restart. Production harus memakai PostgreSQL.</span></div>}
    <div className="stats-grid">
      <StatCard label="Customer payments" value={formatIdr(data.payment.grossIdr)} detail={`${data.payment.paidCount} settled payments`} icon={ReceiptText} tone="teal" />
      <StatCard label="Net payment revenue" value={formatIdr(data.payment.netIdr)} detail={`${formatIdr(data.payment.refundedIdr)} refunded`} icon={CircleDollarSign} tone="blue" />
      <StatCard label="Analysis job revenue" value={formatIdr(data.jobBilling.customerRevenueIdr)} detail={`${data.jobBilling.completed} settled jobs`} icon={Coins} tone="amber" />
      <StatCard label="Analysis gross profit" value={formatIdr(data.jobBilling.grossProfitIdr)} detail={`${data.jobBilling.active} active · ${data.jobBilling.failed} failed`} icon={BadgeDollarSign} tone="coral" />
    </div>
    <div className="two-column">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Revenue definition</p><h2>One job, one settlement</h2><p>User dibebani sekali per link setelah hasil usable. Request AI di dalam job hanya mengumpulkan biaya aktual.</p></div></div><div className="economics-equation"><span><small>User billing</small><strong>{formatIdr(data.jobBilling.customerRevenueIdr)}</strong></span><b>−</b><span><small>Internal cost</small><strong>{formatIdr(data.jobBilling.providerCostIdr)}</strong></span><b>=</b><span className="result"><small>Gross profit</small><strong>{formatIdr(data.jobBilling.grossProfitIdr)}</strong></span></div></section>
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Payment operations</p><h2>Incoming money is managed separately</h2><p>Payment, refund, dan status invoice direkonsiliasi terpisah dari biaya analisis.</p></div><Link href="/admin/payments">Open payments <ArrowRight size={13} /></Link></div><div className="finance-grid compact-finance"><span><small>Paid</small><strong>{data.payment.paidCount}</strong></span><span><small>Pending</small><strong>{data.payment.pendingCount}</strong></span><span><small>Failed</small><strong>{data.payment.failedCount}</strong></span><span><small>Refunded</small><strong>{formatIdr(data.payment.refundedIdr)}</strong></span></div></section>
    </div>
    <PricingPolicyEditor policy={data.pricing} initialQuote={data.simulation} initialValidation={data.pricingValidation} onSaved={load} />
    <section className="panel"><div className="panel-head"><div><p className="section-kicker">Job settlement ledger</p><h2>Recent analysis jobs</h2><p>Reservation, settlement, release, dan biaya provider ditampilkan per link untuk audit margin.</p></div></div>{data.jobBilling.recent.length ? <div className="table-scroll"><table><thead><tr><th>Status</th><th>Created</th><th>AI calls</th><th>Provider cost</th><th>Charged</th><th>Released</th><th>Profit</th><th>Budget</th></tr></thead><tbody>{data.jobBilling.recent.map((item) => <tr key={item.id}><td><strong>{item.status}</strong></td><td>{formatDate(item.createdAt)}</td><td>{item.requestCount}</td><td>{formatIdr(item.providerCostIdr)}</td><td>{formatIdr(item.finalChargeIdr)}</td><td>{formatIdr(item.releasedIdr)}</td><td>{formatIdr(item.grossProfitIdr)}</td><td><code>{item.budgetStatus}</code></td></tr>)}</tbody></table></div> : <div className="admin-empty"><strong>Belum ada analysis job</strong><span>Jalankan Find Highlight dari Cliper Studio untuk melihat reserve → settle → release secara nyata.</span></div>}</section>
    <section className="panel"><div className="panel-head"><div><p className="section-kicker">Provider usage</p><h2>Recent internal AI requests</h2><p>Biaya request dicatat sebagai cost internal. Tagihan user diselesaikan sekali pada level job.</p></div></div>{data.usage.recent.length ? <div className="table-scroll"><table><thead><tr><th>User</th><th>Module</th><th>Provider</th><th>Model</th><th>Provider cost</th><th>Service cost</th><th>Settled user charge</th><th>Gross profit</th></tr></thead><tbody>{data.usage.recent.map((item) => <tr key={item.id}><td>{item.accountEmail || "-"}</td><td><strong>{item.module}</strong></td><td>{item.provider}</td><td><code>{item.model}</code></td><td>{formatIdr(usageIdr(item.providerCostUsd, data.pricing))}</td><td>{formatIdr(usageIdr(item.serviceCostUsd, data.pricing))}</td><td>{formatIdr(usageIdr(item.billedCostUsd, data.pricing))}</td><td>{formatIdr(usageIdr(item.grossProfitUsd, data.pricing))}</td></tr>)}</tbody></table></div> : <div className="admin-empty"><strong>No gateway usage yet</strong><span>Jalankan request AI dari Cliper Studio untuk melihat biaya provider aktual.</span></div>}</section>
  </>;
}
