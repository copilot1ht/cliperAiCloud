"use client";

import {
  Clock3,
  CreditCard,
  ExternalLink,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiBase } from "@/lib/api-base";
import { formatDate, formatIdr } from "@/lib/admin-api";
import { formatUsdWallet } from "@/lib/money";

type BillingView = "plans" | "wallet" | "invoices" | "transactions";

interface Invoice {
  number: string;
  subtotalIdr: number;
  status: "open" | "paid" | "expired" | "refunded" | "void";
  totalIdr: number;
  subtotalPaymentIdr: number;
  serviceFeeIdr: number;
  uniqueCodeIdr: number;
  walletCurrency: "USD" | string;
  purchaseUsd: string | null;
  provider: string | null;
  paymentUrl: string | null;
  qrString: string | null;
  qrImageBase64: string | null;
  qrImageUrl: string | null;
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
  wallet: {
    currency: "USD";
    balance: string;
    reserved: string;
    available: string;
    lifetimePurchased: string;
    lifetimeSpent: string;
  };
  subscription: {
    plan: string;
    status: string;
    currentPeriodEnd?: string;
    autoRenew: boolean;
  } | null;
  invoices: Invoice[];
  topup: {
    currency: "USD";
    paymentCurrency: "IDR";
    minPurchaseUsd: string;
    maxPurchaseUsd: string;
    usdToIdrRate: number;
    serviceFeeIdr: number;
    uniqueCodeEnabled: boolean;
    uniqueCodeMin: number;
    uniqueCodeMax: number;
    maxTotalPaymentIdr: number;
  };
}

async function paymentFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = Array.isArray(payload?.message)
      ? payload.message.join(" ")
      : payload?.message;
    throw new Error(message || `Billing request gagal (${response.status}).`);
  }
  return payload as T;
}

function statusClass(status: string): string {
  if (status === "paid" || status === "active") return "status-tag healthy";
  if (status === "refunded" || status === "void")
    return "status-tag danger-tag";
  return "status-tag fallback";
}

export function MemberBilling({
  view,
  autoOpenTopup = false,
}: {
  view: BillingView;
  autoOpenTopup?: boolean;
}) {
  const [data, setData] = useState<BillingPayload | null>(null);
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupPurchaseUsd, setTopupPurchaseUsd] = useState("1.00");
  const [paymentNotice, setPaymentNotice] = useState("");
  const autoOpenHandled = useRef(false);
  const load = useCallback(async () => {
    setError("");
    try {
      const next = await paymentFetch<BillingPayload>("/api/payments");
      setData(next);
      setSelected((current) => {
        const invoice = current
          ? next.invoices.find((item) => item.number === current.number) || null
          : next.invoices.find((item) => item.status === "open") || null;
        if (current?.status !== "paid" && invoice?.status === "paid") {
          setPaymentNotice(`Pembayaran berhasil. ${formatUsdWallet(invoice.purchaseUsd)} telah ditambahkan ke wallet Anda.`);
        }
        return invoice;
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Billing tidak dapat dimuat.",
      );
    }
  }, []);
  const syncStatus = useCallback(
    async (silent = false) => {
      if (!selected) return;
      if (selected.provider === "sandbox") {
        await load();
        return;
      }
      if (!silent) {
        setBusy("status");
        setError("");
      }
      try {
        await paymentFetch(
          `/api/payments/invoices/${encodeURIComponent(selected.number)}/sync`,
          { method: "POST" },
        );
        await load();
      } catch (reason) {
        if (!silent)
          setError(
            reason instanceof Error
              ? reason.message
              : "Status pembayaran belum dapat diperiksa.",
          );
      } finally {
        if (!silent) setBusy("");
      }
    },
    [load, selected],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!autoOpenTopup || !data || autoOpenHandled.current) return;
    autoOpenHandled.current = true;
    setTopupPurchaseUsd(data.topup.minPurchaseUsd);
    setTopupOpen(true);
  }, [autoOpenTopup, data]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!selected || selected.status !== "open") return;
    const timer = window.setInterval(() => {
      void syncStatus(true);
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [selected, syncStatus]);

  const countdown = useMemo(() => {
    if (!selected?.expiresAt || selected.status !== "open") return "";
    const seconds = Math.max(
      0,
      Math.floor((new Date(selected.expiresAt).getTime() - now) / 1_000),
    );
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }, [now, selected]);

  const completeSandbox = async () => {
    if (!selected) return;
    setBusy(selected.number);
    setError("");
    try {
      await paymentFetch(
        `/api/payments/sandbox/${encodeURIComponent(selected.number)}/complete`,
        { method: "POST" },
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Sandbox payment gagal.",
      );
    } finally {
      setBusy("");
    }
  };

  const createTopup = async () => {
    if (
      !data ||
      !/^\d+(?:\.\d{1,6})?$/.test(topupPurchaseUsd) ||
      Number(topupPurchaseUsd) < Number(data.topup.minPurchaseUsd) ||
      Number(topupPurchaseUsd) > Number(data.topup.maxPurchaseUsd)
    ) {
      setError(
        `Top-up harus antara ${formatUsdWallet(data?.topup.minPurchaseUsd)} dan ${formatUsdWallet(data?.topup.maxPurchaseUsd)}.`,
      );
      return;
    }
    setBusy("topup");
    setError("");
    try {
      const invoice = await paymentFetch<Invoice>("/api/payments/topups", {
        method: "POST",
        body: JSON.stringify({ purchaseUsd: topupPurchaseUsd }),
      });
      setSelected(invoice);
      setTopupOpen(false);
      await load();
      if (invoice.paymentUrl) window.location.assign(invoice.paymentUrl);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Top-up tidak dapat dibuat.",
      );
    } finally {
      setBusy("");
    }
  };

  if (!data && !error)
    return (
      <section className="panel billing-state">
        <strong>Memuat wallet...</strong>
        <span>Memeriksa saldo wallet USD dan transaksi terbaru.</span>
      </section>
    );
  if (!data)
    return (
      <section className="panel billing-state error-state">
        <strong>Billing belum tersedia</strong>
        <span>{error}</span>
        <button className="button button-secondary" onClick={() => void load()}>
          <RefreshCw size={15} /> Coba lagi
        </button>
      </section>
    );

  const topupPurchase = Number(topupPurchaseUsd);
  const topupPreviewSubtotal = Number.isFinite(topupPurchase)
    ? Math.ceil(Math.max(0, topupPurchase) * data.topup.usdToIdrRate)
    : 0;
  const topupIsValid =
    /^\d+(?:\.\d{1,6})?$/.test(topupPurchaseUsd) &&
    topupPurchase >= Number(data.topup.minPurchaseUsd) &&
    topupPurchase <= Number(data.topup.maxPurchaseUsd);
  const openTopup = () => {
    setTopupPurchaseUsd(data.topup.minPurchaseUsd);
    setTopupOpen(true);
  };

  return (
    <>
      {error && (
        <div className="notice-line danger-notice">
          <div>
            <span>
              <strong>Billing error.</strong> {error}
            </span>
          </div>
        </div>
      )}
      {paymentNotice && (
        <div className="notice-line success-notice">
          <div><ShieldCheck size={17} /><span>{paymentNotice}</span></div>
        </div>
      )}
      <div className="stats-grid compact-stats">
        <div className="metric-block">
          <small>Available balance</small>
          <strong>{formatUsdWallet(data.wallet.available)}</strong>
          <span>Saldo siap dipakai Cliper Studio</span>
        </div>
        <div className="metric-block">
          <small>Reserved balance</small>
          <strong>{formatUsdWallet(data.wallet.reserved)}</strong>
          <span>Dipakai request yang sedang berjalan</span>
        </div>
        <div className="metric-block">
          <small>Lifetime purchased</small>
          <strong>{formatUsdWallet(data.wallet.lifetimePurchased)}</strong>
          <span>Saldo dari pembayaran tervalidasi</span>
        </div>
        <div className="metric-block">
          <small>Transactions</small>
          <strong>{data.invoices.length}</strong>
          <span>
            {data.invoices.filter((item) => item.status === "open").length}{" "}
            menunggu pembayaran
          </span>
        </div>
      </div>

      <section className="panel topup-panel">
        <div>
          <p className="section-kicker">Flexible wallet</p>
          <h2>Isi saldo Cliper</h2>
          <p>
            Tambahkan saldo wallet USD melalui QRIS Xendit. Saldo masuk
            otomatis setelah pembayaran tervalidasi.
          </p>
        </div>
        <button className="button button-primary" onClick={openTopup}>
          <Plus size={15} /> Top-up saldo
        </button>
      </section>

      {selected && (
        <section className="panel checkout-panel">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Payment status</p>
              <h2>{selected.number}</h2>
              <p>
                Top-up wallet {formatUsdWallet(selected.purchaseUsd)} · QRIS
              </p>
            </div>
            <span className={statusClass(selected.status)}>
              {selected.status}
            </span>
          </div>
          <div className="checkout-grid">
            <div className="checkout-total">
              <small>Total pembayaran QRIS</small>
              <strong>{formatIdr(selected.totalIdr)}</strong>
              <span>Saldo wallet {formatUsdWallet(selected.purchaseUsd)}</span>
              {countdown && (
                <span>
                  <Clock3 size={14} /> Expires in {countdown}
                </span>
              )}
            </div>
            <div className="checkout-code">
              <small>
                {selected.provider === "sandbox"
                  ? "Sandbox payment code"
                  : "QRIS checkout"}
              </small>
              {selected.qrImageBase64 ? (
                <div className="qris-image-frame">
                  <img
                    src={selected.qrImageBase64}
                    alt={`QRIS pembayaran ${selected.number}`}
                    width={320}
                    height={320}
                  />
                </div>
              ) : (
                <code>
                  {selected.qrString ||
                    selected.payment?.externalId ||
                    "Menunggu QRIS dari provider"}
                </code>
              )}
              <span>
                {selected.provider === "sandbox"
                  ? "QR ini hanya untuk pengujian lokal. Gunakan tombol simulasi, bukan aplikasi bank."
                  : "Scan dengan aplikasi bank atau e-wallet. Saldo masuk setelah callback Xendit tervalidasi."}
              </span>
            </div>
          </div>
          <div className="invoice-breakdown" aria-label="Rincian pembayaran">
            <span><small>Nilai wallet</small><strong>{formatUsdWallet(selected.purchaseUsd)}</strong></span>
            <span><small>Subtotal QRIS</small><strong>{formatIdr(selected.subtotalPaymentIdr || selected.subtotalIdr)}</strong></span>
            <span><small>Biaya layanan</small><strong>{formatIdr(selected.serviceFeeIdr)}</strong></span>
            <span><small>Kode unik</small><strong>{formatIdr(selected.uniqueCodeIdr)}</strong></span>
          </div>
          <div className="checkout-actions">
            {selected.paymentUrl && selected.provider !== "sandbox" && (
              <a
                className="button button-primary"
                href={selected.paymentUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open payment <ExternalLink size={15} />
              </a>
            )}
            {selected.provider === "sandbox" && selected.status === "open" && (
              <button
                className="button button-primary"
                disabled={busy === selected.number}
                onClick={() => void completeSandbox()}
              >
                <CreditCard size={15} />{" "}
                {busy === selected.number
                  ? "Processing..."
                  : "Complete sandbox payment"}
              </button>
            )}
            {selected.provider !== "sandbox" && selected.status === "open" && (
              <button
                className="button button-secondary"
                disabled={busy === "status"}
                onClick={() => void syncStatus()}
              >
                <ShieldCheck size={15} />{" "}
                {busy === "status" ? "Checking..." : "Check payment status"}
              </button>
            )}
            <button
              className="button button-secondary"
              onClick={() => void load()}
            >
              <RefreshCw size={15} /> Refresh status
            </button>
          </div>
        </section>
      )}

      {(view === "invoices" || view === "transactions") && (
        <section className="panel table-panel">
          <div className="panel-head">
            <div>
              <p className="section-kicker">Payment ledger</p>
              <h2>
                {view === "invoices" ? "Invoice history" : "Your transactions"}
              </h2>
              <p>
                Data berasal dari ledger payment dan hanya berubah melalui
                callback tervalidasi.
              </p>
            </div>
            <ShieldCheck size={20} />
          </div>
          {data.invoices.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Type</th>
                    <th>Wallet</th>
                    <th>Bayar (IDR)</th>
                    <th>Provider</th>
                    <th>Status</th>
                    <th>Issued</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.invoices.map((invoice) => (
                    <tr key={invoice.number}>
                      <td>
                        <strong>{invoice.number}</strong>
                      </td>
                      <td>Top-up wallet</td>
                      <td>{formatUsdWallet(invoice.purchaseUsd)}</td>
                      <td>{formatIdr(invoice.totalIdr)}</td>
                      <td>{invoice.provider || "-"}</td>
                      <td>
                        <span className={statusClass(invoice.status)}>
                          {invoice.status}
                        </span>
                      </td>
                      <td>{formatDate(invoice.issuedAt)}</td>
                      <td>
                        <button
                          className="button button-secondary compact-button"
                          onClick={() => setSelected(invoice)}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="admin-empty">
              <Wallet size={20} />
              <strong>Belum ada transaksi</strong>
              <span>
                Gunakan tombol Isi saldo untuk membuat pembayaran
                pertama.
              </span>
            </div>
          )}
        </section>
      )}
      {topupOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setTopupOpen(false);
          }}
        >
          <section
            className="admin-modal topup-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Top-up saldo"
          >
            <header>
              <div>
                <h2>Top-up saldo</h2>
                <p>
                  Pilih saldo USD untuk wallet Anda. QRIS selalu dibayar dalam
                  Rupiah dan nominal final dibuat oleh server.
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="Tutup"
                onClick={() => setTopupOpen(false)}
              >
                <X size={16} />
              </button>
            </header>
            <div className="topup-form">
              <label className="field-label">
                <span>Saldo wallet (USD)</span>
                <div className="currency-input">
                  <b>$</b>
                  <input
                    type="number"
                    min={data.topup.minPurchaseUsd}
                    max={data.topup.maxPurchaseUsd}
                    step="0.01"
                    inputMode="decimal"
                    value={topupPurchaseUsd}
                    onChange={(event) =>
                      setTopupPurchaseUsd(event.target.value)
                    }
                  />
                </div>
                <small>
                  Minimum {formatUsdWallet(data.topup.minPurchaseUsd)} · maksimum{" "}
                  {formatUsdWallet(data.topup.maxPurchaseUsd)}
                </small>
              </label>
              <div className="topup-presets" aria-label="Pilihan saldo cepat">
                {["1", "2", "5", "10"].map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={Number(topupPurchaseUsd) === Number(value) ? "button button-primary compact-button" : "button button-secondary compact-button"}
                    disabled={Number(value) < Number(data.topup.minPurchaseUsd) || Number(value) > Number(data.topup.maxPurchaseUsd)}
                    onClick={() => setTopupPurchaseUsd(value)}
                  >
                    {formatUsdWallet(value)}
                  </button>
                ))}
              </div>
              <div className="topup-summary" aria-label="Ringkasan pembayaran">
                <div>
                  <span>Kurs acuan</span>
                  <strong>US$1 = {formatIdr(data.topup.usdToIdrRate)}</strong>
                </div>
                <div>
                  <span>Saldo wallet</span>
                  <strong>{formatUsdWallet(topupPurchaseUsd)}</strong>
                </div>
                <div>
                  <span>Subtotal QRIS</span>
                  <strong>{formatIdr(topupPreviewSubtotal)}</strong>
                </div>
                <div>
                  <span>Biaya layanan</span>
                  <strong>{formatIdr(data.topup.serviceFeeIdr)}</strong>
                </div>
                <div>
                  <span>Kode unik</span>
                  <strong>{data.topup.uniqueCodeEnabled ? `${formatIdr(data.topup.uniqueCodeMin)} - ${formatIdr(data.topup.uniqueCodeMax)}` : "Tidak aktif"}</strong>
                </div>
                <div className="topup-summary-total">
                  <span>Estimasi total bayar</span>
                  <strong>{formatIdr(topupPreviewSubtotal + data.topup.serviceFeeIdr + (data.topup.uniqueCodeEnabled ? data.topup.uniqueCodeMin : 0))}</strong>
                  <small>Kode unik final dipilih sekali saat invoice dibuat.</small>
                </div>
              </div>
              <div className="payment-method-fixed" aria-label="Metode pembayaran">
                <CreditCard size={18} />
                <div>
                  <strong>QRIS otomatis</strong>
                  <span>Bayar dari aplikasi bank atau e-wallet yang mendukung QRIS.</span>
                </div>
              </div>
              <p className="topup-hint">
                Wallet bertambah sebesar nilai USD yang dipilih. Biaya layanan
                dan kode unik hanya untuk QRIS, bukan saldo wallet. Saldo masuk
                setelah callback provider tervalidasi server.
              </p>
            </div>
            <div className="modal-actions">
              <button
                className="button button-secondary"
                onClick={() => setTopupOpen(false)}
              >
                Batal
              </button>
              <button
                className="button button-primary"
                disabled={busy === "topup" || !topupIsValid}
                onClick={() => void createTopup()}
              >
                <CreditCard size={15} />{" "}
                {busy === "topup" ? "Menyiapkan..." : "Lanjut ke pembayaran"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
