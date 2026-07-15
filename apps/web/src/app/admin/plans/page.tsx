import { AppShell } from "@/components/app-shell";

const plans = [
  { name: "Starter", price: "Rp149.000", users: 2, token: "200k", features: ["Basic AI routing", "Desktop activation", "Standard support"] },
  { name: "Pro", price: "Rp299.000", users: 5, token: "500k", features: ["Priority provider", "Multi-device", "Extended quota"] },
  { name: "Business", price: "Rp549.000", users: 12, token: "1.2M", features: ["Custom provider pools", "Billing export", "Team access"] },
];

export default function AdminPlansPage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="Users & Plans">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Plan management</p><h2>Manage packages and quotas</h2><p>Atur plan Starter, Pro, Business, serta fitur dan batas token pengguna.</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Plan</th><th>Price</th><th>Users</th><th>Token</th><th>Features</th></tr></thead><tbody>
            {plans.map((plan) => (
              <tr key={plan.name}><td>{plan.name}</td><td>{plan.price}</td><td>{plan.users}</td><td>{plan.token}</td><td>{plan.features.join(", ")}</td></tr>
            ))}
          </tbody></table></div>
      </section>
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Plan actions</p><h2>CRUD plans</h2><p>Buat, update, atau hapus paket tanpa harus mengedit kode. Semua perubahan berlaku untuk user baru.</p></div></div>
        <div className="finance-grid"><span><small>Total plans</small><strong>{plans.length}</strong></span><span><small>Active users</small><strong>246</strong></span><span><small>Current quota</small><strong>2.1M tokens</strong></span><span><small>Pending changes</small><strong>1</strong></span></div>
      </section>
    </AppShell>
  );
}
