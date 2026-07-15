"use client";

import Link from "next/link";
import { ArrowRight, BadgeDollarSign, CircleDollarSign, Coins, ReceiptText, Save, Settings2 } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { adminFetch, formatDate, formatIdr, formatUsd, type PricingPolicy } from "@/lib/admin-api";
import { AdminError, AdminLoading, LocalModeNotice } from "@/components/admin-ui";
import { StatCard } from "@/components/stat-card";

interface RevenuePayload {
  mode: string;
  payment: { grossIdr: number; refundedIdr: number; netIdr: number; paidCount: number; pendingCount: number; failedCount: number };
  usage: { requests: number; inputTokens: number; outputTokens: number; providerCostUsd: number; serviceCostUsd: number; billedCostUsd: number; grossMarginUsd: number; creditChargeMicro: number; recent: Array<{ id: string; provider: string; model: string; module: string; providerCostUsd: number; serviceCostUsd: number; billedCostUsd: number; grossProfitUsd: number; creditChargeMicro: number; markupBps: number; createdAt: string }> };
  grossMarginUsd: number;
  marginRate: number;
  pricing: PricingPolicy;
}

function PricingPolicyEditor({ policy, onSaved }: { policy: PricingPolicy; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setMessage("");
    const form = new FormData(event.currentTarget);
    const payload = {
      markupBps: Math.round(Number(form.get("markupPercent") || 0) * 100),
      minimumMarginBps: Math.round(Number(form.get("minimumMarginPercent") || 50) * 100),
      computeCostMicroUsd: Number(form.get("computeCostMicroUsd") || 0),
      paymentFeeBps: Math.round(Number(form.get("paymentFeePercent") || 0) * 100),
      reserveBps: Math.round(Number(form.get("reservePercent") || 0) * 100),
      minimumChargeMicroUsd: Number(form.get("minimumChargeMicroUsd") || 0),
      minimumClipChargeMicroUsd: Number(form.get("minimumClipChargeMicroUsd") || 5000),
      microUsdPerCredit: Number(form.get("microUsdPerCredit") || 100),
      usdToIdr: Number(form.get("usdToIdr") || 16000),
    };
    try { await adminFetch("/api/admin/pricing", { method: "PATCH", body: JSON.stringify(payload) }); setMessage("Pricing policy saved."); onSaved(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : "Pricing policy gagal disimpan."); }
    finally { setSaving(false); }
  };
  const markupPercent = policy.markupBps / 100;
  const minimumMarginPercent = policy.minimumMarginBps / 100;
  const requiredMarkupPercent = minimumMarginPercent >= 100 ? 999999 : minimumMarginPercent / (100 - minimumMarginPercent) * 100;
  const effectiveMarkupPercent = Math.max(markupPercent, requiredMarkupPercent);
  const minimumClipPriceIdr = policy.minimumClipChargeMicroUsd / 1_000_000 * policy.usdToIdr * (1 + effectiveMarkupPercent / 100);
  return <section className="panel pricing-panel"><div className="panel-head"><div><p className="section-kicker">Cost-based pricing</p><h2>Pricing policy</h2><p>Admin mengatur target markup atas service cost. Gross margin dihitung otomatis dan tidak dapat diisi manual.</p></div><Settings2 size={19} /></div>
    <form className="pricing-form" key={policy.updatedAt} onSubmit={submit}>
      <label className="field-label">Target markup<input name="markupPercent" type="number" min={0} max={1000} step="0.1" defaultValue={markupPercent} /><em>%</em></label>
      <label className="field-label">Minimum gross margin<input name="minimumMarginPercent" type="number" min={50} max={95} step="0.1" defaultValue={minimumMarginPercent} /><em>%</em></label>
      <label className="field-label">Payment fee<input name="paymentFeePercent" type="number" min={0} max={100} step="0.1" defaultValue={policy.paymentFeeBps / 100} /><em>%</em></label>
      <label className="field-label">Risk reserve<input name="reservePercent" type="number" min={0} max={100} step="0.1" defaultValue={policy.reserveBps / 100} /><em>%</em></label>
      <label className="field-label">Compute cost<input name="computeCostMicroUsd" type="number" min={0} step={1} defaultValue={policy.computeCostMicroUsd} /><em>µUSD</em></label>
      <label className="field-label">Minimum charge<input name="minimumChargeMicroUsd" type="number" min={0} step={1} defaultValue={policy.minimumChargeMicroUsd} /><em>µUSD</em></label>
      <label className="field-label">Minimum clip service<input name="minimumClipChargeMicroUsd" type="number" min={0} step={1} defaultValue={policy.minimumClipChargeMicroUsd} /><em>µUSD</em></label>
      <label className="field-label">Credit value<input name="microUsdPerCredit" type="number" min={1} step={1} defaultValue={policy.microUsdPerCredit} /><em>µUSD</em></label>
      <label className="field-label">USD to IDR display rate<input name="usdToIdr" type="number" min={1} step={1} defaultValue={policy.usdToIdr} /><em>Rp</em></label>
      <div className="pricing-preview"><small>Effective policy before payment/reserve overhead</small><span><b>Cost 100</b><i>+</i><b>{effectiveMarkupPercent.toFixed(1)}% effective markup</b><i>=</i><strong>{(100 * (1 + effectiveMarkupPercent / 100)).toFixed(2)} user price</strong></span><small>Minimum gross margin: {minimumMarginPercent.toFixed(1)}% · Estimasi minimum job clip: {formatIdr(minimumClipPriceIdr)}. Harga aktual mengikuti token provider.</small></div>
      <button className="button button-primary" disabled={saving}><Save size={15} /> {saving ? "Saving..." : "Save pricing"}</button>
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
    <div className="live-status"><i /> Live · diperbarui {lastUpdated ? formatDate(lastUpdated) : "..."}</div>
    <div className="stats-grid">
      <StatCard label="Customer payments" value={formatIdr(data.payment.grossIdr)} detail={`${data.payment.paidCount} settled payments`} icon={ReceiptText} tone="teal" />
      <StatCard label="Net payment revenue" value={formatIdr(data.payment.netIdr)} detail={`${formatIdr(data.payment.refundedIdr)} refunded`} icon={CircleDollarSign} tone="blue" />
      <StatCard label="AI billed value" value={formatUsd(data.usage.billedCostUsd)} detail={`${data.usage.requests} gateway requests`} icon={Coins} tone="amber" />
      <StatCard label="AI gross margin" value={formatUsd(data.grossMarginUsd)} detail={`${data.marginRate}% margin rate`} icon={BadgeDollarSign} tone="coral" />
    </div>
    <div className="two-column">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Revenue definition</p><h2>What this page measures</h2><p>Revenue adalah uang masuk dari wallet top-up user. Provider cost adalah biaya aktual AI. Gross margin AI adalah billed value dikurangi provider cost.</p></div></div><div className="economics-equation"><span><small>User billing</small><strong>{formatUsd(data.usage.billedCostUsd)}</strong></span><b>−</b><span><small>Provider cost</small><strong>{formatUsd(data.usage.providerCostUsd)}</strong></span><b>=</b><span className="result"><small>Gross margin</small><strong>{formatUsd(data.usage.grossMarginUsd)}</strong></span></div></section>
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Payment operations</p><h2>Incoming money is managed separately</h2><p>Admin tidak membeli paket. Halaman Payments dipakai untuk rekonsiliasi pembayaran user, refund, dan status transaksi.</p></div><Link href="/admin/payments">Open payments <ArrowRight size={13} /></Link></div><div className="finance-grid compact-finance"><span><small>Paid</small><strong>{data.payment.paidCount}</strong></span><span><small>Pending</small><strong>{data.payment.pendingCount}</strong></span><span><small>Failed</small><strong>{data.payment.failedCount}</strong></span><span><small>Refunded</small><strong>{formatIdr(data.payment.refundedIdr)}</strong></span></div></section>
    </div>
    <PricingPolicyEditor policy={data.pricing} onSaved={load} />
    <section className="panel"><div className="panel-head"><div><p className="section-kicker">Gateway economics</p><h2>Recent billable AI requests</h2><p>Hanya request sukses yang sudah diselesaikan debit credit-nya yang dicatat.</p></div></div>{data.usage.recent.length ? <div className="table-scroll"><table><thead><tr><th>Module</th><th>Provider</th><th>Model</th><th>Provider cost</th><th>Service cost</th><th>User charge</th><th>Gross profit</th><th>Credits</th></tr></thead><tbody>{data.usage.recent.map((item) => <tr key={item.id}><td><strong>{item.module}</strong></td><td>{item.provider}</td><td><code>{item.model}</code></td><td>{formatUsd(item.providerCostUsd)}</td><td>{formatUsd(item.serviceCostUsd)}</td><td>{formatUsd(item.billedCostUsd)}</td><td>{formatUsd(item.grossProfitUsd)}</td><td>{item.creditChargeMicro.toLocaleString("id-ID")}</td></tr>)}</tbody></table></div> : <div className="admin-empty"><strong>No gateway usage yet</strong><span>Jalankan request AI dari Cliper Studio untuk melihat cost dan margin aktual.</span></div>}</section>
  </>;
}
