"use client";

import { RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { adminFetch, formatDate, formatIdr, type PaymentRecord } from "@/lib/admin-api";
import { AdminError, AdminLoading, EmptyState } from "@/components/admin-ui";

interface PaymentsPayload {
  mode: "postgresql";
  summary: { grossIdr: number; refundedIdr: number; netIdr: number; paidCount: number; pendingCount: number; failedCount: number; expiredCount: number; activeSubscriptions: number };
  payments: PaymentRecord[];
}

export function AdminPayments() {
  const [data, setData] = useState<PaymentsPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const load = useCallback(() => {
    setError("");
    adminFetch<PaymentsPayload>("/api/admin/payments").then(setData).catch((reason) => setError(reason.message));
  }, []);
  useEffect(load, [load]);
  const filtered = useMemo(() => (data?.payments || []).filter((item) => (
    `${item.reference} ${item.customerEmail}`.toLowerCase().includes(query.toLowerCase()) && (status === "all" || item.status === status)
  )), [data, query, status]);

  const refund = async (payment: PaymentRecord) => {
    if (!window.confirm(`Refund ${payment.reference}? Credit terkait akan dibatalkan bila saldo masih tersedia.`)) return;
    setBusy(payment.id); setError("");
    try {
      await adminFetch(`/api/admin/payments/${payment.id}/refund`, { method: "POST" });
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Refund gagal diproses.");
    } finally { setBusy(""); }
  };

  const syncStatus = async (payment: PaymentRecord) => {
    setBusy(`sync:${payment.id}`); setError("");
    try {
      await adminFetch(`/api/admin/payments/${payment.id}/sync`, { method: "POST" });
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Status provider gagal disinkronkan.");
    } finally { setBusy(""); }
  };

  if (error && !data) return <AdminError message={error} retry={load} />;
  if (!data) return <AdminLoading />;
  return <>{error && <AdminError message={error} retry={load} />}
    <div className="notice-line"><div><ShieldCheck size={17} /><span><strong>Webhook is the payment authority.</strong> Admin tidak dapat membuat, menghapus, atau menandai transaksi sebagai paid secara manual.</span></div></div>
    <div className="stats-grid compact-stats"><div className="metric-block"><small>Gross received</small><strong>{formatIdr(data.summary.grossIdr)}</strong><span>{data.summary.paidCount} verified payments</span></div><div className="metric-block"><small>Net revenue</small><strong>{formatIdr(data.summary.netIdr)}</strong><span>{formatIdr(data.summary.refundedIdr)} refunded</span></div><div className="metric-block"><small>Pending</small><strong>{data.summary.pendingCount}</strong><span>{data.summary.expiredCount} expired</span></div><div className="metric-block"><small>Credit top-ups</small><strong>{data.payments.length}</strong><span>wallet transactions recorded</span></div></div>
    <section className="panel table-panel"><div className="panel-head admin-toolbar"><div><p className="section-kicker">Immutable payment ledger</p><h2>Provider transactions</h2><p>Paid status hanya berasal dari callback bertanda tangan dan diproses idempotent di PostgreSQL.</p></div><div className="toolbar-actions"><label className="search-box"><Search size={15} /><input aria-label="Cari pembayaran" placeholder="Reference or email..." value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="Filter status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All status</option><option value="paid">Paid</option><option value="pending">Pending</option><option value="failed">Failed</option><option value="expired">Expired</option><option value="refunded">Refunded</option></select><button className="button button-secondary" onClick={load}><RefreshCw size={15} /> Refresh</button></div></div>
      {filtered.length ? <div className="table-scroll"><table><thead><tr><th>Reference</th><th>Customer</th><th>Amount</th><th>Provider</th><th>Status</th><th>Recorded</th><th>Action</th></tr></thead><tbody>{filtered.map((payment) => <tr key={payment.id}><td><strong>{payment.reference}</strong></td><td>{payment.customerEmail}</td><td>{formatIdr(payment.amountIdr)}</td><td>{payment.method}</td><td><span className={payment.status === "paid" ? "status-tag healthy" : payment.status === "failed" || payment.status === "refunded" ? "status-tag danger-tag" : "status-tag fallback"}>{payment.status}</span></td><td>{formatDate(payment.createdAt)}</td><td><div className="toolbar-actions">{payment.status !== "paid" && payment.status !== "refunded" && <button className="button button-secondary compact-button" disabled={busy === `sync:${payment.id}`} onClick={() => void syncStatus(payment)}>{busy === `sync:${payment.id}` ? "Checking..." : "Sync status"}</button>}{payment.status === "paid" ? <button className="button button-secondary compact-button" disabled={busy === payment.id} onClick={() => void refund(payment)}>{busy === payment.id ? "Processing..." : "Refund"}</button> : null}</div></td></tr>)}</tbody></table></div> : <EmptyState title="No provider payments" detail="Belum ada invoice yang diproses oleh Payment Engine PostgreSQL." />}
    </section>
  </>;
}
