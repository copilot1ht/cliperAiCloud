"use client";

import { CheckCircle2, Download, ExternalLink, FileArchive, FileText, History, PackageCheck, Pencil, Plus, Save, ShieldCheck } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AdminError, AdminLoading, AdminModal, EmptyState } from "@/components/admin-ui";
import { adminFetch, formatDate } from "@/lib/admin-api";
import { apiBase } from "@/lib/api-base";
import {
  desktopReleaseChannels,
  desktopReleaseStates,
  releaseHasDownload,
  releaseStateLabel,
  type DesktopRelease,
  type DesktopReleaseCatalog,
  type DesktopReleaseChannel,
  type DesktopReleaseState,
} from "@/lib/desktop-releases";

interface ReleaseFormState {
  version: string;
  channel: DesktopReleaseChannel;
  state: DesktopReleaseState;
  notes: string;
  setupUrl: string;
  portableUrl: string;
  checksumsUrl: string;
  isCurrent: boolean;
}

function asReleaseForm(release?: DesktopRelease): ReleaseFormState {
  return {
    version: release?.version || "",
    channel: release?.channel || "beta",
    state: release?.state || "DRAFT",
    notes: release?.notes.join("\n") || "",
    setupUrl: release?.setupUrl || "",
    portableUrl: release?.portableUrl || "",
    checksumsUrl: release?.checksumsUrl || "",
    isCurrent: release?.isCurrent || false,
  };
}

function stateClass(state: DesktopReleaseState): string {
  return `release-state release-state-${state.toLowerCase()}`;
}

async function publicFetch<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, { cache: "no-store", credentials: "include" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = Array.isArray(payload?.message) ? payload.message.join(" ") : payload?.message;
    throw new Error(message || `Katalog release tidak dapat dimuat (${response.status}).`);
  }
  return payload as T;
}

function ReleaseLink({ href, children, icon = <ExternalLink size={15} /> }: { href: string | null; children: React.ReactNode; icon?: React.ReactNode }) {
  if (!href) return <span className="button button-secondary button-disabled" aria-disabled="true">{icon}{children}</span>;
  return <a className="button button-secondary" href={href} target="_blank" rel="noreferrer">{icon}{children}</a>;
}

function ReleaseEditor({ release, onClose, onSaved }: { release?: DesktopRelease; onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const initial = asReleaseForm(release);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const payload: ReleaseFormState = {
      version: String(form.get("version") || ""),
      channel: String(form.get("channel") || "beta") as DesktopReleaseChannel,
      state: String(form.get("state") || "DRAFT") as DesktopReleaseState,
      notes: String(form.get("notes") || ""),
      setupUrl: String(form.get("setupUrl") || ""),
      portableUrl: String(form.get("portableUrl") || ""),
      checksumsUrl: String(form.get("checksumsUrl") || ""),
      isCurrent: form.get("isCurrent") === "on",
    };
    try {
      await adminFetch(release ? `/api/admin/releases/${release.id}` : "/api/admin/releases", {
        method: release ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Release tidak dapat disimpan.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminModal
      title={release ? "Edit desktop release" : "Tambah desktop release"}
      detail="Masukkan URL HTTPS publik dari GitHub Releases, Cloudflare R2, atau host biner Anda. Railway dan Vercel tidak menyimpan file EXE."
      onClose={onClose}
    >
      <form className="admin-form" onSubmit={submit}>
        <div className="form-grid">
          <label className="field-label">Versi<input name="version" required placeholder="1.11.0-beta.2" defaultValue={initial.version} /></label>
          <label className="field-label">Channel<select name="channel" defaultValue={initial.channel}>{desktopReleaseChannels.map((channel) => <option value={channel} key={channel}>{channel}</option>)}</select></label>
          <label className="field-label">Status<select name="state" defaultValue={initial.state}>{desktopReleaseStates.map((state) => <option value={state} key={state}>{releaseStateLabel(state)}</option>)}</select></label>
          <label className="check-row"><input name="isCurrent" type="checkbox" defaultChecked={initial.isCurrent} /> Jadikan release utama untuk user</label>
          <label className="field-label field-span-2">Catatan release<textarea name="notes" rows={5} placeholder="Satu perubahan per baris" defaultValue={initial.notes} /></label>
          <label className="field-label field-span-2">URL Setup Windows<input name="setupUrl" type="url" inputMode="url" placeholder="https://github.com/.../Cliper-Studio-Plus-Setup.exe" defaultValue={initial.setupUrl} /></label>
          <label className="field-label field-span-2">URL Portable Windows<input name="portableUrl" type="url" inputMode="url" placeholder="https://github.com/.../Cliper-Studio-Plus-Portable.exe" defaultValue={initial.portableUrl} /></label>
          <label className="field-label field-span-2">URL SHA-256<input name="checksumsUrl" type="url" inputMode="url" placeholder="https://github.com/.../SHA256SUMS.txt" defaultValue={initial.checksumsUrl} /></label>
        </div>
        <p className="release-editor-help">Release Published wajib memiliki minimal URL Setup atau Portable. Draft dan Archived tidak akan terlihat oleh user.</p>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Batal</button><button className="button button-primary" disabled={saving}><Save size={15} />{saving ? "Menyimpan..." : "Simpan release"}</button></div>
      </form>
    </AdminModal>
  );
}

export function AdminReleaseCatalog() {
  const [data, setData] = useState<DesktopReleaseCatalog | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<DesktopRelease | "new" | null>(null);
  const load = useCallback(() => {
    setError("");
    adminFetch<DesktopReleaseCatalog>("/api/admin/releases").then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : "Katalog release tidak dapat dimuat."));
  }, []);
  useEffect(load, [load]);

  if (error && !data) return <AdminError message={error} retry={load} />;
  if (!data) return <AdminLoading label="Memuat katalog release..." />;

  return <>
    {error && <AdminError message={error} retry={load} />}
    <section className="panel">
      <div className="panel-head admin-toolbar">
        <div>
          <p className="section-kicker">Release catalog</p>
          <h2>Cliper Studio builds</h2>
          <p>Kelola metadata dan tautan unduhan publik. Biner desktop tetap berada di GitHub Releases, R2, atau host unduhan terpisah.</p>
        </div>
        <button className="button button-primary" onClick={() => setEditing("new")}><Plus size={16} /> Tambah release</button>
      </div>
      {!data.releases.length ? <EmptyState title="Belum ada release" detail="Tambahkan draft, lalu isi URL Setup atau Portable dan publish saat binary sudah tersedia." /> : <div className="release-list admin-release-list">
        {data.releases.map((release) => <article key={release.id}>
          <div className="release-admin-summary">
            <div className="release-title-line"><strong>v{release.version}</strong><span className={stateClass(release.state)}>{releaseStateLabel(release.state)}</span>{release.isCurrent && <span className="status-pill release-current">Current</span>}</div>
            <span>{release.channel} · {release.publishedAt ? `Published ${formatDate(release.publishedAt)}` : `Updated ${formatDate(release.updatedAt)}`}</span>
            <small>{releaseHasDownload(release) ? "Asset download siap diperiksa." : "Belum ada asset publik; release tidak dapat dipublikasikan."}</small>
          </div>
          <div className="release-row-actions">
            <ReleaseLink href={release.setupUrl} icon={<Download size={15} />}>Setup</ReleaseLink>
            <ReleaseLink href={release.portableUrl} icon={<FileArchive size={15} />}>Portable</ReleaseLink>
            <button className="button button-secondary" onClick={() => setEditing(release)}><Pencil size={15} /> Edit</button>
          </div>
        </article>)}
      </div>}
    </section>
    {editing && <ReleaseEditor release={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
  </>;
}

export function MemberReleaseCatalog() {
  const [data, setData] = useState<DesktopReleaseCatalog | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    publicFetch<DesktopReleaseCatalog>("/api/releases").then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : "Katalog release tidak dapat dimuat."));
  }, []);
  useEffect(load, [load]);

  const current = useMemo(() => data?.releases.find((release) => release.isCurrent) || data?.releases[0] || null, [data]);
  if (error && !data) return <AdminError message={error} retry={load} />;
  if (!data) return <AdminLoading label="Memuat release desktop..." />;
  if (!current) return <section className="panel release-empty"><PackageCheck size={24} /><div><p className="section-kicker">Desktop app</p><h2>Release sedang disiapkan</h2><p>Build Windows akan muncul di sini setelah administrator menerbitkan tautan unduhan dan checksum-nya.</p></div></section>;

  return <>
    {error && <AdminError message={error} retry={load} />}
    <section className="panel release-hero">
      <div>
        <p className="section-kicker">Windows release</p>
        <h2>Cliper Studio Plus {current.version}</h2>
        <p>Gunakan installer untuk pemakaian normal atau versi portable untuk mencoba di PC lain. Semua biner diterbitkan bersama checksum.</p>
        <div className="release-badges"><span>{current.channel}</span><span>Windows 10/11</span><span>64-bit</span></div>
      </div>
      <div className="release-actions">
        <ReleaseLink href={current.setupUrl} icon={<Download size={17} />}>Download Setup</ReleaseLink>
        <ReleaseLink href={current.portableUrl} icon={<FileArchive size={17} />}>Portable</ReleaseLink>
      </div>
    </section>
    <div className="release-grid">
      <section className="panel">
        <div className="panel-head"><div><p className="section-kicker">What changed</p><h2>Release notes</h2></div></div>
        {current.notes.length ? <ul className="release-notes">{current.notes.map((note) => <li key={note}><CheckCircle2 size={17} /><span>{note}</span></li>)}</ul> : <p className="release-copy">Administrator belum menambahkan catatan untuk release ini.</p>}
      </section>
      <section className="panel">
        <div className="panel-head"><div><p className="section-kicker">Integrity</p><h2>Verify download</h2></div><ShieldCheck size={20} /></div>
        <p className="release-copy">Unduh checksum untuk memverifikasi file setelah selesai diunduh.</p>
        <ReleaseLink href={current.checksumsUrl} icon={<FileText size={15} />}>Download SHA256SUMS</ReleaseLink>
      </section>
    </div>
    <section className="panel">
      <div className="panel-head"><div><p className="section-kicker">Version history</p><h2>Daftar versi</h2></div><History size={20} /></div>
      <div className="release-list">
        {data.releases.map((release) => <article key={release.id}>
          <div><strong>v{release.version}</strong><span>{release.channel} · {release.publishedAt ? formatDate(release.publishedAt) : "Published"}</span></div>
          <span className={`status-pill ${release.isCurrent ? "release-current" : ""}`}>{release.isCurrent ? "Latest" : "Available"}</span>
        </article>)}
      </div>
    </section>
  </>;
}
