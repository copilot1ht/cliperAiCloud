"use client";

import Image from "next/image";
import Link from "next/link";
import { KeyRound, ShieldCheck } from "lucide-react";

// Kept as a friendly destination for older email links. The active production
// policy is admin-assisted recovery, so this route deliberately has no email
// form and does not pretend a reset link can still be used.
export function PasswordReset() {
  return (
    <main className="auth-page auth-page-single">
      <section className="auth-stage" aria-label="Pemulihan password Cliper AI Cloud">
        <div className="auth-brand auth-mobile-brand auth-single-brand">
          <span className="brand-mark auth-brand-mark"><Image src="/cliper-logo-mark.png" alt="Cliper AI Cloud" width={60} height={60} priority /></span>
          <span><strong>Cliper</strong><small>AI Cloud</small></span>
        </div>
        <section className="auth-panel">
          <div className="auth-head">
            <span className="auth-role"><KeyRound size={18} /></span>
            <p className="section-kicker">Password recovery</p>
            <h1>Butuh bantuan password?</h1>
            <p>Pemulihan password saat ini dilakukan melalui bantuan admin.</p>
          </div>
          <div className="auth-form auth-recovery-info">
            <ol>
              <li>Hubungi admin atau support Cliper.</li>
              <li>Berikan email akun Anda.</li>
              <li>Masuk menggunakan password sementara yang diberikan.</li>
              <li>Buat password baru pada layar berikutnya.</li>
            </ol>
            <Link className="button button-primary auth-submit" href="/login">Kembali ke masuk</Link>
          </div>
          <footer className="auth-footer"><ShieldCheck size={14} /><span>Password sementara hanya berlaku terbatas dan harus segera diganti</span></footer>
        </section>
      </section>
    </main>
  );
}
