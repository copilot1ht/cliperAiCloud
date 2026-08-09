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

type BillingView = "plans" | "wallet" | "invoices" | "transactions";

interface Invoice {
  number: string;
  status: "open" | "paid" | "expired" | "refunded" | "void";
  totalIdr: number;
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
    balanceMicro: number;
    reservedMicro: number;
    availableMicro: number;
    lifetimeGrantedMicro: number;
    lifetimeSpentMicro: number;
  };
  subscription: {
    plan: string;
    status: string;
    currentPeriodEnd?: string;
    autoRenew: boolean;
  } | null;
  invoices: Invoice[];
  topup: {
    currency: "IDR";
    minIdr: number;
    maxIdr: number;
    minUsd?: number;
    usdToIdrDisplayRate?: number;
    creditsPerIdr: number;
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

function creditLabel(micro: number): string {
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(
    micro / 1_000_000,
  );
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
  const [topupAmount, setTopupAmount] = useState(53_100);
  const autoOpenHandled = useRef(false);
  const load = useCallback(async () => {
    setError("");
    try {
      const next = await paymentFetch<BillingPayload>("/api/payments");
      setData(next);
      setSelected((current) =>
        current
          ? next.invoices.find((item) => item.number === current.number) || null
          : next.invoices.find((item) => item.status === "open") || null,
      );
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
    setTopupAmount(data.topup.minIdr);
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
      !Number.isSafeInteger(topupAmount) ||
      topupAmount < data.topup.minIdr ||
      topupAmount > data.topup.maxIdr
    ) {
      setError(
        `Nominal top-up harus antara ${formatIdr(data?.topup.minIdr || 0)} dan ${formatIdr(data?.topup.maxIdr || 0)}.`,
      );
      return;
    }
    setBusy("topup");
    setError("");
    try {
      const invoice = await paymentFetch<Invoice>("/api/payments/topups", {
        method: "POST",
        body: JSON.stringify({ amountIdr: Number(topupAmount) }),
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
        <span>Memeriksa saldo credit dan transaksi terbaru.</span>
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

  // IDR is authoritative for checkout. USD is only a display reference.
  const topupMinUsd = data.topup.minUsd || 1;
  const topupDisplayRate = data.topup.usdToIdrDisplayRate || 17_700;
  const topupUsdEquivalent = topupAmount / topupDisplayRate;
  const topupIsValid =
    Number.isSafeInteger(topupAmount) &&
    topupAmount >= data.topup.minIdr &&
    topupAmount <= data.topup.maxIdr;
  const openTopup = () => {
    setTopupAmount(data.topup.minIdr);
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
      <div className="stats-grid compact-stats">
        <div className="metric-block">
          <small>Available AI credits</small>
          <strong>{creditLabel(data.wallet.availableMicro)}</strong>
          <span>Credits siap dipakai Cliper Studio</span>
        </div>
        <div className="metric-block">
          <small>Reserved credits</small>
          <strong>{creditLabel(data.wallet.reservedMicro)}</strong>
          <span>Dipakai request yang sedang berjalan</span>
        </div>
        <div className="metric-block">
          <small>Total purchased</small>
          <strong>{creditLabel(data.wallet.lifetimeGrantedMicro)}</strong>
          <span>Credit dari pembayaran tervalidasi</span>
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
          <h2>Isi saldo credit</h2>
          <p>
            Tambahkan Cliper Credits melalui QRIS Midtrans. Saldo masuk otomatis
            setelah pembayaran tervalidasi.
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
                TOP-UP SALDO · {selected.credits.toLocaleString("id-ID")}{" "}
                credits · QRIS
              </p>
            </div>
            <span className={statusClass(selected.status)}>
              {selected.status}
            </span>
          </div>
          <div className="checkout-grid">
            <div className="checkout-total">
              <small>Total payment</small>
              <strong>{formatIdr(selected.totalIdr)}</strong>
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
                  : "Midtrans checkout"}
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
                  : "Scan dengan aplikasi bank atau e-wallet. Saldo masuk setelah callback Midtrans tervalidasi."}
              </span>
            </div>
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
                {busy === "status" ? "Checking..." : "Check Midtrans status"}
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
                    <th>Amount</th>
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
                      <td>Top-up credit</td>
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
                Gunakan tombol Isi saldo credit untuk membuat pembayaran
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
                  Bayar aman melalui Midtrans. Nominal akhir dibayar dalam
                  Rupiah.
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
                <span>Jumlah (IDR)</span>
                <div className="currency-input">
                  <b>Rp</b>
                  <input
                    type="number"
                    min={data.topup.minIdr}
                    max={data.topup.maxIdr}
                    step="1000"
                    value={topupAmount}
                    onChange={(event) =>
                      setTopupAmount(Number(event.target.value))
                    }
                  />
                </div>
                <small>
                  Minimum setara US${topupMinUsd.toFixed(2)}:{" "}
                  {formatIdr(data.topup.minIdr)} · maksimum{" "}
                  {formatIdr(data.topup.maxIdr)}
                </small>
              </label>
              <div className="topup-summary" aria-label="Ringkasan pembayaran">
                <div>
                  <span>Kurs acuan</span>
                  <strong>US$1 = {formatIdr(topupDisplayRate)}</strong>
                </div>
                <div>
                  <span>Subtotal</span>
                  <strong>
                    {formatIdr(
                      Number.isFinite(topupAmount)
                        ? Math.max(0, topupAmount)
                        : 0,
                    )}
                  </strong>
                </div>
                <div>
                  <span>Biaya platform</span>
                  <strong>Rp0</strong>
                </div>
                <div className="topup-summary-total">
                  <span>Total bayar</span>
                  <strong>
                    {formatIdr(
                      Number.isFinite(topupAmount)
                        ? Math.max(0, topupAmount)
                        : 0,
                    )}
                  </strong>
                  <small>
                    ≈ US$
                    {Number.isFinite(topupUsdEquivalent)
                      ? topupUsdEquivalent.toFixed(2)
                      : "0.00"}
                  </small>
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
                Setiap Rp1 menghasilkan{" "}
                {data.topup.creditsPerIdr.toLocaleString("id-ID")} Cliper
                Credit. Saldo hanya bertambah setelah status pembayaran
                tervalidasi oleh server.
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
