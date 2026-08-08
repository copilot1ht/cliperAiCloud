"use client";

import { ArchiveRestore, CheckCircle2, Copy, DatabaseBackup, FileSearch, KeyRound, Upload } from "lucide-react";
import { ChangeEvent, useCallback, useEffect, useState } from "react";
import { adminFetch, formatDate } from "@/lib/admin-api";
import { AdminError, AdminLoading } from "@/components/admin-ui";

interface BackupStatus {
  ready: boolean;
  format: string;
  version: number;
  maxArchiveBytes: number;
  maxRows: number;
  exclusions: string[];
  requirements: string[];
  paymentSetup: {
    provider: string;
    environment: string;
    finishRedirectUrl: string;
    notificationUrl: string;
    biSnap: string;
  };
}

interface BackupInspection {
  source: { environment: string; databaseSchema: string };
  createdAt: string;
  tableCounts: Record<string, number>;
  totalRows: number;
  exclusions: string[];
  requiresConfirmation: string;
  effect: string;
}

function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.floor(bytes / 1024 / 1024))} MB`;
}

export function AdminBackups() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [archive, setArchive] = useState<unknown>(null);
  const [archiveName, setArchiveName] = useState("");
  const [inspection, setInspection] = useState<BackupInspection | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"export" | "inspect" | "restore" | "">("");

  const load = useCallback(() => {
    setError("");
    adminFetch<BackupStatus>("/api/admin/backups/status").then(setStatus).catch((reason) => setError(reason.message));
  }, []);
  useEffect(load, [load]);

  const exportBackup = async () => {
    setError(""); setMessage(""); setBusy("export");
    try {
      const result = await adminFetch<{ fileName: string; archive: unknown }>("/api/admin/backups/export", { method: "POST", body: JSON.stringify({ passphrase }) });
      const blob = new Blob([JSON.stringify(result.archive)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = result.fileName; link.click();
      URL.revokeObjectURL(url);
      setPassphrase("");
      setMessage("Backup terenkripsi sudah diunduh. Simpan file dan passphrase di tempat terpisah.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Backup tidak dapat dibuat.");
    } finally { setBusy(""); }
  };

  const selectArchive = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setInspection(null); setArchive(null); setArchiveName(""); setError(""); setMessage("");
    if (!file) return;
    if (status && file.size > status.maxArchiveBytes) {
      setError(`Ukuran file melebihi batas ${formatMegabytes(status.maxArchiveBytes)}.`);
      return;
    }
    try {
      setArchive(JSON.parse(await file.text()));
      setArchiveName(file.name);
    } catch {
      setError("File backup harus berupa JSON Cliper AI Cloud yang valid.");
    }
  };

  const inspectArchive = async () => {
    if (!archive) { setError("Pilih file backup terlebih dahulu."); return; }
    setError(""); setMessage(""); setBusy("inspect");
    try {
      setInspection(await adminFetch<BackupInspection>("/api/admin/backups/inspect", { method: "POST", body: JSON.stringify({ archive, passphrase }) }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Backup tidak dapat diperiksa.");
    } finally { setBusy(""); }
  };

  const restoreArchive = async () => {
    if (!archive || !inspection) { setError("Periksa file backup sebelum restore."); return; }
    setError(""); setMessage(""); setBusy("restore");
    try {
      const result = await adminFetch<{ restored: boolean; totalRows: number; requiresReauthentication: boolean }>("/api/admin/backups/restore", {
        method: "POST",
        body: JSON.stringify({ archive, passphrase, confirmation }),
      });
      setMessage(`${result.totalRows.toLocaleString("id-ID")} record dipulihkan. Semua session telah dihapus; silakan masuk kembali.`);
      window.setTimeout(() => window.location.assign("/login"), 1500);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Restore gagal. Database tidak diubah jika transaksi gagal.");
    } finally { setBusy(""); }
  };

  const copyValue = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setMessage("URL disalin."); } catch { setError("Browser tidak dapat menyalin URL."); }
  };

  if (error && !status) return <AdminError message={error} retry={load} />;
  if (!status) return <AdminLoading label="Memuat operasi backup..." />;

  return <>
    {error && <AdminError message={error} retry={load} />}
    {message && <div className="notice-line backup-success"><div><CheckCircle2 size={17} /><span>{message}</span></div></div>}
    <section className="panel backup-hero">
      <div className="panel-head"><div><p className="section-kicker">Portable control plane</p><h2>Backup database terenkripsi</h2><p>Unduh arsip aplikasi, lalu pulihkan ke PostgreSQL Railway baru tanpa memindahkan video pengguna atau secret provider.</p></div><span className={status.ready ? "status-tag healthy" : "status-tag danger-tag"}>{status.ready ? "PostgreSQL ready" : "Database unavailable"}</span></div>
      <div className="finance-grid backup-facts"><span><small>Archive format</small><strong>{status.format} v{status.version}</strong></span><span><small>Maximum archive</small><strong>{formatMegabytes(status.maxArchiveBytes)}</strong></span><span><small>Maximum rows</small><strong>{status.maxRows.toLocaleString("id-ID")}</strong></span></div>
    </section>
    <div className="backup-grid">
      <section className="panel">
        <div className="panel-head"><div><p className="section-kicker">Step 1</p><h2>Download backup</h2><p>File dilindungi AES-256-GCM. Passphrase tidak dikirim kembali atau disimpan server.</p></div><DatabaseBackup size={22} /></div>
        <label className="field-label" htmlFor="backup-passphrase">Backup passphrase</label>
        <input id="backup-passphrase" type="password" autoComplete="new-password" placeholder="Minimal 14 karakter" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
        <p className="field-help">Simpan passphrase di password manager. Tanpanya, file backup tidak dapat dibuka.</p>
        <div className="panel-actions"><button className="button button-primary" disabled={!status.ready || passphrase.length < 14 || busy !== ""} onClick={() => void exportBackup()}><DatabaseBackup size={16} />{busy === "export" ? "Membuat backup..." : "Download encrypted backup"}</button></div>
      </section>
      <section className="panel">
        <div className="panel-head"><div><p className="section-kicker">Step 2</p><h2>Inspect & restore</h2><p>Upload file ke browser, periksa isinya, lalu lakukan restore hanya jika tujuan database memang baru atau siap diganti.</p></div><ArchiveRestore size={22} /></div>
        <label className="file-field"><Upload size={16} /><span>{archiveName || "Pilih file backup .json"}</span><input type="file" accept="application/json,.json" onChange={(event) => void selectArchive(event)} /></label>
        <label className="field-label" htmlFor="restore-confirmation">Confirmation untuk restore</label>
        <input id="restore-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={inspection?.requiresConfirmation || "Periksa backup terlebih dahulu"} disabled={!inspection} />
        <p className="field-help">Inspection dan restore memakai passphrase yang sama dari Step 1.</p>
        <div className="panel-actions"><button className="button button-secondary" disabled={!archive || passphrase.length < 14 || busy !== ""} onClick={() => void inspectArchive()}><FileSearch size={16} />{busy === "inspect" ? "Memeriksa..." : "Inspect backup"}</button><button className="button button-danger" disabled={!inspection || !status.ready || passphrase.length < 14 || confirmation !== inspection.requiresConfirmation || busy !== ""} onClick={() => void restoreArchive()}><ArchiveRestore size={16} />{busy === "restore" ? "Memulihkan..." : "Restore database"}</button></div>
      </section>
    </div>
    {inspection && <section className="panel table-panel"><div className="panel-head"><div><p className="section-kicker">Verified before write</p><h2>Backup inspection</h2><p>Created {formatDate(inspection.createdAt)} from {inspection.source.environment}/{inspection.source.databaseSchema}. {inspection.effect}</p></div><span className="status-tag fallback">{inspection.totalRows.toLocaleString("id-ID")} rows</span></div><div className="finance-grid backup-facts">{Object.entries(inspection.tableCounts).filter(([, count]) => count > 0).map(([table, count]) => <span key={table}><small>{table}</small><strong>{count.toLocaleString("id-ID")}</strong></span>)}</div></section>}
    <section className="panel"><div className="panel-head"><div><p className="section-kicker">Railway move checklist</p><h2>What moves, what stays secret</h2></div><KeyRound size={22} /></div><div className="backup-requirements">{status.requirements.map((item) => <p key={item}><CheckCircle2 size={16} />{item}</p>)}</div><div className="backup-exclusions"><strong>Not included:</strong>{status.exclusions.map((item) => <span key={item}>{item}</span>)}</div></section>
    <section className="panel"><div className="panel-head"><div><p className="section-kicker">Midtrans configuration</p><h2>Copy only the required URLs</h2><p>Provider status: {status.paymentSetup.provider} · {status.paymentSetup.environment}. Server Key tetap hanya di Railway Variables.</p></div></div><div className="payment-url-list"><div><small>Finish Redirect URL</small><code>{status.paymentSetup.finishRedirectUrl}</code><button className="icon-button" aria-label="Salin Finish Redirect URL" onClick={() => void copyValue(status.paymentSetup.finishRedirectUrl)}><Copy size={16} /></button></div><div><small>Notification URL</small><code>{status.paymentSetup.notificationUrl}</code><button className="icon-button" aria-label="Salin Notification URL" onClick={() => void copyValue(status.paymentSetup.notificationUrl)}><Copy size={16} /></button></div></div><div className="notice-line"><div><KeyRound size={17} /><span><strong>BI-SNAP:</strong> {status.paymentSetup.biSnap}</span></div></div></section>
  </>;
}
