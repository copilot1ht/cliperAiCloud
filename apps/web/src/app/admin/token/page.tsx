import { AppShell } from "@/components/app-shell";

export default function AdminTokenPage() {
  return (
    <AppShell role="admin" eyebrow="Admin" title="Token">
      <section className="panel"><div className="panel-head"><div><p className="section-kicker">AI cost</p><h2>Token & provider cost</h2><p>Monitor biaya AI dan token usage per provider.</p></div></div>
        <div className="finance-grid"><span><small>Gemini</small><strong>Rp1.250.000</strong></span><span><small>DeepSeek</small><strong>Rp470.000</strong></span><span><small>GPT</small><strong>Rp130.000</strong></span><span><small>Total</small><strong>Rp1.850.000</strong></span></div>
      </section>
    </AppShell>
  );
}
