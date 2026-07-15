"use client";

import { Check, Clock3, CreditCard, ExternalLink, RefreshCw, ShieldCheck, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiBase } from "@/lib/api-base";
import { formatDate, formatIdr } from "@/lib/admin-api";

type BillingView = "plans" | "invoices" | "transactions";

interface Plan {
  code: "starter" | "pro";
  name: string;
  priceIdr: number;
  credits: number;
  deviceLimit: number;
  durationDays: number;
  description: string;
}

interface Invoice {
  number: string;
  status: "open" | "paid" | "expired" | "refunded" | "void";
  totalIdr: number;
  provider: string | null;
  paymentUrl: string | null;
  qrString: string | null;
  issuedAt: string;
  expiresAt?: string;
  paidAt?: string;
  plan: string;
  credits: number;
  payment: { id: string; status: string; externalId: string } | null;
}

interface BillingPayload {
  mode: "postgresql";
  plans: Plan[];
  wallet: { balanceMicro: number; reservedMicro: number; availableMicro: number; lifetimeGrantedMicro: number; lifetimeSpentMicro: number };
  subscription: { plan: string; status: string; currentPeriodEnd?: string; autoRenew: boolean } | null;
  invoices: Invoice[];
}

async function paymentFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = Array.isArray(payload?.message) ? payload.message.join(" ") : payload?.message;
    throw new Error(message || `Billing request gagal (${response.status}).`);
  }
  return payload as T;
}

function creditLabel(micro: number): string {
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(micro / 1_000_000);
}

function statusClass(status: string): string {
  if (status === "paid" || status === "active") return "status-tag healthy";
  if (status === "refunded" || status === "void") return "status-tag danger-tag";
  return "status-tag fallback";
}

export function MemberBilling({ view }: { view: BillingView }) {
  const [data, setData] = useState<BillingPayload | null>(null);
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async () => {
    setError("");
    try {
      const next = await paymentFetch<BillingPayload>("/api/payments");
      setData(next);
      setSelected((current) => current ? next.invoices.find((item) => item.number === current.number) || null : next.invoices.find((item) => item.status === "open") || null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Billing tidak dapat dimuat.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!selected || selected.status !== "open") return;
    const timer = window.setInterval(() => { void load(); }, 8_000);
    return () => window.clearInterval(timer);
  }, [load, selected]);

  const countdown = useMemo(() => {
    if (!selected?.expiresAt || selected.status !== "open") return "";
    const seconds = Math.max(0, Math.floor((new Date(selected.expiresAt).getTime() - now) / 1_000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }, [now, selected]);

  const createInvoice = async (plan: Plan) => {
    setBusy(plan.code); setError("");
    try {
      const invoice = await paymentFetch<Invoice>("/api/payments/invoices", { method: "POST", body: JSON.stringify({ plan: plan.code }) });
      setSelected(invoice);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invoice tidak dapat dibuat.");
    } finally { setBusy(""); }
  };

  const completeSandbox = async () => {
    if (!selected) return;
    setBusy(selected.number); setError("");
    try {
      await paymentFetch(`/api/payments/sandbox/${encodeURIComponent(selected.number)}/complete`, { method: "POST" });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sandbox payment gagal.");
    } finally { setBusy(""); }
  };

  if (!data && !error) return <section className="panel billing-state"><strong>Memuat billing...</strong><span>Memeriksa subscription dan invoice terbaru.</span></section>;
  if (!data) return <section className="panel billing-state error-state"><strong>Billing belum tersedia</strong><span>{error}</span><button className="button button-secondary" onClick={() => void load()}><RefreshCw size={15} /> Coba lagi</button></section>;

  return <>
    {error && <div className="notice-line danger-notice"><div><span><strong>Billing error.</strong> {error}</span></div></div>}
    <div className="stats-grid compact-stats">
      <div className="metric-block"><small>Available credits</small><strong>{creditLabel(data.wallet.availableMicro)}</strong><span>Cliper service credits</span></div>
      <div className="metric-block"><small>Current plan</small><strong>{data.subscription?.plan || "Free"}</strong><span>{data.subscription?.currentPeriodEnd ? `Until ${formatDate(data.subscription.currentPeriodEnd)}` : "No active subscription"}</span></div>
      <div className="metric-block"><small>Total granted</small><strong>{creditLabel(data.wallet.lifetimeGrantedMicro)}</strong><span>Verified payment grants</span></div>
      <div className="metric-block"><small>Invoices</small><strong>{data.invoices.length}</strong><span>{data.invoices.filter((item) => item.status === "open").length} awaiting payment</span></div>
    </div>

    {selected && <section className="panel checkout-panel">
      <div className="panel-head"><div><p className="section-kicker">Current invoice</p><h2>{selected.number}</h2><p>{selected.plan.toUpperCase()} · {selected.credits.toLocaleString("id-ID")} credits</p></div><span className={statusClass(selected.status)}>{selected.status}</span></div>
      <div className="checkout-grid">
        <div className="checkout-total"><small>Total payment</small><strong>{formatIdr(selected.totalIdr)}</strong>{countdown && <span><Clock3 size={14} /> Expires in {countdown}</span>}</div>
        <div className="checkout-code"><small>{selected.provider === "sandbox" ? "Sandbox payment code" : "Provider payment reference"}</small><code>{selected.qrString || selected.payment?.externalId || "Waiting for provider"}</code><span>{selected.provider === "sandbox" ? "Kode ini hanya untuk pengujian lokal, bukan QRIS bank." : "Status akan diperbarui otomatis melalui webhook terverifikasi."}</span></div>
      </div>
      <div className="checkout-actions">
        {selected.paymentUrl && selected.provider !== "sandbox" && <a className="button button-primary" href={selected.paymentUrl} target="_blank" rel="noreferrer">Open payment <ExternalLink size={15} /></a>}
        {selected.provider === "sandbox" && selected.status === "open" && <button className="button button-primary" disabled={busy === selected.number} onClick={() => void completeSandbox()}><CreditCard size={15} /> {busy === selected.number ? "Processing..." : "Complete sandbox payment"}</button>}
        <button className="button button-secondary" onClick={() => void load()}><RefreshCw size={15} /> Refresh status</button>
      </div>
    </section>}

    {(view === "plans" || view === "transactions") && <section className="plan-grid billing-plan-grid">
      {data.plans.map((plan) => <article className={plan.code === "pro" ? "plan-card recommended" : "plan-card"} key={plan.code}>
        <div className="plan-head"><span>{plan.code.toUpperCase()}</span>{plan.code === "pro" && <b>Best value</b>}</div>
        <h2>{plan.name}</h2><strong className="plan-price">{formatIdr(plan.priceIdr)}<small> / {plan.durationDays} days</small></strong>
        <p>{plan.description}</p><div className="plan-credit">{plan.credits.toLocaleString("id-ID")} Cliper Credits</div>
        <ul><li><Check size={15} />{plan.deviceLimit} desktop device{plan.deviceLimit > 1 ? "s" : ""}</li><li><Check size={15} />AI router managed by Cliper Cloud</li><li><Check size={15} />Signed invoice and audit trail</li></ul>
        <button className={plan.code === "pro" ? "button button-primary" : "button button-secondary"} disabled={Boolean(busy)} onClick={() => void createInvoice(plan)}><WalletCards size={15} /> {busy === plan.code ? "Creating..." : "Choose plan"}</button>
      </article>)}
    </section>}

    {(view === "invoices" || view === "transactions") && <section className="panel table-panel">
      <div className="panel-head"><div><p className="section-kicker">Payment ledger</p><h2>{view === "invoices" ? "Invoice history" : "Your transactions"}</h2><p>Data berasal dari ledger PostgreSQL dan hanya berubah melalui payment engine.</p></div><ShieldCheck size={20} /></div>
      {data.invoices.length ? <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Plan</th><th>Amount</th><th>Provider</th><th>Status</th><th>Issued</th><th /></tr></thead><tbody>{data.invoices.map((invoice) => <tr key={invoice.number}><td><strong>{invoice.number}</strong></td><td>{invoice.plan || "-"}</td><td>{formatIdr(invoice.totalIdr)}</td><td>{invoice.provider || "-"}</td><td><span className={statusClass(invoice.status)}>{invoice.status}</span></td><td>{formatDate(invoice.issuedAt)}</td><td><button className="button button-secondary compact-button" onClick={() => setSelected(invoice)}>View</button></td></tr>)}</tbody></table></div> : <div className="admin-empty"><strong>No invoices yet</strong><span>Pilih paket untuk membuat invoice pertama.</span></div>}
    </section>}
  </>;
}
