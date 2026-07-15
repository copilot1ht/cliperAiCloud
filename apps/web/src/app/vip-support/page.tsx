import { AppShell } from "@/components/app-shell";
import { Crown, Sparkles, ShieldCheck } from "lucide-react";

export default function VipSupportPage() {
  return (
    <AppShell eyebrow="VIP Support" title="VIP assistance">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Premium help</p><h2>Priority support</h2><p>Untuk tim dan pengguna aktif yang ingin bimbingan setup cepat.</p></div></div>
        <div className="readiness-list"><span><i className="ready" /><strong>Priority response</strong><small>Support diprioritaskan untuk tiket VIP.</small></span><span><i className="ready" /><strong>Custom onboarding</strong><small>Setting provider, keys, dan routing langsung.</small></span></div>
      </section>
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">What you get</p><h2>VIP features</h2><p>Lebih cepat, lebih banyak kontrol, dan bantuan tingkat lanjut.</p></div></div>
        <div className="finance-grid"><span><small>24/7</small><strong>Priority email</strong></span><span><small>3 hari</small><strong>Onboarding setup</strong></span><span><small>Custom</small><strong>Provider review</strong></span><span><small>Fast</small><strong>Response time</strong></span></div>
      </section>
    </AppShell>
  );
}
