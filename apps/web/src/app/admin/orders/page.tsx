import { AppShell } from "@/components/app-shell";

export default function AdminOrdersPage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="Orders">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Order history</p><h2>Payment orders</h2><p>Semua order dan transaksi revenue internal dapat dilihat di sini.</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Order</th><th>User</th><th>Amount</th><th>Status</th></tr></thead><tbody><tr><td>#ORD-001</td><td>andra@cliper.ai</td><td>Rp299.000</td><td>Paid</td></tr></tbody></table></div>
      </section>
    </AppShell>
  );
}
