import { AppShell } from "@/components/app-shell";

export default function AdminQueuePage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="Queue">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Task queue</p><h2>AI request queue</h2><p>Monitor pending tasks dan priority queue untuk AI gateway.</p></div></div>
        <div className="readiness-list"><span><i className="ready" /><strong>Normal</strong><small>0 pending tasks</small></span><span><i className="ready" /><strong>Priority</strong><small>Enabled for Pro & Business</small></span></div>
      </section>
    </AppShell>
  );
}
