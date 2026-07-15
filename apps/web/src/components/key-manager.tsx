"use client";

import { Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useState } from "react";

export interface LicenseKeySummary {
  id: string;
  prefix: string;
  plan: string;
  status: string;
  deviceSlots: { used: number; limit: number };
  createdAt: string;
  lastUsedAt?: string;
}

interface KeyManagerProps {
  keys: LicenseKeySummary[];
  generatedKey?: string;
  onGenerate: () => Promise<void>;
  onRevoke: (keyId: string) => Promise<void>;
  loading: boolean;
  error?: string;
}

export function KeyManager({ keys, generatedKey, onGenerate, onRevoke, loading, error }: KeyManagerProps) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const value = generatedKey || keys[0]?.prefix || "";
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="panel key-panel">
      <div className="panel-head"><div><p className="section-kicker">Desktop access</p><h2>API key manager</h2><p>Generate and manage desktop API licenses from your local Cliper Cloud server.</p></div><button className="button button-primary" onClick={onGenerate} disabled={loading}>{loading ? "Generating..." : "Generate new key"}</button></div>
      {generatedKey && (
        <div className="callout success-callout"><strong>Key baru dibuat.</strong><span>Salin key ini ke desktop segera. Raw key hanya ditampilkan sekali.</span><div className="key-field"><code>{visible ? generatedKey : "clip_sk_••••••••••••••••••••"}</code><button className="icon-button" onClick={() => setVisible(!visible)} aria-label={visible ? "Sembunyikan key" : "Tampilkan key"}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button><button className="icon-button" onClick={copy} aria-label="Salin key">{copied ? <Check size={18} /> : <Copy size={18} />}</button></div></div>
      )}
      <div className="callout info-callout"><strong>Lisensi desktop.</strong><span>Desktop akan memverifikasi key ke server melalui /api/auth/verify setiap startup.</span></div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Key</th><th>Plan</th><th>Status</th><th>Devices</th><th>Last used</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {keys.length === 0 ? (
              <tr><td colSpan={6}><em>No API keys yet. Generate one to start.</em></td></tr>
            ) : keys.map((key) => (
              <tr key={key.id}>
                <td><strong>{key.prefix}</strong></td>
                <td>{key.plan}</td>
                <td><span className={`status-tag ${key.status === "active" ? "healthy" : "fallback"}`}>{key.status}</span></td>
                <td>{key.deviceSlots.used} / {key.deviceSlots.limit}</td>
                <td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "Never"}</td>
                <td><button className="button button-secondary" onClick={() => onRevoke(key.id)} disabled={loading}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
