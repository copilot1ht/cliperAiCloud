"use client";

import { Cloud, Eye, EyeOff, LockKeyhole, LogIn, UserPlus } from "lucide-react";
import { FormEvent, useState } from "react";
import { apiBase } from "@/lib/api-base";

type AuthMode = "login" | "register";

export function AuthLogin() {
  const [mode, setMode] = useState<AuthMode>("login");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    const data = new FormData(event.currentTarget);
    const apiUrl = apiBase();
    try {
      const response = await fetch(`${apiUrl}/api/auth/${mode === "login" ? "login" : "register"}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: String(data.get("displayName") || ""),
          email: String(data.get("email") || ""),
          password: String(data.get("password") || ""),
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.token) throw new Error(payload?.message || "Autentikasi gagal.");
      sessionStorage.setItem("cliper_role", payload.user.role);
      sessionStorage.setItem("cliper_user", JSON.stringify(payload.user));
      const redirectTarget = payload.redirectTo || (payload.user?.role === "admin" ? "/admin/overview" : "/dashboard");
      window.location.assign(redirectTarget);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Autentikasi gagal.");
    } finally {
      setLoading(false);
    }
  };

  const changeMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setMessage("");
  };

  return (
    <main className="auth-page">
      <section className="auth-brand">
        <span className="brand-mark auth-brand-mark"><Cloud size={24} strokeWidth={2.4} /></span>
        <span><strong>Cliper</strong><small>AI Cloud</small></span>
      </section>
      <section className="auth-panel">
        <div className="auth-tabs" aria-label="Pilihan autentikasi">
          <button className={mode === "login" ? "selected" : ""} onClick={() => changeMode("login")} type="button"><LogIn size={16} /> Masuk</button>
          <button className={mode === "register" ? "selected" : ""} onClick={() => changeMode("register")} type="button"><UserPlus size={16} /> Daftar</button>
        </div>
        <div className="auth-head">
          <span className="auth-role"><LockKeyhole size={18} /></span>
          <p className="section-kicker">Secure account access</p>
          <h1>{mode === "login" ? "Selamat datang kembali" : "Buat akun Cliper"}</h1>
          <p>{mode === "login" ? "Masuk untuk mengelola credits, license, dan penggunaan AI." : "Daftarkan akun untuk mulai menyiapkan Cliper Studio."}</p>
        </div>
        <form className="auth-form" onSubmit={submit}>
          {mode === "register" && <label>Nama lengkap<input name="displayName" autoComplete="name" required minLength={2} maxLength={80} placeholder="Nama Anda" /></label>}
          <label>Email<input name="email" type="email" autoComplete="email" required placeholder="you@company.com" /></label>
          <label>Password<span className="password-field"><input name="password" type={showPassword ? "text" : "password"} autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "login" ? 8 : 10} /><button type="button" className="icon-button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Sembunyikan password" : "Tampilkan password"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label>
          {mode === "login" && <div className="auth-options"><label><input type="checkbox" /> Ingat perangkat ini</label><button type="button" className="text-button">Lupa password?</button></div>}
          <button className="button button-primary auth-submit" type="submit" disabled={loading}>{loading ? "Memproses..." : mode === "login" ? "Masuk" : "Daftar sekarang"}</button>
          {message && <p className="auth-message" role="status">{message}</p>}
        </form>
        <footer className="auth-footer"><span className="status-tag fallback">Private alpha</span><span>Role ditentukan otomatis oleh server</span></footer>
      </section>
    </main>
  );
}
