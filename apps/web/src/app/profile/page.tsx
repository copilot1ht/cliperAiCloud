"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { apiBase } from "@/lib/api-base";

interface AccountSession {
  email: string;
  displayName: string;
  role: "admin" | "investor" | "member";
}

export default function ProfilePage() {
  const [account, setAccount] = useState<AccountSession | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiBase()}/api/auth/session`, {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.message || "Profil tidak dapat dimuat.");
        setAccount(payload);
      })
      .catch((reason) => {
        if (reason?.name !== "AbortError") {
          setError(reason instanceof Error ? reason.message : "Profil tidak dapat dimuat.");
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <AppShell eyebrow="Profile" title="Your account">
      <section className="panel form-panel">
        <div className="panel-head"><div><p className="section-kicker">Account details</p><h2>Profile settings</h2><p>Nama dan email diambil dari akun saat pendaftaran.</p></div></div>
        {error && <p className="form-error">{error}</p>}
        {!account && !error && <div className="admin-loading"><span /> Memuat profil...</div>}
        {account && <div className="form-grid">
          <label className="field-label">Name<input value={account.displayName} readOnly /></label>
          <label className="field-label">Email<input type="email" value={account.email} readOnly /></label>
          <label className="field-label">Role<input value={account.role === "admin" ? "Administrator" : account.role === "investor" ? "Investor (read only)" : "Member"} readOnly /></label>
          <label className="field-label">Account mode<input value="Wallet + usage credits" readOnly /></label>
        </div>}
      </section>
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Security</p><h2>Account protection</h2><p>Provider key tetap dikelola server dan tidak disimpan di browser.</p></div></div>
        <div className="readiness-list"><span><i className="ready" /><strong>Session protected</strong><small>Gunakan Sign out setelah selesai memakai perangkat bersama.</small></span><span><i className="ready" /><strong>Cliper API key</strong><small>Key desktop dapat dicabut dari halaman API Keys.</small></span></div>
      </section>
    </AppShell>
  );
}
