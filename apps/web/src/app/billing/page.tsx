import { AppShell } from "@/components/app-shell";
import { BadgeDollarSign } from "lucide-react";

export default function BillingPage() {
  return (
    <AppShell eyebrow="Billing" title="Subscription plans">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">Plans</p><h2>Choose your package</h2><p>Lihat manfaat Starter, Pro, dan Business sesuai arsitektur lisensi.</p></div></div>
        <div className="plan-grid"><article className="plan-card"><h2>Starter</h2><strong>Rp99.000</strong><p>1 device · 50.000 token · 720p · Story AI Basic</p></article><article className="plan-card recommended"><h2>Pro</h2><strong>Rp299.000</strong><p>3 devices · 300.000 token · 4K Look · Gemini + DeepSeek + GPT</p></article></div>
      </section>
    </AppShell>
  );
}
