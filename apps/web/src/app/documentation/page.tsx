import { AppShell } from "@/components/app-shell";

export default function DocumentationPage() {
  return (
    <AppShell eyebrow="Documentation" title="Developer docs">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Docs</p><h2>API & integration guide</h2><p>Semua dokumentasi desktop, license verify, dan AI router ada di sini.</p></div></div>
        <div className="readiness-list"><span><i className="ready" /><strong>License API</strong><small>POST /license/verify</small></span><span><i className="ready" /><strong>Feature flags</strong><small>Plan-based capability response</small></span><span><i className="ready" /><strong>AI Gateway</strong><small>/api/highlight, /api/translate, dsb.</small></span></div>
      </section>
    </AppShell>
  );
}
