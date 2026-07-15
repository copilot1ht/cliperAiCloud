import { AppShell } from "@/components/app-shell";
import { CreditCard, Check } from "lucide-react";

const transactions = [
  { id: "TXN-001", description: "Top-up credits", amount: "Rp350.000", date: "01 Jul 2026", status: "Paid" },
  { id: "TXN-002", description: "API key creation", amount: "Rp0", date: "29 Jun 2026", status: "Completed" },
  { id: "TXN-003", description: "Subscription Pro", amount: "Rp299.000", date: "20 Jun 2026", status: "Paid" },
];

export default function TransactionsPage() {
  return (
    <AppShell eyebrow="Transactions" title="Transaction history">
      <section className="panel table-panel">
        <div className="panel-head"><div><p className="section-kicker">Payments & credits</p><h2>Riwayat transaksi</h2><p>Semua aktivitas biaya, top-up, dan tagihan tampil di sini.</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>ID</th><th>Activity</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>
            {transactions.map((txn) => (
              <tr key={txn.id}><td>{txn.id}</td><td>{txn.description}</td><td>{txn.amount}</td><td><span className={txn.status === "Paid" ? "status-tag healthy" : "status-tag fallback"}>{txn.status}</span></td><td>{txn.date}</td></tr>
            ))}
          </tbody></table></div>
      </section>
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Need help?</p><h2>Tanya billing atau top-up</h2><p>Jika membutuhkan bantuan top-up atau invoice, buka halaman Support.</p></div></div></section>
    </AppShell>
  );
}
