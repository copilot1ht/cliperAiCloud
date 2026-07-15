"use client";

import { Ban, CheckCircle2, Pencil, Plus, Search, Trash2, UserRoundCog } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { adminFetch, type AdminPlan, type AdminUser, formatDate, formatIdr } from "@/lib/admin-api";
import { AdminError, AdminLoading, AdminModal, EmptyState, LocalModeNotice } from "@/components/admin-ui";

interface UsersPayload { mode: string; users: AdminUser[]; plans: AdminPlan[] }

function UserForm({ user, plans, onClose, onSaved }: { user?: AdminUser; plans: AdminPlan[]; onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    const payload = {
      displayName: String(form.get("displayName") || ""),
      email: String(form.get("email") || ""),
      password: String(form.get("password") || ""),
      plan: String(form.get("plan") || "free"),
      status: String(form.get("status") || "active"),
      credits: Number(form.get("credits") || 0),
      deviceLimit: Number(form.get("deviceLimit") || 1),
    };
    try {
      await adminFetch(user ? `/api/admin/users/${user.id}` : "/api/admin/users", { method: user ? "PATCH" : "POST", body: JSON.stringify(payload) });
      onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Tidak dapat menyimpan user."); }
    finally { setSaving(false); }
  };
  return <AdminModal title={user ? "Edit user" : "Add user"} detail={user ? "Ubah akses, paket, credit, dan batas device." : "Buat akun member lokal dengan password sementara."} onClose={onClose}>
    <form className="admin-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="field-label">Nama<input name="displayName" defaultValue={user?.displayName || ""} required minLength={2} /></label>
        <label className="field-label">Email<input name="email" type="email" defaultValue={user?.email || ""} required disabled={Boolean(user)} /></label>
        {!user && <label className="field-label">Password sementara<input name="password" type="password" required minLength={10} autoComplete="new-password" /></label>}
        <label className="field-label">Plan<select name="plan" defaultValue={user?.plan || "free"}>{plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}</select></label>
        {user && <label className="field-label">Status<select name="status" defaultValue={user.status}><option value="active">Active</option><option value="suspended">Suspended</option></select></label>}
        <label className="field-label">Credits<input name="credits" type="number" min={0} defaultValue={user?.credits ?? 0} /></label>
        <label className="field-label">Device limit<input name="deviceLimit" type="number" min={1} max={50} defaultValue={user?.deviceLimit || 1} /></label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? "Saving..." : "Save user"}</button></div>
    </form>
  </AdminModal>;
}

export function AdminUsers() {
  const [data, setData] = useState<UsersPayload | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [plan, setPlan] = useState("all");
  const [editing, setEditing] = useState<AdminUser | null | "new">(null);
  const load = useCallback(() => { setError(""); adminFetch<UsersPayload>("/api/admin/users").then(setData).catch((reason) => setError(reason.message)); }, []);
  useEffect(load, [load]);
  const filtered = useMemo(() => (data?.users || []).filter((user) => {
    const matchQuery = `${user.displayName} ${user.email}`.toLowerCase().includes(query.toLowerCase());
    return matchQuery && (plan === "all" || user.plan === plan);
  }), [data, query, plan]);

  const mutate = async (user: AdminUser, action: "toggle" | "delete") => {
    if (user.protected) return;
    const verb = action === "delete" ? "menghapus" : user.status === "active" ? "menangguhkan" : "mengaktifkan";
    if (!window.confirm(`Yakin ingin ${verb} ${user.email}?`)) return;
    try {
      if (action === "delete") await adminFetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
      else await adminFetch(`/api/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ status: user.status === "active" ? "suspended" : "active" }) });
      load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Perubahan gagal."); }
  };

  if (error && !data) return <><LocalModeNotice /><AdminError message={error} retry={load} /></>;
  if (!data) return <AdminLoading />;
  const members = data.users.filter((user) => user.role === "member");
  return <>
    <LocalModeNotice />
    {error && <AdminError message={error} retry={load} />}
    <div className="stats-grid compact-stats">
      <div className="metric-block"><small>Total accounts</small><strong>{data.users.length}</strong><span>including protected admin</span></div>
      <div className="metric-block"><small>Active members</small><strong>{members.filter((user) => user.status === "active").length}</strong><span>can access Cliper Cloud</span></div>
      <div className="metric-block"><small>Suspended</small><strong>{members.filter((user) => user.status === "suspended").length}</strong><span>sessions revoked</span></div>
      <div className="metric-block"><small>Plans</small><strong>{data.plans.length}</strong><span>available packages</span></div>
    </div>
    <section className="panel table-panel">
      <div className="panel-head admin-toolbar"><div><p className="section-kicker">User management</p><h2>Accounts and access</h2><p>Admin account dilindungi. Member dapat dibuat, diubah, ditangguhkan, atau dihapus.</p></div><div className="toolbar-actions"><label className="search-box"><Search size={15} /><input aria-label="Cari user" placeholder="Search user..." value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="Filter plan" value={plan} onChange={(event) => setPlan(event.target.value)}><option value="all">All plans</option>{data.plans.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select><button className="button button-primary" onClick={() => setEditing("new")}><Plus size={15} /> Add user</button></div></div>
      {filtered.length ? <div className="table-scroll"><table><thead><tr><th>User</th><th>Role</th><th>Plan</th><th>Credits</th><th>Devices</th><th>Status</th><th>Last activity</th><th>Actions</th></tr></thead><tbody>{filtered.map((user) => <tr key={user.id}><td><strong>{user.displayName}</strong><small>{user.email}</small></td><td>{user.role}</td><td><span className="plan-chip">{user.plan}</span></td><td>{user.credits.toLocaleString("id-ID")}</td><td>{user.deviceLimit || "-"}</td><td><span className={user.status === "active" ? "status-tag healthy" : "status-tag danger-tag"}>{user.status}</span></td><td>{formatDate(user.lastActiveAt)}</td><td><div className="row-actions"><button className="icon-button" title="Edit user" aria-label={`Edit ${user.email}`} disabled={user.protected} onClick={() => setEditing(user)}><Pencil size={15} /></button><button className="icon-button" title={user.status === "active" ? "Suspend" : "Activate"} aria-label={`${user.status === "active" ? "Suspend" : "Activate"} ${user.email}`} disabled={user.protected} onClick={() => mutate(user, "toggle")}>{user.status === "active" ? <Ban size={15} /> : <CheckCircle2 size={15} />}</button><button className="icon-button danger-icon" title="Delete" aria-label={`Delete ${user.email}`} disabled={user.protected} onClick={() => mutate(user, "delete")}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div> : <EmptyState title="No users found" detail="Ubah kata pencarian atau filter plan." />}
    </section>
    <section className="panel"><div className="panel-head"><div><p className="section-kicker">Plan catalog</p><h2>Packages assigned to users</h2><p>Harga dan quota ditampilkan untuk referensi admin. Billing gateway akan dihubungkan pada fase PostgreSQL.</p></div></div><div className="table-scroll"><table><thead><tr><th>Plan</th><th>Price</th><th>Credits</th><th>Device limit</th><th>Status</th></tr></thead><tbody>{data.plans.map((item) => <tr key={item.code}><td><strong>{item.name}</strong><small>{item.code}</small></td><td>{item.priceIdr ? formatIdr(item.priceIdr) : "Custom / Free"}</td><td>{item.credits ? item.credits.toLocaleString("id-ID") : "Custom"}</td><td>{item.deviceLimit}</td><td><span className="status-tag healthy">Active</span></td></tr>)}</tbody></table></div></section>
    {editing && <UserForm user={editing === "new" ? undefined : editing} plans={data.plans} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
  </>;
}
