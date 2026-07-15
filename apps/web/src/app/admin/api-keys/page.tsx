import { AppShell } from "@/components/app-shell";

export default function AdminApiKeysPage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="API Keys">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">API key management</p><h2>Generate, revoke, and copy keys</h2><p>Manage keys for desktop activation and backend API access.</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Key</th><th>Plan</th><th>Status</th><th>Devices</th><th>Last used</th></tr></thead><tbody>
            <tr><td>clip_sk_*****ABCD</td><td>Pro</td><td>Active</td><td>2 / 3</td><td>Today</td></tr>
          </tbody></table></div>
      </section>
    </AppShell>
  );
}
