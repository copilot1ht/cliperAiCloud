import { AppShell } from "@/components/app-shell";

export default function AdminUsagePage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="Usage">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Usage analytics</p><h2>Token & request usage</h2><p>Real-time usage dashboard untuk admin billing dan cost monitoring.</p></div></div>
        <div className="stats-grid"><div className="stat-card"><strong>18.4K</strong><small>Requests today</small></div><div className="stat-card"><strong>1.25M</strong><small>Remaining tokens</small></div></div>
      </section>
    </AppShell>
  );
}
