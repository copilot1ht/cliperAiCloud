"use client";

import { AlertCircle, Database, X } from "lucide-react";

export function LocalModeNotice() {
  return (
    <div className="notice-line admin-local-notice">
      <div><Database size={17} /><span><strong>Mode uji lokal.</strong> Perubahan aktif selama API berjalan dan akan dipindahkan ke PostgreSQL sebelum production.</span></div>
    </div>
  );
}

export function AdminLoading({ label = "Memuat data admin..." }: { label?: string }) {
  return <div className="admin-state"><span className="admin-spinner" /><strong>{label}</strong></div>;
}

export function AdminError({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="callout error-callout"><AlertCircle size={17} /><span><strong>Data tidak dapat dimuat.</strong> {message}</span>{retry && <button className="button button-secondary button-small" onClick={retry}>Coba lagi</button>}</div>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="admin-empty"><strong>{title}</strong><span>{detail}</span></div>;
}

export function AdminModal({ title, detail, onClose, children }: { title: string; detail?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="admin-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div><button className="icon-button" aria-label="Tutup" onClick={onClose}><X size={18} /></button></header>
        {children}
      </section>
    </div>
  );
}
