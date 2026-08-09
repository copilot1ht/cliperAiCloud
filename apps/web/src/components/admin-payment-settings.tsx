"use client";

import {
  CheckCircle2,
  Copy,
  CreditCard,
  ExternalLink,
  KeyRound,
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

  if (error && !settings) {
    return <><LocalModeNotice /><AdminError message={error} retry={load} /></>;
  }
  if (!settings) return <AdminLoading label="Memuat konfigurasi payment..." />;

  if (settings.provider === "xendit") {
    return <>
      <LocalModeNotice />
      {error && <AdminError message={error} retry={load} />}
      {notice && <div className="callout success-callout"><CheckCircle2 size={17} /><span>{notice}</span></div>}
      <section className="panel form-panel payment-settings-card">
        <div className="panel-head"><div><p className="section-kicker">Payment gateway</p><h2>Xendit Payment Settings</h2><p>Credential dan callback token hanya dibaca di Railway @cliper/api; keduanya tidak pernah ditampilkan kembali oleh admin.</p></div><CreditCard size={20} /></div>
        <div className="payment-config-summary"><span><small>Active source</small><strong>{settings.sourceLabel}</strong></span><span><small>Environment</small><strong>{settings.environment === "live" ? "Live" : "Test"}</strong></span><span><small>Gateway status</small><strong>{settings.enabled && settings.configured ? "Ready" : "Not active"}</strong></span></div>
        <div className="callout info-callout"><ShieldCheck size={17} /><span><strong>Webhook token tersimpan server-side.</strong> Set `XENDIT_SECRET_KEY`, `XENDIT_WEBHOOK_TOKEN`, `XENDIT_MODE`, dan provider utama di Railway, lalu gunakan Test connection sebelum membuat QRIS.</span></div>
        <div className="endpoint-list"><span><KeyRound size={15} /><strong>Payment Status & Payment Request Status</strong><code>{settings.notificationUrl || "API_PUBLIC_URL belum diatur"}</code></span><span><ExternalLink size={15} /><strong>API version</strong><code>{settings.apiVersion || "2024-11-11"}</code></span></div>
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={testConnection} disabled={testing}><TestTube2 size={15} /> {testing ? "Testing..." : "Test connection"}</button></div>
      </section>
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
