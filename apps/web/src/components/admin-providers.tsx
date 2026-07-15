"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Gauge, KeyRound, Plus, Power, RefreshCw, ServerCog, ShieldCheck, Trash2 } from "lucide-react";
import { AdminError, AdminLoading, AdminModal, EmptyState, LocalModeNotice } from "@/components/admin-ui";
import {
  adminFetch,
  formatDate,
  type AdminProvider,
  type ProviderCatalogItem,
  type ProviderTestResult,
} from "@/lib/admin-api";

interface ProviderPayload {
  mode: string;
  catalog: ProviderCatalogItem[];
  providers: AdminProvider[];
}

function statusLabel(status: AdminProvider["status"]): string {
  return { healthy: "Online", offline: "Offline", untested: "Belum diuji", disabled: "Nonaktif" }[status];
}

function resultFromProvider(provider: AdminProvider): ProviderTestResult {
  return {
    provider: provider.code as ProviderTestResult["provider"],
    displayName: provider.displayName,
    models: provider.availableModels,
    defaultModel: provider.model,
    latencyMs: provider.lastLatencyMs || 0,
    health: "healthy",
    checkedAt: provider.lastHealthAt || provider.updatedAt,
  };
}

function ProviderForm({
  provider,
  catalog,
  onClose,
  onSaved,
}: {
  provider?: AdminProvider;
  catalog: ProviderCatalogItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState<ProviderCatalogItem["code"]>((provider?.code as ProviderCatalogItem["code"]) || catalog[0]?.code || "deepseek");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(provider?.enabled !== false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [error, setError] = useState("");

  const testConnection = async () => {
    if (!provider && !apiKey.trim()) {
      setError("Tempel API key sebelum menjalankan test.");
      return;
    }
    setTesting(true);
    setError("");
    setResult(null);
    try {
      if (provider && !apiKey.trim()) {
        const tested = await adminFetch<AdminProvider>(`/api/admin/providers/${provider.id}/test`, { method: "POST" });
        setResult(resultFromProvider(tested));
      } else {
        setResult(await adminFetch<ProviderTestResult>("/api/admin/providers/test", {
          method: "POST",
          body: JSON.stringify({ provider: code, apiKey: apiKey.trim() }),
        }));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Koneksi provider gagal diuji.");
    } finally {
      setTesting(false);
    }
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (!provider || apiKey.trim()) {
        await adminFetch("/api/admin/providers", {
          method: "POST",
          body: JSON.stringify({ provider: code, apiKey: apiKey.trim(), enabled }),
        });
      } else {
        await adminFetch(`/api/admin/providers/${provider.id}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled }),
        });
      }
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider tidak dapat disimpan.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminModal
      title={provider ? `Kelola ${provider.displayName}` : "Tambah AI Provider"}
      detail="Pilih provider dan tempel API key. Endpoint, model, latency, dan health dideteksi otomatis oleh server."
      onClose={onClose}
    >
      <form className="admin-form provider-simple-form" onSubmit={save}>
        <label className="field-label">Provider
          <select value={code} disabled={Boolean(provider)} onChange={(event) => { setCode(event.target.value as ProviderCatalogItem["code"]); setResult(null); setError(""); }}>
            {catalog.map((item) => <option value={item.code} key={item.code}>{item.displayName}</option>)}
          </select>
        </label>
        <label className="field-label">API Key
          <input
            value={apiKey}
            onChange={(event) => { setApiKey(event.target.value); setResult(null); }}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder={provider ? "Tempel key baru untuk menambah key pool" : "Tempel API key provider"}
            required={!provider}
          />
          <small>Key dienkripsi di server dan tidak pernah dikirim kembali ke browser.</small>
        </label>
        <label className="field-label checkbox-field">
          <input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" /> Aktifkan provider
        </label>

        <div className={`provider-test-state ${result ? "connected" : error ? "failed" : "idle"}`} aria-live="polite">
          {result ? <CheckCircle2 size={18} /> : <Gauge size={18} />}
          <span>
            <strong>{result ? "Connected" : error ? "Test gagal" : "Belum diuji"}</strong>
            <small>{result ? `${result.models.length} model · ${result.latencyMs} ms · Default ${result.defaultModel}` : error || "Jalankan test untuk memvalidasi key dan mendeteksi model."}</small>
          </span>
        </div>

        <button type="button" className="button button-secondary provider-test-button" onClick={testConnection} disabled={testing || saving}>
          <RefreshCw size={15} className={testing ? "spin" : ""} /> {testing ? "Menguji..." : "Test API"}
        </button>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>Batal</button>
          <button className="button button-primary" disabled={saving || testing}>{saving ? "Menyimpan..." : "Simpan"}</button>
        </div>
      </form>
    </AdminModal>
  );
}

export function AdminProviders() {
  const [data, setData] = useState<ProviderPayload | null>(null);
  const [editing, setEditing] = useState<AdminProvider | null | "new">(null);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    adminFetch<ProviderPayload>("/api/admin/providers").then(setData).catch((reason) => setError(reason.message));
  }, []);
  useEffect(load, [load]);

  const totals = useMemo(() => {
    const providers = data?.providers || [];
    return {
      healthy: providers.filter((item) => item.status === "healthy").length,
      attention: providers.filter((item) => item.status === "offline" || item.status === "untested").length,
      keys: providers.reduce((total, item) => total + item.keyCount, 0),
    };
  }, [data]);

  const mutate = async (provider: AdminProvider, action: "toggle" | "delete" | "test") => {
    if (action === "delete" && !window.confirm(`Hapus ${provider.displayName}? Route yang masih memakai provider ini harus diubah terlebih dahulu.`)) return;
    setBusyId(provider.id);
    setError("");
    try {
      if (action === "delete") await adminFetch(`/api/admin/providers/${provider.id}`, { method: "DELETE" });
      if (action === "toggle") await adminFetch(`/api/admin/providers/${provider.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !provider.enabled }) });
      if (action === "test") await adminFetch(`/api/admin/providers/${provider.id}/test`, { method: "POST" });
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider tidak dapat diperbarui.");
    } finally {
      setBusyId("");
    }
  };

  const changeDefaultModel = async (provider: AdminProvider, defaultModel: string) => {
    setBusyId(provider.id);
    setError("");
    try {
      await adminFetch(`/api/admin/providers/${provider.id}`, { method: "PATCH", body: JSON.stringify({ defaultModel }) });
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Model default tidak dapat diubah.");
    } finally {
      setBusyId("");
    }
  };

  if (!data && !error) return <AdminLoading label="Memuat provider..." />;
  if (!data) return <AdminError message={error} retry={load} />;

  return <>
    <LocalModeNotice />
    {error && <AdminError message={error} retry={load} />}
    <section className="compact-stats provider-stats">
      <div className="metric-block"><small>Provider tersimpan</small><strong>{data.providers.length}</strong><span>key server-side</span></div>
      <div className="metric-block"><small>Online</small><strong>{totals.healthy}</strong><span>lulus health check</span></div>
      <div className="metric-block"><small>Perlu diperiksa</small><strong>{totals.attention}</strong><span>offline atau belum diuji</span></div>
      <div className="metric-block"><small>API key</small><strong>{totals.keys}</strong><span>di seluruh key pool</span></div>
    </section>

    <section className="panel">
      <div className="panel-head">
        <div><p className="section-kicker">Provider Manager V2</p><h2>AI provider dan key pool</h2><p>Konfigurasi teknis dikelola otomatis. Tambahkan beberapa key provider yang sama untuk memperbesar kapasitas pool.</p></div>
        <button className="button button-primary" onClick={() => setEditing("new")}><Plus size={15} /> Tambah provider</button>
      </div>
      {data.providers.length ? <div className="provider-v2-list">{data.providers.map((provider) => {
        const busy = busyId === provider.id;
        return <article className="provider-v2-row" key={provider.id}>
          <div className="provider-v2-identity">
            <span className={`provider-logo ${provider.code}`}>{provider.displayName.slice(0, 1).toUpperCase()}</span>
            <span><strong>{provider.displayName}</strong><small className={`provider-health ${provider.status}`}><i />{statusLabel(provider.status)}</small></span>
          </div>
          <div className="provider-v2-facts">
            <span><small>Models</small><strong>{provider.availableModels.length}</strong></span>
            <label><small>Default model</small>
              <select value={provider.model} disabled={busy || !provider.availableModels.length} onChange={(event) => changeDefaultModel(provider, event.target.value)}>
                {provider.availableModels.map((model) => <option value={model} key={model}>{model}</option>)}
              </select>
            </label>
            <span><small>Latency</small><strong>{provider.lastLatencyMs ? `${provider.lastLatencyMs} ms` : "-"}</strong></span>
            <span><small>API keys</small><strong>{provider.keyCount}</strong></span>
            <span><small>Last check</small><strong>{provider.lastHealthAt ? formatDate(provider.lastHealthAt) : "Belum pernah"}</strong></span>
          </div>
          {provider.lastError && <p className="provider-inline-error">{provider.lastError}</p>}
          <div className="provider-v2-actions">
            <button className="button button-secondary button-small" disabled={busy} onClick={() => mutate(provider, "test")}><RefreshCw size={14} className={busy ? "spin" : ""} /> Test</button>
            <button className="button button-secondary button-small" disabled={busy} onClick={() => setEditing(provider)}><KeyRound size={14} /> Tambah key</button>
            <button className="icon-button" title={provider.enabled ? "Nonaktifkan provider" : "Aktifkan provider"} disabled={busy} onClick={() => mutate(provider, "toggle")}><Power size={16} /></button>
            <button className="icon-button danger-icon" title="Hapus provider" disabled={busy} onClick={() => mutate(provider, "delete")}><Trash2 size={16} /></button>
          </div>
        </article>;
      })}</div> : <EmptyState title="Belum ada provider" detail="Tambahkan DeepSeek, Gemini, OpenAI, Qwen, atau Claude. Server akan memvalidasi key sebelum menyimpannya." />}
    </section>

    <section className="panel security-notice">
      <div className="process-strip"><span><KeyRound size={18} /><strong>API key</strong><small>admin paste sekali</small></span><i>→</i><span><ServerCog size={18} /><strong>Auto detect</strong><small>endpoint, model, latency</small></span><i>→</i><span><ShieldCheck size={18} /><strong>Encrypted pool</strong><small>siap untuk AI Router</small></span></div>
    </section>

    {editing && <ProviderForm
      provider={editing === "new" ? undefined : editing}
      catalog={data.catalog}
      onClose={() => setEditing(null)}
      onSaved={() => { setEditing(null); load(); }}
    />}
  </>;
}
