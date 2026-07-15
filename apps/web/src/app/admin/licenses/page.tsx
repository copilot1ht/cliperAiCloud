import { AppShell } from "@/components/app-shell";

export default function AdminLicensesPage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="Licenses">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">License overview</p><h2>License & device management</h2><p>Monitor active licenses, expiry, device usage, and status.</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>License</th><th>Plan</th><th>Status</th><th>Devices</th><th>Expires</th></tr></thead><tbody>
            <tr><td>clip_sk_*****ABCD</td><td>Pro</td><td>Active</td><td>2 / 3</td><td>2027-01-12</td></tr>
          </tbody></table></div>
      </section>
    </AppShell>
  );
}
