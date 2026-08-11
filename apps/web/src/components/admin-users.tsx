"use client";

import { Ban, CheckCircle2, Copy, Eye, EyeOff, KeyRound, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { adminFetch, type AdminUser, formatDate } from "@/lib/admin-api";
import { AdminError, AdminLoading, AdminModal, EmptyState, LocalModeNotice } from "@/components/admin-ui";

interface UsersPayload { mode: string; users: AdminUser[] }

function UserForm({ user, onClose, onSaved }: { user?: AdminUser; onClose: () => void; onSaved: () => void }) {
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
      status: String(form.get("status") || "active"),
      credits: Number(form.get("credits") || 0),
      unlimitedCredits: form.get("unlimitedCredits") === "on",
      deviceLimit: Number(form.get("deviceLimit") || 1),
    };
    try {
      await adminFetch(user ? `/api/admin/users/${user.id}` : "/api/admin/users", { method: user ? "PATCH" : "POST", body: JSON.stringify(payload) });
      onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Tidak dapat menyimpan user."); }
    finally { setSaving(false); }
  };
  return <AdminModal title={user ? "Edit user" : "Add user"} detail={user ? "Ubah akses, credit, dan batas device." : "Buat akun member lokal dengan password sementara."} onClose={onClose}>
    <form className="admin-form" onSubmit={submit}>
      <div className="form-grid">
        <label className="field-label">Nama<input name="displayName" defaultValue={user?.displayName || ""} required minLength={2} /></label>
        <label className="field-label">Email<input name="email" type="email" defaultValue={user?.email || ""} required disabled={Boolean(user)} /></label>
        {!user && <label className="field-label">Password awal<input name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>}
        {user && <label className="field-label">Status<select name="status" defaultValue={user.status}><option value="active">Active</option><option value="suspended">Suspended</option></select></label>}
        <label className="field-label">Credits<input name="credits" type="number" min={0} defaultValue={user?.credits ?? 0} /></label>
        <label className="field-label">Device limit<input name="deviceLimit" type="number" min={1} max={50} defaultValue={user?.deviceLimit || 1} /></label>
        <label className="check-row"><input name="unlimitedCredits" type="checkbox" defaultChecked={user?.unlimitedCredits || false} /> Unlimited credit untuk akun uji internal</label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? "Saving..." : "Save user"}</button></div>
    </form>
  </AdminModal>;
}

interface TemporaryPasswordResult {
  ok: true;
  temporaryPassword: string;
  expiresAt: string;
  resetId: string;
  sessionsRevoked: true;
}

function PasswordResetForm({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<TemporaryPasswordResult | null>(null);
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true); setError("");
    try {
      const next = await adminFetch<TemporaryPasswordResult>(`/api/admin/users/${user.id}/password-reset`, { method: "POST" });
      setResult(next);
      onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Reset password gagal. Silakan coba lagi."); }
    finally { setSaving(false); }
  };
  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.temporaryPassword);
      setCopied(true);
    } catch {
      setError("Clipboard tidak tersedia. Tampilkan password lalu salin secara manual.");
      setVisible(true);
    }
  };
  if (result) return <AdminModal title="Password sementara berhasil dibuat" detail={`Akun ${user.email} sekarang wajib membuat password baru.`} onClose={onClose}>
    <div className="admin-form" aria-live="polite">
      <p className="form-notice">Password lama dan seluruh sesi web/desktop sudah dinonaktifkan. Password ini hanya ditampilkan satu kali.</p>
      <label className="field-label">Password sementara
        <span className="admin-secret-field"><code>{visible ? result.temporaryPassword : "••••••••••••••••••"}</code><button type="button" className="icon-button" aria-label={visible ? "Sembunyikan password" : "Tampilkan password"} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={15} /> : <Eye size={15} />}</button><button type="button" className="icon-button" aria-label="Salin password sementara" onClick={() => void copy()}><Copy size={15} /></button></span>
      </label>
      <p className="form-help">Berlaku sampai {formatDate(result.expiresAt)}. Setelah dialog ditutup, password tidak dapat ditampilkan kembali.</p>
      {copied && <p className="form-success">Password berhasil disalin.</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => void copy()}><Copy size={15} /> Salin password</button><button className="button button-primary" onClick={onClose}>Selesai</button></div>
    </div>
  </AdminModal>;
  return <AdminModal title="Reset password" detail={`Reset ${user.email}? Password lama akan dinonaktifkan dan user akan menerima password sementara.`} onClose={onClose}>
    <form className="admin-form" onSubmit={submit}>
      <p className="form-notice">Tindakan ini mencabut semua sesi web dan desktop. API key, wallet, dan data user tidak dihapus.</p>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Batal</button><button className="button button-primary" disabled={saving}>{saving ? "Membuat..." : "Buat password sementara"}</button></div>
    </form>
  </AdminModal>;
}

export function AdminUsers() {
  const [data, setData] = useState<UsersPayload | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<AdminUser | null | "new">(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const load = useCallback(() => { setError(""); adminFetch<UsersPayload>("/api/admin/users").then(setData).catch((reason) => setError(reason.message)); }, []);
  useEffect(load, [load]);
  const filtered = useMemo(() => (data?.users || []).filter((user) => {
    const matchQuery = `${user.displayName} ${user.email}`.toLowerCase().includes(query.toLowerCase());
    return matchQuery && (status === "all" || user.status === status);
  }), [data, query, status]);

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
      <div className="metric-block"><small>Credit accounts</small><strong>{members.filter((user) => user.credits > 0 || user.unlimitedCredits).length}</strong><span>funded or unlimited accounts</span></div>
    </div>
    <section className="panel table-panel">
      <div className="panel-head admin-toolbar"><div><p className="section-kicker">User management</p><h2>Accounts and access</h2><p>Admin account dilindungi. Member dapat dibuat, diubah, ditangguhkan, atau dihapus.</p></div><div className="toolbar-actions"><label className="search-box"><Search size={15} /><input aria-label="Cari user" placeholder="Search user..." value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="Filter status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All status</option><option value="active">Active</option><option value="suspended">Suspended</option></select><button className="button button-primary" onClick={() => setEditing("new")}><Plus size={15} /> Add user</button></div></div>
      {filtered.length ? <div className="table-scroll"><table><thead><tr><th>User</th><th>Role</th><th>Credits</th><th>Devices</th><th>Status</th><th>Password recovery</th><th>Last activity</th><th>Actions</th></tr></thead><tbody>{filtered.map((user) => <tr key={user.id}><td><strong>{user.displayName}</strong><small>{user.email}</small></td><td>{user.role}</td><td>{user.unlimitedCredits ? "Unlimited" : user.credits.toLocaleString("id-ID")}</td><td>{user.deviceLimit || "-"}</td><td><span className={user.status === "active" ? "status-tag healthy" : "status-tag danger-tag"}>{user.status}</span></td><td>{user.passwordRecovery?.status === "reset_required" ? <span className="status-tag fallback">Reset required</span> : <span className="status-tag healthy">Normal</span>}<small>{user.passwordRecovery?.expiresAt ? `Berakhir ${formatDate(user.passwordRecovery.expiresAt)}` : "Admin-assisted"}</small></td><td>{formatDate(user.lastActiveAt)}</td><td><div className="row-actions"><button className="icon-button" title="Reset password" aria-label={`Reset password ${user.email}`} disabled={user.protected} onClick={() => setResetting(user)}><KeyRound size={15} /></button><button className="icon-button" title="Edit user" aria-label={`Edit ${user.email}`} disabled={user.protected} onClick={() => setEditing(user)}><Pencil size={15} /></button><button className="icon-button" title={user.status === "active" ? "Suspend" : "Activate"} aria-label={`${user.status === "active" ? "Suspend" : "Activate"} ${user.email}`} disabled={user.protected} onClick={() => mutate(user, "toggle")}>{user.status === "active" ? <Ban size={15} /> : <CheckCircle2 size={15} />}</button><button className="icon-button danger-icon" title="Delete" aria-label={`Delete ${user.email}`} disabled={user.protected || user.role !== "member"} onClick={() => mutate(user, "delete")}><Trash2 size={15} /></button></div></td></tr>)}</tbody></table></div> : <EmptyState title="No users found" detail="Ubah kata pencarian atau filter status." />}
    </section>
    {editing && <UserForm user={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    {resetting && <PasswordResetForm user={resetting} onClose={() => setResetting(null)} onSaved={() => { setResetting(null); load(); }} />}
  </>;
}
