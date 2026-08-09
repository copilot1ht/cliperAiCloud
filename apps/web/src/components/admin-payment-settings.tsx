"use client";

import {
  CheckCircle2,
  Copy,
  CreditCard,
  ExternalLink,
  KeyRound,
  QrCode,
  RefreshCw,
  Save,
  ShieldCheck,
  TestTube2,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { AdminError, AdminLoading, LocalModeNotice } from "@/components/admin-ui";
import { adminFetch } from "@/lib/admin-api";

interface PaymentSettings {
  provider: "xendit" | "midtrans" | "sandbox";
  enabled: boolean;
  environment: "production" | "sandbox" | "test" | "live";
  source: "admin-settings" | "railway-env" | "not-configured";
  sourceLabel: string;
  configured: boolean;
  databaseSupported: boolean;
  merchantIdMasked: string | null;
  clientKeyConfigured: boolean;
  serverKeyConfigured: boolean;
  secretKeyConfigured?: boolean;
  webhookTokenConfigured?: boolean;
  apiVersion?: string | null;
  notificationUrl: string;
  finishRedirectUrl: string;
}

interface ConnectionResult {
  configuration: PaymentSettings;
  connection: {
    ok: true;
    latencyMs: number;
    verification: "credentials-accepted";
    environment: "production" | "sandbox" | "test" | "live";
    source: string;
    provider: string;
  };
}

interface TestInvoice {
  number: string;
  status: "open" | "paid" | "expired" | "refunded" | "void";
  totalIdr: number;
  provider: string | null;
  qrString: string | null;
  qrImageBase64: string | null;
  expiresAt: string | null;
  environment: "test" | "production";
  payment: { id: string; status: string; externalId: string } | null;
}

function copyText(value: string, setMessage: (value: string) => void) {
  if (!value) return;
  navigator.clipboard
    .writeText(value)
    .then(() => setMessage("URL disalin."))
    .catch(() => setMessage("Browser tidak dapat menyalin URL. Salin manual."));
}

export function AdminPaymentSettings() {
  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [environment, setEnvironment] = useState<"production" | "sandbox" | "test" | "live">("sandbox");
  const [merchantId, setMerchantId] = useState("");
  const [clientKey, setClientKey] = useState("");
  const [serverKey, setServerKey] = useState("");
  const [notificationUrl, setNotificationUrl] = useState("");
  const [finishRedirectUrl, setFinishRedirectUrl] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testInvoice, setTestInvoice] = useState<TestInvoice | null>(null);
  const [testBusy, setTestBusy] = useState<"create" | "simulate" | "sync" | "">("");

  const applySettings = useCallback((next: PaymentSettings) => {
    setSettings(next);
    setEnabled(next.enabled);
    setEnvironment(next.environment);
    setNotificationUrl(next.notificationUrl || "");
    setFinishRedirectUrl(next.finishRedirectUrl || "");
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      applySettings(await adminFetch<PaymentSettings>("/api/admin/settings/payment"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pengaturan pembayaran tidak dapat dimuat.");
    }
  }, [applySettings]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const next = await adminFetch<PaymentSettings>("/api/admin/settings/payment", {
        method: "PUT",
        body: JSON.stringify({
          enabled,
          environment,
          merchantId: merchantId.trim() || undefined,
          clientKey: clientKey.trim() || undefined,
          serverKey: serverKey.trim() || undefined,
          notificationUrl: notificationUrl.trim(),
          finishRedirectUrl: finishRedirectUrl.trim(),
        }),
      });
      applySettings(next);
      setMerchantId("");
      setClientKey("");
      setServerKey("");
      setNotice("Konfigurasi Midtrans tersimpan. Nilai rahasia tidak pernah dikirim kembali ke browser.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Konfigurasi tidak dapat disimpan.");
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setError("");
    setNotice("");
    try {
      const result = await adminFetch<ConnectionResult>("/api/admin/settings/payment/test", {
        method: "POST",
        body: "{}",
      });
      applySettings(result.configuration);
      setNotice(`Koneksi ${result.connection.provider} ${result.connection.environment} diterima dalam ${result.connection.latencyMs} ms. Tidak ada transaksi dibuat.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Uji koneksi payment gateway gagal.");
    } finally {
      setTesting(false);
    }
  };

  const createTestQris = async () => {
    setTestBusy("create");
    setError("");
    setNotice("");
    try {
      const invoice = await adminFetch<TestInvoice>("/api/admin/settings/payment/test-qris", {
        method: "POST",
        body: "{}",
      });
      setTestInvoice(invoice);
      setNotice("QRIS test dibuat. Scan tidak diperlukan; gunakan Simulate success untuk meminta webhook test dari Xendit.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "QRIS test tidak dapat dibuat.");
    } finally {
      setTestBusy("");
    }
  };

  const simulateTestQris = async () => {
    if (!testInvoice) return;
    setTestBusy("simulate");
    setError("");
    setNotice("");
    try {
      await adminFetch<{ simulation: { status: string } }>(
        `/api/admin/settings/payment/test-qris/${encodeURIComponent(testInvoice.number)}/simulate`,
        { method: "POST", body: "{}" },
      );
      setNotice("Simulasi diterima Xendit. Wallet belum berubah; tunggu webhook lalu gunakan Sync status bila diperlukan.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Simulasi Xendit gagal.");
    } finally {
      setTestBusy("");
    }
  };

  const syncTestQris = async () => {
    if (!testInvoice) return;
    setTestBusy("sync");
    setError("");
    try {
      const result = await adminFetch<{ invoice?: TestInvoice }>(
        `/api/admin/settings/payment/test-qris/${encodeURIComponent(testInvoice.number)}/sync`,
        { method: "POST", body: "{}" },
      );
      if (result.invoice) setTestInvoice(result.invoice);
      setNotice(result.invoice?.status === "paid" ? "Webhook atau status provider telah memverifikasi pembayaran test. Ledger diperbarui sekali saja." : "Status terbaru telah dibaca dari Xendit. Payment tetap menunggu callback final bila belum PAID.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Status QRIS test tidak dapat disinkronkan.");
    } finally {
      setTestBusy("");
    }
  };

  if (error && !settings) {
    return <><LocalModeNotice /><AdminError message={error} retry={load} /></>;
  }
  if (!settings) return <AdminLoading label="Memuat konfigurasi payment..." />;

  if (settings.provider === "xendit") {
    const isTestMode = settings.environment === "test";
    return <>
      <LocalModeNotice />
      {error && <AdminError message={error} retry={load} />}
      {notice && <div className="callout success-callout"><CheckCircle2 size={17} /><span>{notice}</span></div>}
      <section className="panel form-panel payment-settings-card">
        <div className="panel-head"><div><p className="section-kicker">Payment gateway</p><h2>Xendit Payment Settings</h2><p>Credential dan callback token hanya dibaca di Railway @cliper/api; keduanya tidak pernah ditampilkan kembali oleh admin.</p></div><CreditCard size={20} /></div>
        <div className="payment-config-summary"><span><small>Active source</small><strong>{settings.sourceLabel}</strong></span><span><small>Environment</small><strong>{settings.environment === "live" ? "Live" : "Test"}</strong></span><span><small>Gateway status</small><strong>{settings.enabled && settings.configured ? "Ready" : "Not active"}</strong></span></div>
        <div className="callout info-callout"><ShieldCheck size={17} /><span><strong>Webhook token tersimpan server-side.</strong> Set `XENDIT_SECRET_KEY`, `XENDIT_WEBHOOK_TOKEN`, `XENDIT_MODE`, dan provider utama di Railway. Admin hanya menampilkan status masked dan menjalankan operasi aman.</span></div>
        <div className="endpoint-list"><span><KeyRound size={15} /><strong>Secret API Key</strong><code>{settings.secretKeyConfigured ? "Configured (masked)" : "Missing"}</code></span><span><ShieldCheck size={15} /><strong>Webhook Token</strong><code>{settings.webhookTokenConfigured ? "Configured (masked)" : "Missing"}</code></span><span><QrCode size={15} /><strong>Payment Status & Request Status</strong><code>{settings.notificationUrl || "API_PUBLIC_URL belum diatur"}</code></span><span><ExternalLink size={15} /><strong>API version</strong><code>{settings.apiVersion || "2024-11-11"}</code></span><span><CreditCard size={15} /><strong>Midtrans</strong><code>Disabled / standby. Tidak ada automatic fallback.</code></span></div>
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={load} disabled={testing || Boolean(testBusy)}><RefreshCw size={15} /> Refresh configuration</button><button type="button" className="button button-secondary" onClick={testConnection} disabled={testing || Boolean(testBusy)}><TestTube2 size={15} /> {testing ? "Testing..." : "Test connection"}</button>{isTestMode && <button type="button" className="button button-primary" onClick={createTestQris} disabled={!settings.enabled || !settings.configured || Boolean(testBusy) || testing}><QrCode size={15} /> {testBusy === "create" ? "Creating..." : "Create test QRIS"}</button>}</div>
      </section>
      {isTestMode && testInvoice && <section className="panel checkout-panel payment-settings-card admin-test-payment"><div className="panel-head"><div><p className="section-kicker">Xendit test workflow</p><h2>Test QRIS {testInvoice.number}</h2><p>Simulator hanya meminta pemrosesan oleh Xendit. Saldo baru berubah setelah callback tervalidasi atau rekonsiliasi status provider.</p></div><span className={testInvoice.status === "paid" ? "status-tag healthy" : "status-tag fallback"}>{testInvoice.status}</span></div><div className="checkout-grid"><div className="checkout-total"><small>Test amount</small><strong>{new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(testInvoice.totalIdr)}</strong><span>{testInvoice.environment} · {testInvoice.payment?.status || "pending"}</span><small>Expires {testInvoice.expiresAt ? new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(testInvoice.expiresAt)) : "-"}</small></div><div className="checkout-code"><small>QRIS payload</small>{testInvoice.qrImageBase64 ? <div className="qris-image-frame"><img src={testInvoice.qrImageBase64} alt="Xendit test QRIS" /></div> : <code>{testInvoice.qrString || "QRIS belum tersedia"}</code>}<span>Payment request ID tersimpan pada backend dan tidak ditampilkan sebagai credential.</span></div></div><div className="modal-actions"><button type="button" className="button button-secondary" onClick={syncTestQris} disabled={Boolean(testBusy)}><RefreshCw size={15} /> {testBusy === "sync" ? "Syncing..." : "Sync status"}</button>{testInvoice.status === "open" && <button type="button" className="button button-primary" onClick={simulateTestQris} disabled={Boolean(testBusy)}><TestTube2 size={15} /> {testBusy === "simulate" ? "Simulating..." : "Simulate success"}</button>}</div></section>}
      {!isTestMode && <section className="panel payment-settings-card"><div className="panel-head"><div><p className="section-kicker">Live readiness</p><h2>Real payment remains guarded</h2><p>Live mode does not expose a simulator. Confirm a valid live key, live callback token, active QRIS channel, and both Xendit webhook tests before one controlled Rp17.000 payment.</p></div><ShieldCheck size={20} /></div></section>}
    </>;
  }

  const keyHint = settings.source === "admin-settings"
    ? "Kosongkan field key untuk mempertahankan ciphertext yang sudah tersimpan."
    : "Simpan key di sini hanya setelah PostgreSQL production aktif. Untuk aktivasi cepat gunakan Railway Variables pada @cliper/api.";
  const isProduction = environment === "production";

  return <>
    <LocalModeNotice />
    {error && <AdminError message={error} retry={load} />}
    {notice && <div className="callout success-callout"><CheckCircle2 size={17} /><span>{notice}</span></div>}
    <section className="panel form-panel payment-settings-card">
      <div className="panel-head">
        <div>
          <p className="section-kicker">Payment gateway</p>
          <h2>Midtrans Payment Settings</h2>
          <p>Server Key hanya diproses oleh API. Redirect browser tidak pernah menambah saldo; webhook tervalidasi tetap menjadi otoritas pembayaran.</p>
        </div>
        <CreditCard size={20} />
      </div>
      <div className="payment-config-summary">
        <span><small>Active source</small><strong>{settings.sourceLabel}</strong></span>
        <span><small>Environment</small><strong>{settings.environment === "production" ? "Production" : "Sandbox"}</strong></span>
        <span><small>Gateway status</small><strong>{settings.enabled && settings.configured ? "Ready" : "Not active"}</strong></span>
      </div>
      <form className="admin-form" onSubmit={submit}>
        <div className="form-grid">
          <label className="field-label">Environment
            <select value={environment} onChange={(event) => setEnvironment(event.target.value === "production" ? "production" : "sandbox")}>
              <option value="sandbox">Sandbox</option>
              <option value="production">Production</option>
            </select>
          </label>
          <label className="check-row payment-enabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable Midtrans checkout</label>
          <label className="field-label">Merchant ID
            <input value={merchantId} onChange={(event) => setMerchantId(event.target.value)} placeholder={settings.merchantIdMasked || "Masukkan Merchant ID"} autoComplete="off" />
          </label>
          <label className="field-label">Client Key
            <input type="password" value={clientKey} onChange={(event) => setClientKey(event.target.value)} placeholder={settings.clientKeyConfigured ? "Tersimpan terenkripsi" : "Masukkan Client Key"} autoComplete="new-password" />
          </label>
          <label className="field-label field-wide">Server Key
            <input type="password" value={serverKey} onChange={(event) => setServerKey(event.target.value)} placeholder={settings.serverKeyConfigured ? "Tersimpan terenkripsi" : "Masukkan Server Key"} autoComplete="new-password" />
          </label>
          <label className="field-label field-wide">Payment Notification URL
            <span className="field-with-action"><input value={notificationUrl} onChange={(event) => setNotificationUrl(event.target.value)} required /><button type="button" className="icon-button" title="Copy notification URL" aria-label="Copy notification URL" onClick={() => copyText(notificationUrl, setNotice)}><Copy size={15} /></button></span>
          </label>
          <label className="field-label field-wide">Finish Redirect URL
            <span className="field-with-action"><input value={finishRedirectUrl} onChange={(event) => setFinishRedirectUrl(event.target.value)} required /><button type="button" className="icon-button" title="Copy finish redirect URL" aria-label="Copy finish redirect URL" onClick={() => copyText(finishRedirectUrl, setNotice)}><Copy size={15} /></button></span>
          </label>
        </div>
        <div className={isProduction ? "callout warning-callout" : "callout info-callout"}>
          <ShieldCheck size={17} />
          <span><strong>{isProduction ? "Production memakai uang nyata." : "Sandbox untuk pengujian."}</strong> {keyHint}</span>
        </div>
        <div className="endpoint-list">
          <span><KeyRound size={15} /><strong>Midtrans Notification URL</strong><code>{notificationUrl || "API_PUBLIC_URL belum diatur"}</code></span>
          <span><ExternalLink size={15} /><strong>Finish Redirect URL</strong><code>{finishRedirectUrl || "WEB_ORIGIN belum diatur"}</code></span>
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={testConnection} disabled={testing || saving}><TestTube2 size={15} /> {testing ? "Testing..." : "Test connection"}</button>
          <button className="button button-primary" disabled={saving || testing}><Save size={15} /> {saving ? "Saving..." : "Save settings"}</button>
        </div>
      </form>
    </section>
  </>;
}
