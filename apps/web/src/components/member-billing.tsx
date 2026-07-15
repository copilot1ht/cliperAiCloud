"use client";

import { Clock3, CreditCard, ExternalLink, Plus, RefreshCw, ShieldCheck, Wallet, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiBase } from "@/lib/api-base";
import { formatDate, formatIdr } from "@/lib/admin-api";

type BillingView = "plans" | "wallet" | "invoices" | "transactions";

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
  kind: "plan" | "topup";
  payment: { id: string; status: string; externalId: string } | null;
}

interface BillingPayload {
  mode: "postgresql" | "development-memory" | string;
  plans?: Array<{ code: string; name: string }>;
  wallet: { balanceMicro: number; reservedMicro: number; availableMicro: number; lifetimeGrantedMicro: number; lifetimeSpentMicro: number };
  subscription: { plan: string; status: string; currentPeriodEnd?: string; autoRenew: boolean } | null;
  invoices: Invoice[];
  topup: { currency: "IDR"; minIdr: number; maxIdr: number; creditsPerIdr: number };
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
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupAmount, setTopupAmount] = useState(25_000);
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

  const createTopup = async () => {
    setBusy("topup"); setError("");
    try {
      const invoice = await paymentFetch<Invoice>("/api/payments/topups", { method: "POST", body: JSON.stringify({ amountIdr: Number(topupAmount) }) });
      setSelected(invoice);
      setTopupOpen(false);
      await load();
      if (invoice.paymentUrl) window.location.assign(invoice.paymentUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Top-up tidak dapat dibuat.");
    } finally { setBusy(""); }
  };

  if (!data && !error) return <section className="panel billing-state"><strong>Memuat wallet...</strong><span>Memeriksa saldo credit dan transaksi terbaru.</span></section>;
  if (!data) return <section className="panel billing-state error-state"><strong>Billing belum tersedia</strong><span>{error}</span><button className="button button-secondary" onClick={() => void load()}><RefreshCw size={15} /> Coba lagi</button></section>;

  return <>
    {error && <div className="notice-line danger-notice"><div><span><strong>Billing error.</strong> {error}</span></div></div>}
    <div className="stats-grid compact-stats">
      <div className="metric-block"><small>Available AI credits</small><strong>{creditLabel(data.wallet.availableMicro)}</strong><span>Credits siap dipakai Cliper Studio</span></div>
      <div className="metric-block"><small>Reserved credits</small><strong>{creditLabel(data.wallet.reservedMicro)}</strong><span>Dipakai request yang sedang berjalan</span></div>
      <div className="metric-block"><small>Total purchased</small><strong>{creditLabel(data.wallet.lifetimeGrantedMicro)}</strong><span>Credit dari pembayaran tervalidasi</span></div>
      <div className="metric-block"><small>Transactions</small><strong>{data.invoices.length}</strong><span>{data.invoices.filter((item) => item.status === "open").length} menunggu pembayaran</span></div>
    </div>

    <section className="panel topup-panel">
      <div><p className="section-kicker">Flexible wallet</p><h2>Isi saldo credit</h2><p>Tambahkan Cliper Credits dengan nominal bebas melalui Midtrans. QRIS dan metode lain tampil sesuai pengaturan merchant.</p></div>
      <button className="button button-primary" onClick={() => { setTopupAmount(data.topup.minIdr); setTopupOpen(true); }}><Plus size={15} /> Top-up saldo</button>
    </section>

    {selected && <section className="panel checkout-panel">
      <div className="panel-head"><div><p className="section-kicker">Payment status</p><h2>{selected.number}</h2><p>TOP-UP SALDO · {selected.credits.toLocaleString("id-ID")} credits</p></div><span className={statusClass(selected.status)}>{selected.status}</span></div>
      <div className="checkout-grid">
        <div className="checkout-total"><small>Total payment</small><strong>{formatIdr(selected.totalIdr)}</strong>{countdown && <span><Clock3 size={14} /> Expires in {countdown}</span>}</div>
        <div className="checkout-code"><small>{selected.provider === "sandbox" ? "Sandbox payment code" : "Midtrans checkout"}</small><code>{selected.qrString || selected.payment?.externalId || "Waiting for provider"}</code><span>{selected.provider === "sandbox" ? "Kode ini hanya untuk pengujian lokal, bukan QRIS bank." : "Checkout Midtrans menyediakan QRIS/metode yang diaktifkan merchant. Saldo masuk setelah callback tervalidasi."}</span></div>
      </div>
      <div className="checkout-actions">
        {selected.paymentUrl && selected.provider !== "sandbox" && <a className="button button-primary" href={selected.paymentUrl} target="_blank" rel="noreferrer">Open payment <ExternalLink size={15} /></a>}
        {selected.provider === "sandbox" && selected.status === "open" && <button className="button button-primary" disabled={busy === selected.number} onClick={() => void completeSandbox()}><CreditCard size={15} /> {busy === selected.number ? "Processing..." : "Complete sandbox payment"}</button>}
        <button className="button button-secondary" onClick={() => void load()}><RefreshCw size={15} /> Refresh status</button>
      </div>
    </section>}

    {(view === "invoices" || view === "transactions") && <section className="panel table-panel">
      <div className="panel-head"><div><p className="section-kicker">Payment ledger</p><h2>{view === "invoices" ? "Invoice history" : "Your transactions"}</h2><p>Data berasal dari ledger payment dan hanya berubah melalui callback tervalidasi.</p></div><ShieldCheck size={20} /></div>
      {data.invoices.length ? <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Type</th><th>Amount</th><th>Provider</th><th>Status</th><th>Issued</th><th /></tr></thead><tbody>{data.invoices.map((invoice) => <tr key={invoice.number}><td><strong>{invoice.number}</strong></td><td>Top-up credit</td><td>{formatIdr(invoice.totalIdr)}</td><td>{invoice.provider || "-"}</td><td><span className={statusClass(invoice.status)}>{invoice.status}</span></td><td>{formatDate(invoice.issuedAt)}</td><td><button className="button button-secondary compact-button" onClick={() => setSelected(invoice)}>View</button></td></tr>)}</tbody></table></div> : <div className="admin-empty"><Wallet size={20} /><strong>Belum ada transaksi</strong><span>Gunakan tombol Isi saldo credit untuk membuat pembayaran pertama.</span></div>}
    </section>}
    {topupOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setTopupOpen(false); }}><section className="admin-modal topup-modal" role="dialog" aria-modal="true" aria-label="Top-up saldo">
      <header><div><h2>Top-up saldo</h2><p>Bayar aman melalui Midtrans. Nominal dalam Rupiah Indonesia.</p></div><button className="icon-button" aria-label="Tutup" onClick={() => setTopupOpen(false)}><X size={16} /></button></header>
      <div className="topup-form"><label className="field-label"><span>Jumlah (IDR)</span><div className="currency-input"><b>Rp</b><input type="number" min={data.topup.minIdr} max={data.topup.maxIdr} step="1000" value={topupAmount} onChange={(event) => setTopupAmount(Number(event.target.value))} /></div><small>Minimum {formatIdr(data.topup.minIdr)} · maksimum {formatIdr(data.topup.maxIdr)}</small></label><p className="topup-hint">Setiap Rp1 menghasilkan {data.topup.creditsPerIdr.toLocaleString("id-ID")} Cliper Credit sesuai konfigurasi layanan.</p></div>
      <div className="modal-actions"><button className="button button-secondary" onClick={() => setTopupOpen(false)}>Batal</button><button className="button button-primary" disabled={busy === "topup" || !Number.isFinite(topupAmount)} onClick={() => void createTopup()}><CreditCard size={15} /> {busy === "topup" ? "Menyiapkan..." : "Lanjut ke pembayaran"}</button></div>
    </section></div>}
  </>;
}
