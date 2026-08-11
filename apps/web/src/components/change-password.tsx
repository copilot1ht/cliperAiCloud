"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Eye, EyeOff, KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { apiBase } from "@/lib/api-base";

type PageState = "checking" | "ready" | "expired" | "success";

export function ChangePassword() {
  const [state, setState] = useState<PageState>("checking");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [redirectTo, setRedirectTo] = useState("/dashboard");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiBase()}/api/auth/password-reset/session`, {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("expired");
        setState("ready");
      })
      .catch((error) => {
        if (error?.name !== "AbortError") setState("expired");
      });
    return () => controller.abort();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    const confirmation = String(form.get("confirmation") || "");
    if (password.length < 12 || password.length > 128 || !/\S/.test(password)) {
      setMessage("Password baru minimal 12 karakter dan maksimal 128 karakter.");
      return;
    }
    if (password !== confirmation) {
      setMessage("Konfirmasi password belum sama.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch(`${apiBase()}/api/auth/password-reset/change`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) setState("expired");
        throw new Error(payload?.message || "Password belum dapat diperbarui.");
      }
      if (payload?.user?.role) {
        sessionStorage.setItem("cliper_role", payload.user.role);
        sessionStorage.setItem("cliper_user", JSON.stringify(payload.user));
      }
      setRedirectTo(payload?.redirectTo || (payload?.user?.role === "member" ? "/dashboard" : "/admin/overview"));
      setState("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Password belum dapat diperbarui.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-page auth-page-single">
      <section className="auth-stage" aria-label="Ganti password Cliper AI Cloud">
        <div className="auth-brand auth-mobile-brand auth-single-brand">
          <span className="brand-mark auth-brand-mark"><Image src="/cliper-logo-mark.png" alt="Cliper AI Cloud" width={60} height={60} priority /></span>
          <span><strong>Cliper</strong><small>AI Cloud</small></span>
        </div>
        <section className="auth-panel">
          <div className="auth-head">
            <span className="auth-role"><KeyRound size={18} /></span>
            <p className="section-kicker">Secure password recovery</p>
            <h1>{state === "success" ? "Password berhasil diperbarui" : "Buat password baru"}</h1>
            <p>{state === "success" ? "Password baru Anda siap digunakan. Lanjutkan ke workspace untuk menyelesaikan pemulihan akun." : "Anda masuk menggunakan password sementara. Buat password baru sebelum melanjutkan."}</p>
          </div>
          {state === "checking" && <div className="auth-form"><p className="auth-message success" role="status">Memeriksa sesi reset...</p></div>}
          {state === "expired" && <div className="auth-form"><p className="auth-message">Sesi atau password sementara sudah berakhir. Hubungi admin untuk membuat password sementara yang baru.</p><Link className="button button-primary auth-submit" href="/login">Kembali ke masuk</Link></div>}
          {state === "success" && <div className="auth-form"><p className="auth-message success" role="status">Sesi lama telah dikeluarkan. Password sementara tidak dapat digunakan lagi.</p><button className="button button-primary auth-submit" onClick={() => window.location.assign(redirectTo)}>Lanjut ke workspace <ArrowRight size={16} /></button></div>}
          {state === "ready" && <form className="auth-form" onSubmit={submit} aria-busy={loading}>
            <label>
              Password baru
              <span className="auth-input-shell password-field"><LockKeyhole size={17} /><input name="password" type={showPassword ? "text" : "password"} autoComplete="new-password" required minLength={12} maxLength={128} placeholder="Minimal 12 karakter" /><button type="button" className="icon-button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Sembunyikan password" : "Tampilkan password"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span>
            </label>
            <label>
              Konfirmasi password baru
              <span className="auth-input-shell"><LockKeyhole size={17} /><input name="confirmation" type={showPassword ? "text" : "password"} autoComplete="new-password" required minLength={12} maxLength={128} placeholder="Ulangi password baru" /></span>
            </label>
            <p className="auth-field-hint">Gunakan minimal 12 karakter. Password ini tidak disimpan di browser.</p>
            <button className="button button-primary auth-submit" type="submit" disabled={loading}><span>{loading ? "Menyimpan..." : "Simpan password baru"}</span>{!loading && <ArrowRight size={16} />}</button>
            {message && <p className="auth-message" role="status" aria-live="polite">{message}</p>}
          </form>}
          <footer className="auth-footer"><ShieldCheck size={14} /><span>Reset session hanya dapat digunakan untuk membuat password baru</span></footer>
        </section>
      </section>
    </main>
  );
}
