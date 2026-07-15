import { AppShell } from "@/components/app-shell";
import { MessageCircle, LifeBuoy, Zap } from "lucide-react";

export default function SupportPage() {
  return (
    <AppShell eyebrow="Support" title="Help center">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Need support?</p><h2>Ask our team</h2><p>Gunakan support untuk masalah setup API key, models, atau billing.</p></div></div>
        <div className="readiness-list"><span><i className="ready" /><strong>Live chat</strong><small>Hubungi kami jika ada error atau kebutuhan setting cepat.</small></span><span><i className="ready" /><strong>Setup guide</strong><small>Ikuti guide di halaman ini untuk menyambungkan Cliper Studio lokal.</small></span><span><i className="ready" /><strong>Server status</strong><small>Cek gateway, provider, dan routing health langsung.</small></span></div>
      </section>
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Quick links</p><h2>Panduan penggunaan</h2><p>Mulai dari install sampai integrasi API key dengan Cliper Studio.</p></div></div>
        <div className="finance-grid"><span><small>1</small><strong>Generate API key</strong></span><span><small>2</small><strong>Copy ke Cliper Studio</strong></span><span><small>3</small><strong>Atur provider</strong></span><span><small>4</small><strong>Jalankan render</strong></span></div>
      </section>
    </AppShell>
  );
}
