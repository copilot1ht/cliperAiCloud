import { AppShell } from "@/components/app-shell";

export default function AdminLogsPage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="Logs">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Audit log</p><h2>Request & license logs</h2><p>Lihat aktivitas token, verify, dan provider routing.</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Event</th><th>User / Key</th><th>Status</th><th>Time</th></tr></thead><tbody><tr><td>License verify</td><td>sk_live_****ABCD</td><td>Success</td><td>Now</td></tr></tbody></table></div>
      </section>
    </AppShell>
  );
}
