"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Eye, EyeOff, KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { apiBase } from "@/lib/api-base";

export function PasswordReset() {
  const [token, setToken] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") || "");
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    const confirmation = String(form.get("confirmation") || "");
    if (password !== confirmation) {
      setMessage("Konfirmasi password belum sama.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch(`${apiBase()}/api/auth/password-reset/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Password belum dapat diubah.");
      window.location.assign("/login?reset=1");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Password belum dapat diubah.");
    } finally {
      setLoading(false);
    }
  };

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
            <p className="section-kicker">Secure password recovery</p>
            <h1>Buat password baru</h1>
            <p>Password baru akan mengakhiri sesi web dan desktop lama pada akun ini.</p>
          </div>
          {!token ? (
            <div className="auth-form"><p className="auth-message">Tautan pemulihan tidak lengkap atau sudah tidak valid.</p><Link className="button button-primary auth-submit" href="/login">Kembali ke masuk</Link></div>
          ) : (
            <form className="auth-form" onSubmit={submit} aria-busy={loading}>
              <label>
                Password baru
                <span className="auth-input-shell password-field"><LockKeyhole size={17} /><input name="password" type={showPassword ? "text" : "password"} autoComplete="new-password" required minLength={10} placeholder="Minimal 10 karakter" /><button type="button" className="icon-button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Sembunyikan password" : "Tampilkan password"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span>
              </label>
              <label>
                Konfirmasi password baru
                <span className="auth-input-shell"><LockKeyhole size={17} /><input name="confirmation" type={showPassword ? "text" : "password"} autoComplete="new-password" required minLength={10} placeholder="Ulangi password baru" /></span>
              </label>
              <button className="button button-primary auth-submit" type="submit" disabled={loading}><span>{loading ? "Memproses..." : "Simpan password baru"}</span>{!loading && <ArrowRight size={16} />}</button>
              {message && <p className="auth-message" role="status" aria-live="polite">{message}</p>}
            </form>
          )}
          <footer className="auth-footer"><ShieldCheck size={14} /><span>Recovery link berlaku satu kali selama 30 menit</span></footer>
        </section>
      </section>
    </main>
  );
}
