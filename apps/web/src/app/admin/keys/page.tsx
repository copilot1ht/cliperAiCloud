import { AppShell } from "@/components/app-shell";

export default function AdminKeysPage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="API Keys">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">License keys</p><h2>Manage API license keys</h2><p>Rotasi, suspend, dan revoke key dari satu tempat.</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Key</th><th>Billing</th><th>Status</th><th>Devices</th></tr></thead><tbody><tr><td>sk_live_****ABCD</td><td>Wallet</td><td>Active</td><td>1 / 1</td></tr></tbody></table></div>
      </section>
    </AppShell>
  );
}
