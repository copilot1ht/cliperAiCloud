"use client";

import { KeyRound, Pencil, Plus, Power, ServerCog, ShieldCheck, Trash2 } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { adminFetch, type AdminProvider, formatDate } from "@/lib/admin-api";
import { AdminError, AdminLoading, AdminModal, EmptyState, LocalModeNotice } from "@/components/admin-ui";

interface ProviderPayload { mode: string; providers: AdminProvider[] }

function ProviderForm({ provider, onClose, onSaved }: { provider?: AdminProvider; onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    const payload = {
      displayName: String(form.get("displayName") || ""), code: String(form.get("code") || ""),
      baseUrl: String(form.get("baseUrl") || ""), model: String(form.get("model") || ""),
      apiKeys: String(form.get("apiKeys") || ""), enabled: form.get("enabled") === "on",
      priority: Number(form.get("priority") || 100), timeoutMs: Number(form.get("timeoutMs") || 45000),
      inputUsdPerM: Number(form.get("inputUsdPerM") || 0), outputUsdPerM: Number(form.get("outputUsdPerM") || 0),
    };
    try {
      await adminFetch(provider ? `/api/admin/providers/${provider.id}` : "/api/admin/providers", { method: provider ? "PATCH" : "POST", body: JSON.stringify(payload) });
      onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Provider tidak dapat disimpan."); }
    finally { setSaving(false); }
  };
  return <AdminModal title={provider ? "Edit provider" : "Add provider"} detail="Konfigurasi OpenAI-compatible. Secret hanya masuk ke API server dan tidak dikirim kembali ke browser." onClose={onClose}>
    <form className="admin-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="field-label">Provider name<input name="displayName" defaultValue={provider?.displayName || ""} placeholder="Google Gemini" required /></label>
        <label className="field-label">Code<input name="code" defaultValue={provider?.code || ""} placeholder="gemini" required pattern="[A-Za-z0-9_-]+" /></label>
        <label className="field-label field-span-2">Base URL<input name="baseUrl" type="url" defaultValue={provider?.baseUrl || ""} placeholder="https://provider.example/v1" required /></label>
        <label className="field-label">Default model<input name="model" defaultValue={provider?.model || ""} placeholder="model-name" required /></label>
        <label className="field-label">Timeout (ms)<input name="timeoutMs" type="number" min={5000} max={120000} step={1000} defaultValue={provider?.timeoutMs || 45000} /></label>
        <label className="field-label">Priority<input name="priority" type="number" min={1} max={999} defaultValue={provider?.priority || 100} /></label>
        <label className="field-label checkbox-field"><input name="enabled" type="checkbox" defaultChecked={provider?.enabled !== false} /> Enable provider</label>
        <label className="field-label">Input USD / 1M tokens<input name="inputUsdPerM" type="number" min={0} step="0.0001" defaultValue={provider?.inputUsdPerM || 0} /></label>
        <label className="field-label">Output USD / 1M tokens<input name="outputUsdPerM" type="number" min={0} step="0.0001" defaultValue={provider?.outputUsdPerM || 0} /></label>
        <label className="field-label field-span-2">API key pool<textarea name="apiKeys" rows={4} placeholder={provider?.keyCount ? `Kosongkan untuk mempertahankan ${provider.keyCount} key yang tersimpan` : "Satu key per baris atau pisahkan dengan koma"} autoComplete="off" spellCheck={false} /></label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? "Saving..." : "Save provider"}</button></div>
    </form>
  </AdminModal>;
}

export function AdminProviders() {
  const [data, setData] = useState<ProviderPayload | null>(null);
  const [editing, setEditing] = useState<AdminProvider | null | "new">(null);
  const [error, setError] = useState("");
  const load = useCallback(() => { setError(""); adminFetch<ProviderPayload>("/api/admin/providers").then(setData).catch((reason) => setError(reason.message)); }, []);
  useEffect(load, [load]);
  const update = async (provider: AdminProvider, action: "toggle" | "delete") => {
    if (action === "delete" && !window.confirm(`Hapus provider ${provider.displayName}? Aturan router yang memakai code ini perlu diperbarui.`)) return;
    try {
      if (action === "delete") await adminFetch(`/api/admin/providers/${provider.id}`, { method: "DELETE" });
      else await adminFetch(`/api/admin/providers/${provider.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !provider.enabled }) });
      load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Provider tidak dapat diubah."); }
  };
  if (error && !data) return <><LocalModeNotice /><AdminError message={error} retry={load} /></>;
  if (!data) return <AdminLoading />;
  const ready = data.providers.filter((item) => item.status === "ready").length;
  return <>
    <LocalModeNotice />
    {error && <AdminError message={error} retry={load} />}
    <div className="notice-line security-notice"><div><ShieldCheck size={17} /><span><strong>Secret safety.</strong> Browser hanya menerima jumlah dan preview key. Nilai API key lengkap tidak pernah dikembalikan oleh endpoint admin.</span></div></div>
    <div className="stats-grid compact-stats">
      <div className="metric-block"><small>Total providers</small><strong>{data.providers.length}</strong><span>flexible OpenAI-compatible</span></div>
      <div className="metric-block"><small>Ready</small><strong>{ready}</strong><span>enabled with key</span></div>
      <div className="metric-block"><small>Need key</small><strong>{data.providers.filter((item) => item.status === "needs-key").length}</strong><span>not routable yet</span></div>
      <div className="metric-block"><small>Keys in pool</small><strong>{data.providers.reduce((total, item) => total + item.keyCount, 0)}</strong><span>rotated by gateway</span></div>
    </div>
    <section className="panel table-panel">
      <div className="panel-head"><div><p className="section-kicker">Provider manager</p><h2>AI providers and server-side key pools</h2><p>Tambah Gemini, DeepSeek, OpenAI, Groq, atau provider lain selama endpoint kompatibel dengan Chat Completions.</p></div><button className="button button-primary" onClick={() => setEditing("new")}><Plus size={15} /> Add provider</button></div>
      {data.providers.length ? <div className="provider-admin-list">{data.providers.map((provider) => <article className="provider-admin-row" key={provider.id}>
        <span className={`provider-logo ${provider.code}`}>{provider.displayName.slice(0, 1).toUpperCase()}</span>
        <span className="provider-identity"><strong>{provider.displayName}</strong><small>{provider.baseUrl}</small></span>
        <span><small>Model</small><code>{provider.model}</code></span>
        <span><small>Key pool</small><strong>{provider.keyCount} {provider.keyPreview && `· ${provider.keyPreview}`}</strong></span>
        <span><small>Status</small><b className={provider.status === "ready" ? "status-tag healthy" : provider.status === "disabled" ? "status-tag muted-tag" : "status-tag fallback"}>{provider.status}</b></span>
        <span className="provider-actions"><button className="icon-button" title="Edit provider" onClick={() => setEditing(provider)}><Pencil size={15} /></button><button className="icon-button" title={provider.enabled ? "Disable" : "Enable"} onClick={() => update(provider, "toggle")}><Power size={15} /></button><button className="icon-button danger-icon" title="Delete provider" onClick={() => update(provider, "delete")}><Trash2 size={15} /></button></span>
      </article>)}</div> : <EmptyState title="No providers configured" detail="Tambahkan minimal satu provider dan API key agar gateway dapat memproses request desktop." />}
    </section>
    <section className="panel"><div className="panel-head"><div><p className="section-kicker">How it works</p><h2>Flexible provider pool</h2><p>Desktop hanya menggunakan satu Cliper key. Gateway memilih provider berdasarkan AI Router, lalu merotasi key dalam pool ketika request masuk.</p></div></div><div className="process-strip"><span><KeyRound size={18} /><strong>Cliper key</strong><small>from desktop</small></span><i>→</i><span><ServerCog size={18} /><strong>AI Router</strong><small>select provider</small></span><i>→</i><span><ShieldCheck size={18} /><strong>Provider key</strong><small>server-side only</small></span></div></section>
    {editing && <ProviderForm provider={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
  </>;
}
