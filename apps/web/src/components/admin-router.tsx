"use client";

import { ArrowRight, Check, CircleHelp, Play, Route, Save, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { adminFetch, type AdminProvider, type RoutingRule } from "@/lib/admin-api";
import { AdminError, AdminLoading, EmptyState, LocalModeNotice } from "@/components/admin-ui";

interface RouterPayload { mode: string; providers: AdminProvider[]; rules: RoutingRule[] }
const moduleNames: Record<string, string> = { story: "Story segmentation", ranking: "Candidate ranking", highlight: "Highlight finder", title: "Title generator", hook: "Hook maker", caption: "Caption cleaner", metadata: "Metadata generator" };

export function AdminRouter() {
  const [data, setData] = useState<RouterPayload | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState("");
  const [saved, setSaved] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const load = useCallback(() => { setError(""); adminFetch<RouterPayload>("/api/admin/router").then(setData).catch((reason) => setError(reason.message)); }, []);
  useEffect(load, [load]);
  const rules = useMemo(() => data?.rules || [], [data]);
  const change = (id: string, field: keyof RoutingRule, value: string | number | boolean) => setData((current) => current ? { ...current, rules: current.rules.map((item) => item.id === id ? { ...item, [field]: value } : item) } : current);
  const save = async (rule: RoutingRule) => {
    setSaving(rule.id); setSaved(""); setError("");
    try {
      await adminFetch(`/api/admin/router/${rule.id}`, { method: "PATCH", body: JSON.stringify(rule) });
      setSaved(rule.id); window.setTimeout(() => setSaved(""), 1800);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Aturan tidak dapat disimpan."); }
    finally { setSaving(""); }
  };
  const testRouter = async () => {
    setTesting(true); setTestResult(""); setError("");
    try {
      const result = await adminFetch<{ response: string; latencyMs: number; usage: { total_tokens?: number } }>("/api/admin/router/test", { method: "POST" });
      setTestResult(`Connected · Auto route · ${result.latencyMs} ms · ${Number(result.usage?.total_tokens || 0)} tokens · ${result.response}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "AI Router test gagal."); }
    finally { setTesting(false); }
  };
  if (error && !data) return <><LocalModeNotice /><AdminError message={error} retry={load} /></>;
  if (!data) return <AdminLoading />;
  const providerOptions = data.providers.filter((provider) => provider.enabled);
  return <>
    <LocalModeNotice />
    {error && <AdminError message={error} retry={load} />}
    <section className="router-explainer">
      <span className="explainer-icon"><Route size={23} /></span>
      <div><p className="section-kicker">What is AI Router?</p><h2>Satu Cliper key, banyak AI provider</h2><p>AI Router adalah pengambil keputusan server. Setiap modul desktop dikirim ke provider utama; jika timeout atau gagal, request otomatis dialihkan ke fallback tanpa meminta user mengganti key.</p>{testResult && <small className="provider-health healthy">{testResult}</small>}</div>
      <div className="explainer-flow"><b>Desktop</b><ArrowRight size={15} /><b>Cliper Cloud</b><ArrowRight size={15} /><b>Primary / fallback</b></div>
      <button className="button button-primary" type="button" onClick={testRouter} disabled={testing || !providerOptions.length}><Play size={15} />{testing ? "Testing..." : "Test auto route"}</button>
    </section>
    <section className="panel table-panel">
      <div className="panel-head admin-toolbar"><div><p className="section-kicker">Routing rules</p><h2>Provider priority per AI module</h2><p>Perubahan berlaku pada request gateway berikutnya. Primary dan fallback tidak boleh kosong.</p></div></div>
      {!providerOptions.length ? <EmptyState title="No enabled providers" detail="Aktifkan provider dan masukkan key terlebih dahulu di halaman Providers." /> : <div className="router-editor-list">{rules.map((rule) => <article className="router-editor-row" key={rule.id}>
        <span className="route-module"><strong>{moduleNames[rule.module] || rule.module}</strong><small>{rule.module} · wallet usage</small></span>
        <label><small>Primary</small><select value={rule.primary} onChange={(event) => change(rule.id, "primary", event.target.value)}>{providerOptions.map((provider) => <option key={provider.code} value={provider.code}>{provider.displayName}</option>)}</select></label>
        <ArrowRight className="route-arrow" size={16} />
        <label><small>Fallback</small><select value={rule.fallback} onChange={(event) => change(rule.id, "fallback", event.target.value)}>{providerOptions.map((provider) => <option key={provider.code} value={provider.code}>{provider.displayName}</option>)}</select></label>
        <label><small>Timeout</small><input type="number" min={5000} max={120000} step={1000} value={rule.timeoutMs} onChange={(event) => change(rule.id, "timeoutMs", Number(event.target.value))} /><em>ms</em></label>
        <label><small>Max tokens</small><input type="number" min={32} max={8000} step={32} value={rule.maxTokens} onChange={(event) => change(rule.id, "maxTokens", Number(event.target.value))} /></label>
        <label className="route-toggle"><input type="checkbox" checked={rule.enabled} onChange={(event) => change(rule.id, "enabled", event.target.checked)} /><span>{rule.enabled ? "On" : "Off"}</span></label>
        <button className="button button-secondary button-small" onClick={() => save(rule)} disabled={saving === rule.id}>{saved === rule.id ? <Check size={14} /> : <Save size={14} />}{saving === rule.id ? "Saving" : saved === rule.id ? "Saved" : "Save"}</button>
      </article>)}</div>}
    </section>
    <div className="two-column">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Recommended logic</p><h2>Quality with controlled fallback</h2></div></div><div className="setting-row"><span><strong>Highlight and story</strong><small>Gunakan model dengan reasoning dan konteks yang kuat.</small></span><ShieldCheck size={18} /></div><div className="setting-row"><span><strong>Title and hook</strong><small>Gunakan model yang konsisten menulis Bahasa Indonesia natural.</small></span><ShieldCheck size={18} /></div><div className="setting-row"><span><strong>Caption cleanup</strong><small>Gunakan model cepat dan murah karena request lebih kecil.</small></span><ShieldCheck size={18} /></div></section>
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Operational note</p><h2>What happens on failure</h2></div></div><div className="callout warning-callout"><CircleHelp size={17} /><span>Gateway mencoba primary sesuai retry policy. Jika provider kosong, timeout, atau error HTTP, router mencoba fallback. Jika semuanya gagal, desktop menerima error yang jelas dan tidak dikenai billing response sukses.</span></div></section>
    </div>
  </>;
}
