import { AppShell } from "@/components/app-shell";

export default function InvoicesPage() {
  return (
    <AppShell eyebrow="Invoices" title="Invoice history">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Billing documents</p><h2>Manage your invoices</h2><p>Semua pembayaran dan invoice ditampilkan di sini.</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody><tr><td>#INV-001</td><td>Rp99.000</td><td>Paid</td><td>01 Jul 2026</td></tr><tr><td>#INV-002</td><td>Rp299.000</td><td>Paid</td><td>20 Jun 2026</td></tr></tbody></table></div>
      </section>
    </AppShell>
  );
}
