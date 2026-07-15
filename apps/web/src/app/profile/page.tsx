import { AppShell } from "@/components/app-shell";
import { ShieldCheck } from "lucide-react";

export default function ProfilePage() {
  return (
    <AppShell eyebrow="Profile" title="Your account">
      <section className="panel form-panel"><div className="panel-head"><div><p className="section-kicker">Account details</p><h2>Profile settings</h2><p>Kelola nama, email, dan keamanan akun kamu di satu tempat.</p></div></div>
        <div className="form-grid"><label className="field-label">Name<input defaultValue="Andra Irawan" /></label><label className="field-label">Email<input type="email" defaultValue="andra@cliper.ai" /></label><label className="field-label">Password<input type="password" defaultValue="••••••••" disabled /></label><label className="field-label">Account mode<input value="Wallet + usage credits" readOnly /></label></div>
      </section>
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Security</p><h2>Account protection</h2><p>Pastikan API key dan sesi desktop aman. Logout di perangkat lain jika perlu.</p></div></div>
        <div className="readiness-list"><span><i className="ready" /><strong>Two-factor</strong><small>Rekomendasi: aktifkan dua faktor bila sudah live.</small></span><span><i className="ready" /><strong>Provider key</strong><small>Disimpan server-side, tidak ditampilkan ke user.</small></span></div>
      </section>
    </AppShell>
  );
}
