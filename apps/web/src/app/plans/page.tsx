import { AppShell } from "@/components/app-shell";
import { Check, ShieldCheck } from "lucide-react";

const plans = [
  {
    code: "STARTER",
    name: "Starter",
    price: "Rp99.000",
    credits: "1.000 Cliper Credits",
    description: "Untuk creator yang mulai memakai AI clipping secara rutin.",
    items: ["DeepSeek primary routing", "Gemini Flash fallback", "1 desktop device", "Standard request priority"],
  },
  {
    code: "PRO",
    name: "Pro",
    price: "Rp299.000",
    credits: "5.000 Cliper Credits",
    description: "Routing kualitas tinggi untuk produksi video yang lebih sering.",
    items: ["Gemini + DeepSeek routing", "Premium model eligible", "2 desktop devices", "Higher request priority"],
    recommended: true,
  },
  {
    code: "ENTERPRISE",
    name: "Enterprise",
    price: "Custom",
    credits: "Custom credit pool",
    description: "Kontrol, quota, dan support khusus untuk tim atau volume besar.",
    items: ["Custom provider policy", "Team device management", "Usage export and audit", "Priority support"],
  },
];

export default function PlansPage() {
  return (
    <AppShell eyebrow="Subscription" title="Plans & credits">
      <div className="notice-line"><div><ShieldCheck size={17} /><span><strong>Draft commercial plans.</strong> Harga dan jumlah credits wajib divalidasi dari biaya provider nyata sebelum paid beta.</span></div></div>
      <section className="plan-grid">
        {plans.map((plan) => (
          <article className={plan.recommended ? "plan-card recommended" : "plan-card"} key={plan.code}>
            <div className="plan-head"><span>{plan.code}</span>{plan.recommended && <b>Recommended</b>}</div>
            <h2>{plan.name}</h2>
            <strong className="plan-price">{plan.price}<small>{plan.price !== "Custom" ? " / month" : ""}</small></strong>
            <p>{plan.description}</p>
            <div className="plan-credit">{plan.credits}</div>
            <ul>{plan.items.map((item) => <li key={item}><Check size={15} />{item}</li>)}</ul>
            <button className={plan.recommended ? "button button-primary" : "button button-secondary"} disabled>Billing pending</button>
          </article>
        ))}
      </section>
      <p className="fine-print">Cliper Credits adalah service credits, bukan raw provider tokens. Debit dihitung dari biaya provider, compute, fee, reserve, dan markup yang tersimpan pada pricing snapshot.</p>
    </AppShell>
  );
}
