"use client";

import { CheckCircle2, Coins, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { adminFetch, formatIdr } from "@/lib/admin-api";

interface WalletPaymentSettings {
  source: "database" | "environment";
  walletCurrency: "USD";
  paymentCurrency: "IDR";
  minPurchaseUsd: string;
  maxPurchaseUsd: string;
  usdToIdrRate: number;
  serviceFeeIdr: number;
  uniqueCodeEnabled: boolean;
  uniqueCodeMin: number;
  uniqueCodeMax: number;
  maxTotalPaymentIdr: number;
}

export function AdminWalletPaymentSettings() {
  const [settings, setSettings] = useState<WalletPaymentSettings | null>(null);
  const [draft, setDraft] = useState<WalletPaymentSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const next = await adminFetch<WalletPaymentSettings>("/api/admin/settings/wallet-payment");
      setSettings(next);
      setDraft(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Konfigurasi wallet USD tidak dapat dimuat.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await adminFetch<WalletPaymentSettings>("/api/admin/settings/wallet-payment", {
        method: "PATCH",
        body: JSON.stringify({
          minPurchaseUsd: draft.minPurchaseUsd,
          maxPurchaseUsd: draft.maxPurchaseUsd,
          usdToIdrRate: draft.usdToIdrRate,
          serviceFeeIdr: draft.serviceFeeIdr,
          uniqueCodeEnabled: draft.uniqueCodeEnabled,
          uniqueCodeMin: draft.uniqueCodeMin,
          uniqueCodeMax: draft.uniqueCodeMax,
        }),
      });
      setSettings(next);
      setDraft(next);
      setNotice("Aturan wallet USD tersimpan. Invoice yang sudah dibuat tidak berubah.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Konfigurasi wallet USD tidak dapat disimpan.");
    } finally {
      setBusy(false);
    }
  };

  if (!settings || !draft) {
    return <section className="panel admin-loading"><span /> Memuat aturan wallet USD...</section>;
  }

  return <section className="panel form-panel payment-settings-card">
    <div className="panel-head">
      <div>
        <p className="section-kicker">Wallet billing</p>
        <h2>USD wallet & QRIS pricing</h2>
        <p>Wallet selalu USD, sementara QRIS ditagihkan dalam IDR. Setiap invoice menyimpan kurs, biaya, dan kode uniknya sendiri.</p>
      </div>
      <Coins size={20} />
    </div>
    {error && <div className="callout error-callout"><ShieldCheck size={17} /><span>{error}</span></div>}
    {notice && <div className="callout success-callout"><CheckCircle2 size={17} /><span>{notice}</span></div>}
    <div className="payment-config-summary">
      <span><small>Wallet currency</small><strong>USD</strong></span>
      <span><small>QRIS currency</small><strong>IDR</strong></span>
      <span><small>Config source</small><strong>{settings.source === "database" ? "Admin settings" : "Environment defaults"}</strong></span>
    </div>
    <form className="admin-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="field-label">Minimum top-up (USD)
          <input inputMode="decimal" value={draft.minPurchaseUsd} onChange={(event) => setDraft({ ...draft, minPurchaseUsd: event.target.value })} />
        </label>
        <label className="field-label">Maximum top-up (USD)
          <input inputMode="decimal" value={draft.maxPurchaseUsd} onChange={(event) => setDraft({ ...draft, maxPurchaseUsd: event.target.value })} />
        </label>
        <label className="field-label">Kurs 1 USD ke IDR
          <input type="number" min="1000" value={draft.usdToIdrRate} onChange={(event) => setDraft({ ...draft, usdToIdrRate: Number(event.target.value) })} />
        </label>
        <label className="field-label">Biaya layanan (IDR)
          <input type="number" min="0" value={draft.serviceFeeIdr} onChange={(event) => setDraft({ ...draft, serviceFeeIdr: Number(event.target.value) })} />
        </label>
        <label className="check-row payment-enabled field-wide"><input type="checkbox" checked={draft.uniqueCodeEnabled} onChange={(event) => setDraft({ ...draft, uniqueCodeEnabled: event.target.checked })} /> Tambahkan kode unik acak ke pembayaran QRIS</label>
        {draft.uniqueCodeEnabled && <>
          <label className="field-label">Kode unik minimum (IDR)
            <input type="number" min="0" value={draft.uniqueCodeMin} onChange={(event) => setDraft({ ...draft, uniqueCodeMin: Number(event.target.value) })} />
          </label>
          <label className="field-label">Kode unik maksimum (IDR)
            <input type="number" min="0" value={draft.uniqueCodeMax} onChange={(event) => setDraft({ ...draft, uniqueCodeMax: Number(event.target.value) })} />
          </label>
        </>}
      </div>
      <div className="callout info-callout"><ShieldCheck size={17} /><span>Estimasi maksimum checkout saat ini: <strong>{formatIdr(settings.maxTotalPaymentIdr)}</strong>. Xendit menerima total final IDR; saldo customer hanya sebesar pembelian USD.</span></div>
      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={() => void load()} disabled={busy}><RefreshCw size={15} /> Reset</button>
        <button className="button button-primary" disabled={busy}><Save size={15} /> {busy ? "Menyimpan..." : "Simpan aturan wallet"}</button>
      </div>
    </form>
  </section>;
}
