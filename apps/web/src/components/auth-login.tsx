"use client";

import Image from "next/image";
import { ArrowRight, BrainCircuit, CloudCog, Eye, EyeOff, KeyRound, Layers3, LockKeyhole, LogIn, Mail, MonitorSmartphone, ShieldCheck, User, UserPlus, WalletCards } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { apiBase } from "@/lib/api-base";

type AuthMode = "login" | "register" | "forgot";

export function AuthLogin() {
  const [mode, setMode] = useState<AuthMode>("login");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"error" | "success">("error");
  const [email, setEmail] = useState("");
  const [rememberEmail, setRememberEmail] = useState(false);

  useEffect(() => {
    const remembered = window.localStorage.getItem("cliper_login_email") || "";
    if (remembered) {
      setEmail(remembered);
      setRememberEmail(true);
    }
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    setMessageTone("error");
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
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Autentikasi gagal.");
      if (payload?.authState === "PASSWORD_RESET_REQUIRED") {
        window.location.assign("/change-password");
        return;
      }
      if (!payload?.token) throw new Error("Autentikasi gagal.");
      if (mode === "login" && rememberEmail) window.localStorage.setItem("cliper_login_email", String(data.get("email") || ""));
      else window.localStorage.removeItem("cliper_login_email");
      sessionStorage.setItem("cliper_role", payload.user.role);
      sessionStorage.setItem("cliper_user", JSON.stringify(payload.user));
      const redirectTarget = payload.redirectTo || (payload.user?.role === "member" ? "/dashboard" : "/admin/overview");
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
    setMessageTone("error");
    setShowPassword(false);
  };

  const explainPasswordRecovery = () => {
    changeMode("forgot");
  };

  return (
    <main className="auth-page">
      <div className="auth-ambient" aria-hidden="true">
        <span className="auth-line auth-line-one" />
        <span className="auth-line auth-line-two" />
        <span className="auth-line auth-line-three" />
      </div>
      <section className="auth-visual" aria-label="Cliper AI Cloud">
        <div className="auth-brand auth-brand-large">
          <span className="brand-mark auth-brand-mark"><Image src="/cliper-logo-mark.png" alt="Cliper AI Cloud" width={68} height={68} priority /></span>
          <span><strong>Cliper</strong><small>AI Cloud</small></span>
        </div>
        <div className="auth-visual-copy">
          <p className="auth-overline">Cloud infrastructure for Cliper Studio</p>
          <h1>Satu koneksi aman untuk seluruh workflow AI Anda.</h1>
          <p>Kelola akses desktop, routing AI, credits, dan penggunaan dari satu workspace yang terukur.</p>
          <div className="auth-signal-row" aria-label="Keamanan dan layanan">
            <span><ShieldCheck size={15} /> Server secured</span>
            <span><KeyRound size={15} /> Scoped access</span>
            <span><CloudCog size={15} /> Smart routing</span>
          </div>
        </div>
        <div className="auth-cloud-scene" aria-hidden="true">
          <span className="auth-cloud-core"><Image src="/cliper-logo-mark.png" alt="" width={104} height={104} /></span>
          <span className="auth-cloud-node auth-node-source"><Layers3 size={18} /><b>Cliper Studio</b><small>Desktop source</small></span>
          <span className="auth-cloud-node auth-node-ai"><BrainCircuit size={18} /><b>AI Router</b><small>Task based</small></span>
          <span className="auth-cloud-node auth-node-key"><KeyRound size={18} /><b>API Access</b><small>Device bound</small></span>
          <span className="auth-cloud-node auth-node-wallet"><WalletCards size={18} /><b>Cloud Credits</b><small>Usage tracked</small></span>
          <span className="auth-cloud-node auth-node-device"><MonitorSmartphone size={18} /><b>Connected</b><small>Live session</small></span>
          <i className="auth-connector connector-one" />
          <i className="auth-connector connector-two" />
          <i className="auth-connector connector-three" />
          <i className="auth-connector connector-four" />
          <i className="auth-connector connector-five" />
        </div>
        <footer className="auth-visual-footer">
          <span>Cliper Studio</span><i /><span>AI Gateway</span><i /><span>Secure Billing</span>
        </footer>
      </section>
      <section className="auth-stage" aria-label="Cliper AI Cloud authentication">
        <div className="auth-brand auth-mobile-brand">
          <span className="brand-mark auth-brand-mark"><Image src="/cliper-logo-mark.png" alt="Cliper AI Cloud" width={60} height={60} priority /></span>
          <span><strong>Cliper</strong><small>AI Cloud</small></span>
        </div>
        <section className="auth-panel">
          <div className="auth-tabs" aria-label="Pilihan autentikasi">
            <button className={mode === "login" || mode === "forgot" ? "selected" : ""} onClick={() => changeMode("login")} type="button"><LogIn size={16} /> Masuk</button>
            <button className={mode === "register" ? "selected" : ""} onClick={() => changeMode("register")} type="button"><UserPlus size={16} /> Daftar</button>
          </div>
          <div className="auth-head">
            <span className="auth-role"><LockKeyhole size={18} /></span>
            <p className="section-kicker">Secure account access</p>
            <h1>{mode === "login" ? "Welcome to Cliper AI Cloud" : mode === "register" ? "Create your Cliper account" : "Pulihkan password Anda"}</h1>
            <p>{mode === "login" ? "Secure access to your AI workspace." : mode === "register" ? "Mulai kelola API key, credits, dan penggunaan Cliper Studio." : "Pemulihan password saat ini dilakukan melalui bantuan admin."}</p>
          </div>
          {mode === "forgot" ? <div className="auth-form auth-recovery-info">
            <ol>
              <li>Hubungi admin atau support Cliper.</li>
              <li>Berikan email akun Anda.</li>
              <li>Gunakan password sementara yang diberikan untuk masuk.</li>
              <li>Buat password baru sebelum melanjutkan ke workspace.</li>
            </ol>
            <button type="button" className="button button-primary auth-submit" onClick={() => changeMode("login")}>Kembali ke masuk</button>
          </div> : <form className="auth-form" onSubmit={submit} aria-busy={loading}>
            {mode === "register" && (
              <label>
                Nama lengkap
                <span className="auth-input-shell"><User size={17} /><input name="displayName" autoComplete="name" required minLength={2} maxLength={80} placeholder="Nama Anda" /></span>
              </label>
            )}
            <label>
              Email
              <span className="auth-input-shell"><Mail size={17} /><input name="email" type="email" autoComplete="username" required placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} /></span>
            </label>
            <label>
              Password
              <span className="auth-input-shell password-field"><LockKeyhole size={17} /><input name="password" type={showPassword ? "text" : "password"} autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "login" ? 1 : 12} maxLength={128} placeholder={mode === "login" ? "Masukkan password" : "Minimal 12 karakter"} /><button type="button" className="icon-button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Sembunyikan password" : "Tampilkan password"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span>
            </label>
            {mode === "login" && (
              <div className="auth-options">
                <label><input type="checkbox" checked={rememberEmail} onChange={(event) => setRememberEmail(event.target.checked)} /> Ingat email</label>
                <button type="button" className="auth-text-button" onClick={explainPasswordRecovery}>Lupa password?</button>
              </div>
            )}
            <button className="button button-primary auth-submit" type="submit" disabled={loading}><span>{loading ? "Memproses..." : mode === "login" ? "Masuk" : "Daftar sekarang"}</span>{!loading && <ArrowRight size={16} />}</button>
            {message && <p className={`auth-message ${messageTone === "success" ? "success" : ""}`} role="status" aria-live="polite">{message}</p>}
          </form>}
          <footer className="auth-footer"><ShieldCheck size={14} /><span>Role dan akses ditentukan aman oleh server</span></footer>
        </section>
        <footer className="auth-page-footer">
          <strong>Protected by Cliper AI Cloud</strong>
          <span>Secure <i /> Encrypted <i /> Device Bound</span>
        </footer>
      </section>
    </main>
  );
}
