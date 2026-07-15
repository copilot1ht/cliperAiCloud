import { AppShell } from "@/components/app-shell";

export default function AdminSubscriptionsPage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="Subscriptions">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Plans</p><h2>Subscription management</h2><p>Monitoring paket Starter, Pro, Business, dan renewal status.</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Plan</th><th>Users</th><th>Status</th><th>Renewal</th></tr></thead><tbody><tr><td>Pro</td><td>48</td><td>Active</td><td>Monthly</td></tr></tbody></table></div>
      </section>
    </AppShell>
  );
}
